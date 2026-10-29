"""Stop one pinned DEV supervisor after a bounded failed-admission proof.

The proof distinguishes native startup, API binding failure with a retained
historical failed owner, the explicit pre-marker activation-parent failure,
and failure after READY with a ready identity pin. None of these observations
releases resources or rewrites owner state.
"""
import argparse
import hashlib
import json
from collections.abc import Mapping
from pathlib import Path
import re
import sys

import fullmag_storage as storage
from docker_build_control import BuildControl, BuildControlError, docker_capture
from docker_compose_identity import compose_project_identity, validate_source_labels


CANONICAL_PROCESS_RECEIPT = "/opt/fullmag/runtime-control/runtime-service/process-tree.json"
CANONICAL_HOST_LEDGER_ROOT = "/host-ledger/ledger"
NATIVE_FAILURE_PROBE_SCHEMA = "fullmag.docker-native-start-failure-stop-probe.v1"
NATIVE_AFTER_READY_FAILURE_PROBE_SCHEMA = (
    "fullmag.docker-native-after-ready-failure-stop-probe.v1"
)
API_START_FAILURE_MODE = "api-start-failure"
API_START_FAILURE_ERROR_PREFIX = "API binding did not become ready:"


def _validate_native_failed_owner(
    owner: object, *, allowed_child_statuses: frozenset[str] | None = None
) -> dict[str, object]:
    """Validate the terminal native owner shape at the operator boundary."""

    if allowed_child_statuses is None:
        allowed_child_statuses = frozenset({"exited_success"})

    if not isinstance(owner, Mapping):
        raise BuildControlError("native failed owner is not an object")
    if owner.get("schema_version") != "runtime_service_owner.v1":
        raise BuildControlError("native failed owner schema differs")
    if owner.get("protocol") != "stdin-v1" or owner.get("state") != "failed":
        raise BuildControlError("native owner is not the expected failed owner")
    if owner.get("target_id") != "docker-all":
        raise BuildControlError("native failed owner targets another service")
    for field in ("owner_token", "process_start_token", "host", "control_address", "acquired_at", "heartbeat_at"):
        if not isinstance(owner.get(field), str) or not owner[field]:
            raise BuildControlError(f"native failed owner has no {field}")
    if not isinstance(owner.get("build_commit"), str) or re.fullmatch(r"[0-9a-f]{40}", owner["build_commit"]) is None:
        raise BuildControlError("native failed owner has an invalid build commit")
    if not isinstance(owner.get("build_snapshot"), str) or re.fullmatch(r"[0-9a-f]{64}", owner["build_snapshot"]) is None:
        raise BuildControlError("native failed owner has an invalid build snapshot")
    for field in ("compute_pool_generation", "preparation_pool_generation"):
        if type(owner.get(field)) is not int or owner[field] <= 0:
            raise BuildControlError(f"native failed owner has an invalid {field}")
    for field in ("compute_pool_id", "preparation_pool_id"):
        if not isinstance(owner.get(field), str) or not owner[field]:
            raise BuildControlError(f"native failed owner has no {field}")
    if owner["compute_pool_id"] == owner["preparation_pool_id"]:
        raise BuildControlError("native failed owner reuses one scheduler pool")
    if type(owner.get("pid")) is not int or owner["pid"] <= 0:
        raise BuildControlError("native failed owner has an invalid pid")
    children = owner.get("children")
    if not isinstance(children, list) or len(children) != 2:
        raise BuildControlError("native failed owner does not have exactly two children")
    roles: set[object] = set()
    pids: set[int] = set()
    for child in children:
        if not isinstance(child, Mapping):
            raise BuildControlError("native failed owner has an invalid child")
        role = child.get("role")
        pid = child.get("pid")
        status = child.get("status")
        if role not in {"compute", "preparation"} or role in roles:
            raise BuildControlError("native failed owner has an unexpected child role set")
        if type(pid) is not int or pid <= 0 or pid in pids:
            raise BuildControlError("native failed owner has an invalid child pid")
        if status not in allowed_child_statuses:
            raise BuildControlError("native failed owner has a live or unknown child")
        roles.add(role)
        pids.add(pid)
    if roles != {"compute", "preparation"}:
        raise BuildControlError("native failed owner is missing compute or preparation")
    return dict(owner)


def _owner_identity_key(owner: Mapping[str, object], label: str) -> tuple[object, ...]:
    """Return the immutable owner/child identity, excluding state and status."""

    children = owner.get("children")
    if not isinstance(children, list):
        raise BuildControlError(f"{label} has no scheduler child identity")
    child_identity: list[tuple[object, object]] = []
    for child in children:
        if not isinstance(child, Mapping):
            raise BuildControlError(f"{label} has an invalid scheduler child")
        child_identity.append((child.get("role"), child.get("pid")))
    child_identity.sort(key=lambda item: (str(item[0]), str(item[1])))
    return (
        tuple(owner.get(field) for field in (
            "owner_token", "process_start_token", "pid", "host", "target_id",
            "control_address", "build_commit", "build_snapshot", "compute_pool_id",
            "preparation_pool_id", "compute_pool_generation", "preparation_pool_generation",
        )),
        tuple(child_identity),
    )


def _validate_native_ready_owner(owner: object) -> dict[str, object]:
    """Validate the retained ready owner used only as an identity pin."""

    if not isinstance(owner, Mapping):
        raise BuildControlError("retained ready owner is not an object")
    if owner.get("schema_version") != "runtime_service_owner.v1":
        raise BuildControlError("retained ready owner schema differs")
    if owner.get("protocol") != "stdin-v1" or owner.get("state") != "ready":
        raise BuildControlError("retained ready owner is not ready")
    if owner.get("target_id") != "docker-all":
        raise BuildControlError("retained ready owner targets another service")
    for field in (
        "owner_token", "process_start_token", "host", "control_address",
        "acquired_at", "heartbeat_at",
    ):
        if not isinstance(owner.get(field), str) or not owner[field]:
            raise BuildControlError(f"retained ready owner has no {field}")
    for field, pattern in (("build_commit", r"[0-9a-f]{40}"), ("build_snapshot", r"[0-9a-f]{64}")):
        if not isinstance(owner.get(field), str) or re.fullmatch(pattern, owner[field]) is None:
            raise BuildControlError(f"retained ready owner has an invalid {field}")
    for field in ("compute_pool_generation", "preparation_pool_generation"):
        if type(owner.get(field)) is not int or owner[field] <= 0:
            raise BuildControlError(f"retained ready owner has an invalid {field}")
    for field in ("compute_pool_id", "preparation_pool_id"):
        if not isinstance(owner.get(field), str) or not owner[field]:
            raise BuildControlError(f"retained ready owner has no {field}")
    if owner["compute_pool_id"] == owner["preparation_pool_id"]:
        raise BuildControlError("retained ready owner reuses one scheduler pool")
    if type(owner.get("pid")) is not int or owner["pid"] <= 0:
        raise BuildControlError("retained ready owner has an invalid pid")
    children = owner.get("children")
    if not isinstance(children, list) or len(children) != 2:
        raise BuildControlError("retained ready owner does not have exactly two children")
    roles: set[object] = set()
    pids: set[int] = set()
    for child in children:
        if not isinstance(child, Mapping):
            raise BuildControlError("retained ready owner has an invalid child")
        role = child.get("role")
        pid = child.get("pid")
        if role not in {"compute", "preparation"} or role in roles:
            raise BuildControlError("retained ready owner has an unexpected child role set")
        if type(pid) is not int or pid <= 0 or pid in pids:
            raise BuildControlError("retained ready owner has an invalid child pid")
        if child.get("status") != "running":
            raise BuildControlError("retained ready owner has a non-running child")
        roles.add(role)
        pids.add(pid)
    if roles != {"compute", "preparation"}:
        raise BuildControlError("retained ready owner is missing compute or preparation")
    return dict(owner)


def _validate_native_failure_probe(
    probe: Mapping[str, object],
    expected_process_receipt_sha256: str,
    *,
    api_start_failure: bool = False,
) -> dict[str, object]:
    """Validate the bounded in-container proof before stopping PID 1."""

    failure_mode = probe.get("failure_mode")
    if api_start_failure:
        if failure_mode != API_START_FAILURE_MODE:
            raise BuildControlError("API-start failure probe has no exact failure mode")
    elif failure_mode is not None:
        raise BuildControlError("native start-failure probe has an unexpected failure mode")
    if probe.get("schema") != NATIVE_FAILURE_PROBE_SCHEMA:
        raise BuildControlError("native failure probe schema differs")
    if probe.get("process_receipt_sha256") != expected_process_receipt_sha256:
        raise BuildControlError("native failure process receipt digest differs")
    receipt = probe.get("process_receipt")
    if not isinstance(receipt, Mapping):
        raise BuildControlError("native failure probe has no process receipt")
    if receipt.get("schema") != "fullmag.docker-process-tree.v1":
        raise BuildControlError("native failure process receipt schema differs")
    if receipt.get("state") != "failed_outcome_retained":
        raise BuildControlError("native failure process receipt is not retained")
    if type(receipt.get("api_exit_code")) is not int:
        raise BuildControlError("native failure API exit was not durably recorded")
    if not isinstance(receipt.get("error"), str) or not receipt["error"]:
        raise BuildControlError("native failure has no bounded error detail")
    if api_start_failure and not receipt["error"].startswith(API_START_FAILURE_ERROR_PREFIX):
        raise BuildControlError("API-start failure receipt has no API binding error prefix")
    if receipt.get("runtime_pid") is not None:
        raise BuildControlError("native failure still has a runtime pid")
    api_pid = receipt.get("api_pid")
    if type(api_pid) is not int or api_pid <= 0:
        raise BuildControlError("native failure API pid is not a positive integer")
    if "service_owner" in receipt or "terminal_service_owner" in receipt:
        raise BuildControlError("native failure receipt already contains an owner transition")
    if probe.get("api_pid_exists") is not False:
        raise BuildControlError("native failure API process is still live")
    if probe.get("native_processes_live") is not False:
        raise BuildControlError("native failed owner or child is still live")
    if api_start_failure and (
        probe.get("owner_pid_exists") is not False
        or probe.get("child_pids_exist") is not False
    ):
        raise BuildControlError("API-start failure has a live owner or child process")
    if probe.get("startup_enabled") == "1" or probe.get("legacy_activation_marker_exists") is True:
        raise BuildControlError("internal startup activation is outside the native failure route")
    owner = _validate_native_failed_owner(
        probe.get("failed_owner"),
        allowed_child_statuses=(
            frozenset({"exited_success", "exited_failure"})
            if api_start_failure else None
        ),
    )
    if type(probe.get("active_lease_count")) is not int or probe.get("active_lease_count") != 0:
        raise BuildControlError("native failure still has an active durable resource lease")
    reservation_states = probe.get("reservation_states")
    if not isinstance(reservation_states, list) or any(state != "released" for state in reservation_states):
        raise BuildControlError("native failure host ledger is not fully released")
    lease_states = probe.get("lease_states")
    if not isinstance(lease_states, list) or any(state != "released" for state in lease_states):
        raise BuildControlError("native failure session leases are not fully released")
    return {"receipt": dict(receipt), "failed_owner": owner, "probe": dict(probe)}


def _validate_native_after_ready_failure_probe(
    probe: Mapping[str, object], expected_process_receipt_sha256: str
) -> dict[str, object]:
    """Validate a failed owner observed after a previously ready runtime.

    The retained ``service_owner`` is an identity pin only.  It never proves
    that the native service is still ready and is never converted to a drained
    owner by this command.
    """

    if probe.get("failure_mode") is not None:
        raise BuildControlError("after-ready native failure probe has an unexpected failure mode")
    if probe.get("schema") != NATIVE_AFTER_READY_FAILURE_PROBE_SCHEMA:
        raise BuildControlError("after-ready native failure probe schema differs")
    if probe.get("process_receipt_sha256") != expected_process_receipt_sha256:
        raise BuildControlError("after-ready process receipt digest differs")
    receipt = probe.get("process_receipt")
    if not isinstance(receipt, Mapping):
        raise BuildControlError("after-ready native failure probe has no process receipt")
    if receipt.get("schema") != "fullmag.docker-process-tree.v1":
        raise BuildControlError("after-ready process receipt schema differs")
    if receipt.get("state") != "failed_outcome_retained":
        raise BuildControlError("after-ready process receipt is not retained")
    if type(receipt.get("api_exit_code")) is not int:
        raise BuildControlError("after-ready API exit was not durably recorded")
    if not isinstance(receipt.get("error"), str) or not receipt["error"]:
        raise BuildControlError("after-ready failure has no bounded error detail")
    if receipt.get("runtime_pid") is not None:
        raise BuildControlError("after-ready failure still has a runtime pid")
    api_pid = receipt.get("api_pid")
    if type(api_pid) is not int or api_pid <= 0:
        raise BuildControlError("after-ready API pid is not a positive integer")
    ready_owner = _validate_native_ready_owner(receipt.get("service_owner"))
    if "terminal_service_owner" in receipt:
        raise BuildControlError("after-ready receipt already contains an owner transition")
    failed_owner = _validate_native_failed_owner(
        probe.get("failed_owner"),
        allowed_child_statuses=frozenset({"exited_success", "exited_failure"}),
    )
    if _owner_identity_key(ready_owner, "retained ready owner") != _owner_identity_key(
        failed_owner, "failed owner"
    ):
        raise BuildControlError("after-ready failed owner differs from retained ready owner")
    if probe.get("api_pid_exists") is not False:
        raise BuildControlError("after-ready API process is still live")
    if probe.get("owner_pid_exists") is not False or probe.get("child_pids_exist") is not False:
        raise BuildControlError("after-ready native owner or child process is still live")
    if probe.get("native_processes_live") is not False:
        raise BuildControlError("after-ready native worker process is still live")
    if probe.get("startup_enabled") == "1" or probe.get("legacy_activation_marker_exists") is True:
        raise BuildControlError("internal startup activation is outside the after-ready failure route")
    if type(probe.get("active_lease_count")) is not int or probe.get("active_lease_count") != 0:
        raise BuildControlError("after-ready failure still has an active durable resource lease")
    reservation_states = probe.get("reservation_states")
    if not isinstance(reservation_states, list) or any(state != "released" for state in reservation_states):
        raise BuildControlError("after-ready host ledger is not fully released")
    lease_states = probe.get("lease_states")
    if not isinstance(lease_states, list) or any(state != "released" for state in lease_states):
        raise BuildControlError("after-ready session leases are not fully released")
    return {
        "receipt": dict(receipt),
        "ready_owner": dict(ready_owner),
        "failed_owner": failed_owner,
        "probe": dict(probe),
    }


def _native_failure_probe_script() -> str:
    """Return the image-owned read-only proof for a terminal native startup failure."""

    return r'''import fcntl, hashlib, json, os, pathlib, stat, time
MAX=8*1024*1024
MAX_ENTRIES=8192
CANONICAL_RECEIPT='/opt/fullmag/runtime-control/runtime-service/process-tree.json'
CANONICAL_LEDGER='/host-ledger/ledger'

def read_regular(path, label, maximum=MAX):
    path=pathlib.Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise RuntimeError(label+' path is unsafe')
    fd=os.open(path, os.O_RDONLY|getattr(os,'O_NOFOLLOW',0))
    try:
        st=os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size>maximum:
            raise RuntimeError(label+' is not a bounded regular file')
        data=os.read(fd, maximum+1)
        if len(data)>maximum:
            raise RuntimeError(label+' exceeds bound')
        return data
    finally:
        os.close(fd)

def read_json(path, label):
    try:
        value=json.loads(read_regular(path,label).decode('utf-8'))
    except (UnicodeDecodeError,json.JSONDecodeError) as error:
        raise RuntimeError(label+' is invalid JSON') from error
    if not isinstance(value,dict):
        raise RuntimeError(label+' is not an object')
    return value

def lock_file(path, label):
    path=pathlib.Path(path)
    if not path.is_file() or path.is_symlink():
        raise RuntimeError(label+' is missing')
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
                time.sleep(.05)
            except OSError as error:
                raise RuntimeError(label+' lock outcome is unknown') from error
    except Exception:
        os.close(fd)
        raise

def scan_ledger():
    if os.environ.get('FULLMAG_HOST_LEDGER_ROOT', CANONICAL_LEDGER) != CANONICAL_LEDGER:
        raise RuntimeError('host ledger root override differs from the canonical mount')
    root=pathlib.Path(CANONICAL_LEDGER)
    fd=lock_file(root/'WRITER.lock','host ledger writer lock')
    try:
        document=read_json(root/'HOST_RESOURCE_LEDGER.json','host resource ledger')
        rows=document.get('reservations')
        if not isinstance(rows,list):
            raise RuntimeError('host ledger reservations are missing')
        states=[]
        for row in rows:
            if not isinstance(row,dict) or not isinstance(row.get('state'),str):
                raise RuntimeError('host ledger reservation is invalid')
            states.append(row['state'])
        return states
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)

def scan_leases(store):
    root=pathlib.Path(store)
    fd=lock_file(root/'WRITER.lock','accepted-store writer lock')
    try:
        runs=root/'runs'
        if not runs.is_dir() or runs.is_symlink():
            raise RuntimeError('accepted store runs directory is missing')
        states=[]
        entries=0
        for run in os.scandir(runs):
            if run.is_symlink() or not run.is_dir(follow_symlinks=False):
                raise RuntimeError('accepted store has an invalid run entry')
            for directory_name in ('resource_leases','preparation_resource_leases'):
                lease_root=pathlib.Path(run.path)/directory_name
                if not os.path.lexists(lease_root):
                    continue
                if lease_root.is_symlink() or not lease_root.is_dir():
                    raise RuntimeError('accepted store lease root is invalid')
                for resource in os.scandir(lease_root):
                    if resource.is_symlink() or not resource.is_dir(follow_symlinks=False):
                        raise RuntimeError('accepted store lease resource entry is invalid')
                    for entry in os.scandir(resource.path):
                        entries += 1
                        if entries > MAX_ENTRIES:
                            raise RuntimeError('accepted store lease inventory is unbounded')
                        if entry.is_symlink() or not entry.is_file(follow_symlinks=False) or not entry.name.endswith('.json'):
                            raise RuntimeError('accepted store lease record is invalid')
                        record=read_json(entry.path,'accepted store lease record')
                        state=record.get('state')
                        if state not in {'released','active'}:
                            raise RuntimeError('accepted store lease state is unknown')
                        states.append(state)
        return states
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)

if os.environ.get('FULLMAG_RUNTIME_PROCESS_RECEIPT', CANONICAL_RECEIPT) != CANONICAL_RECEIPT:
    raise RuntimeError('runtime process receipt override differs from the canonical path')
import sys
sys.path.insert(0,'/opt/fullmag')
import runtime_service
paths=runtime_service.canonical_paths()
receipt_path=runtime_service.process_receipt_path(paths)
if str(receipt_path) != CANONICAL_RECEIPT:
    raise RuntimeError('runtime service returned a noncanonical process receipt path')
receipt_raw=read_regular(receipt_path,'runtime process receipt')
receipt=read_json(receipt_path,'runtime process receipt')
if receipt.get('schema')!='fullmag.docker-process-tree.v1' or receipt.get('state')!='failed_outcome_retained':
    raise RuntimeError('runtime process receipt is not a retained native failure')
if type(receipt.get('api_exit_code')) is not int or receipt.get('runtime_pid') is not None:
    raise RuntimeError('retained native failure has incomplete process exit evidence')
if not isinstance(receipt.get('error'),str) or not receipt['error']:
    raise RuntimeError('retained native failure has no error detail')
after_ready = 'service_owner' in receipt
API_START_FAILURE_MODE='api-start-failure'
API_START_FAILURE_ERROR_PREFIX='API binding did not become ready:'
api_start_failure = (
    not after_ready
    and isinstance(receipt.get('error'),str)
    and receipt['error'].startswith(API_START_FAILURE_ERROR_PREFIX)
)
if 'terminal_service_owner' in receipt:
    raise RuntimeError('retained native failure already contains a terminal owner transition')
ready_owner = receipt.get('service_owner')
if after_ready:
    if not isinstance(ready_owner,dict):
        raise RuntimeError('after-ready failure has no retained service owner identity')
    try:
        runtime_service._validate_terminal_owner(ready_owner,state='ready',name='retained ready service owner')
    except Exception as error:
        raise RuntimeError('retained ready service owner is invalid') from error
else:
    ready_owner = None
api_pid=receipt.get('api_pid')
if type(api_pid) is not int or api_pid <= 0:
    raise RuntimeError('retained native failure has no positive API pid')
api_pid_exists=bool(type(api_pid) is int and api_pid > 0 and os.path.exists('/proc/'+str(api_pid)))
owner_path=runtime_service.runtime_services_root(paths)/'OWNER.json'
owner_raw=read_regular(owner_path,'failed runtime service owner')
owner=read_json(owner_path,'failed runtime service owner')
if owner.get('schema_version')!='runtime_service_owner.v1' or owner.get('protocol')!='stdin-v1' or owner.get('state')!='failed' or owner.get('target_id')!='docker-all':
    raise RuntimeError('runtime service OWNER.json is not the expected failed owner')
children=owner.get('children')
if not isinstance(children,list) or len(children)!=2:
    raise RuntimeError('failed runtime service owner does not have exactly two children')
roles=set(); pids={owner.get('pid')}; live=[]
if type(owner.get('pid')) is not int or owner['pid'] <= 0:
    raise RuntimeError('failed runtime service owner pid is invalid')
if os.path.exists('/proc/'+str(owner['pid'])):
    live.append(owner['pid'])

def validate_after_ready_failed_owner(owner):
    """Validate failed owner fields without rewriting any child status."""
    if (owner.get('schema_version')!='runtime_service_owner.v1'
            or owner.get('protocol')!='stdin-v1'
            or owner.get('state')!='failed'
            or owner.get('target_id')!='docker-all'):
        raise RuntimeError('after-ready failed owner has an invalid state or target')
    token=owner.get('owner_token'); start_token=owner.get('process_start_token')
    if (not isinstance(token,str) or runtime_service.UUID_RE.fullmatch(token) is None
            or not isinstance(start_token,str) or runtime_service.UUID_RE.fullmatch(start_token) is None):
        raise RuntimeError('after-ready failed owner has invalid owner identity')
    if type(owner.get('pid')) is not int or owner['pid'] <= 0:
        raise RuntimeError('after-ready failed owner has an invalid owner pid')
    if not isinstance(owner.get('host'),str) or not owner['host']:
        raise RuntimeError('after-ready failed owner has no host identity')
    for field in ('acquired_at','heartbeat_at'):
        if not isinstance(owner.get(field),str) or not owner[field]:
            raise RuntimeError('after-ready failed owner has no '+field+' timestamp')
    for field, pattern in (('build_commit',runtime_service.HEX40),('build_snapshot',runtime_service.HEX64)):
        value=owner.get(field)
        if not isinstance(value,str) or pattern.fullmatch(value) is None:
            raise RuntimeError('after-ready failed owner has invalid '+field)
    for field in ('compute_pool_generation','preparation_pool_generation'):
        if type(owner.get(field)) is not int or owner[field] <= 0:
            raise RuntimeError('after-ready failed owner has invalid '+field)
    compute_pool=owner.get('compute_pool_id'); preparation_pool=owner.get('preparation_pool_id')
    if (not isinstance(compute_pool,str) or not compute_pool
            or not isinstance(preparation_pool,str) or not preparation_pool
            or compute_pool == preparation_pool):
        raise RuntimeError('after-ready failed owner has invalid scheduler pool identity')
    if not isinstance(owner.get('control_address'),str) or not owner['control_address']:
        raise RuntimeError('after-ready failed owner has no control address')
    children=owner.get('children')
    if not isinstance(children,list) or len(children)!=2:
        raise RuntimeError('after-ready failed owner has no exact child proof')
    roles=set(); child_pids=set()
    for child in children:
        if not isinstance(child,dict):
            raise RuntimeError('after-ready failed owner child is invalid')
        role=child.get('role'); pid=child.get('pid')
        if (role not in {'compute','preparation'} or role in roles
                or type(pid) is not int or pid <= 0 or pid in child_pids
                or child.get('status') not in {'exited_success','exited_failure'}):
            raise RuntimeError('after-ready failed owner child identity/status is invalid')
        roles.add(role); child_pids.add(pid)
    if roles != {'compute','preparation'}:
        raise RuntimeError('after-ready failed owner child roles are incomplete')
    runtime_service._owner_fingerprint(owner)

if after_ready or api_start_failure:
    validate_after_ready_failed_owner(owner)
else:
    runtime_service._validate_terminal_owner(owner,state='failed',name='failed runtime service owner')

for child in children:
    if not isinstance(child,dict):
        raise RuntimeError('failed runtime service owner child is invalid')
    role=child.get('role'); pid=child.get('pid'); status=child.get('status')
    allowed_statuses={'exited_success','exited_failure'} if after_ready or api_start_failure else {'exited_success'}
    if role not in {'compute','preparation'} or role in roles or type(pid) is not int or pid <= 0 or pid in pids or status not in allowed_statuses:
        raise RuntimeError('failed runtime service owner child identity/status is invalid')
    roles.add(role); pids.add(pid)
    if os.path.exists('/proc/'+str(pid)):
        live.append(pid)
if roles != {'compute','preparation'}:
    raise RuntimeError('failed runtime service owner child roles are incomplete')
if live:
    raise RuntimeError('failed runtime service owner has live native processes')
if after_ready:
    if runtime_service._owner_identity(ready_owner) != runtime_service._owner_identity(owner):
        raise RuntimeError('after-ready failed owner identity differs from retained ready owner')
    if runtime_service._owner_child_identity(ready_owner) != runtime_service._owner_child_identity(owner):
        raise RuntimeError('after-ready failed child identity differs from retained ready owner')

def native_processes_live():
    """Find any remaining Fullmag native binary in the private namespace."""
    found=[]
    package_root=pathlib.Path('/opt/fullmag/package')
    proc_root=pathlib.Path('/proc')
    try:
        entries=list(os.scandir(proc_root))
    except OSError as error:
        raise RuntimeError('cannot enumerate private process namespace') from error
    for entry in entries:
        if not entry.name.isdigit():
            continue
        try:
            executable=os.readlink(entry.path+'/exe')
        except FileNotFoundError:
            continue
        except OSError as error:
            raise RuntimeError('cannot inspect private process namespace') from error
        try:
            relative=pathlib.Path(executable).relative_to(package_root)
        except ValueError:
            continue
        executable_name=relative.name
        if (len(relative.parts) >= 2 and relative.parts[-2] == 'bin'
                and (executable_name == 'fullmag' or executable_name.startswith('fullmag-'))):
            found.append(int(entry.name))
    return sorted(found)

native_processes=native_processes_live()
if native_processes:
    raise RuntimeError('Fullmag native process remains live: '+','.join(str(pid) for pid in native_processes))
reservation_states=scan_ledger()
lease_states=scan_leases(paths.store)
if any(state!='released' for state in reservation_states) or any(state!='released' for state in lease_states):
    raise RuntimeError('native failure has active or unknown host resource state')
result={'schema':'fullmag.docker-native-after-ready-failure-stop-probe.v1' if after_ready else 'fullmag.docker-native-start-failure-stop-probe.v1','process_receipt_sha256':hashlib.sha256(receipt_raw).hexdigest(),'process_receipt':receipt,'failed_owner_sha256':hashlib.sha256(owner_raw).hexdigest(),'failed_owner':owner,'api_pid_exists':api_pid_exists,'owner_pid_exists':bool(type(owner.get('pid')) is int and os.path.exists('/proc/'+str(owner['pid']))),'child_pids_exist':bool(live),'native_processes_live':False,'startup_enabled':os.environ.get('FULLMAG_STARTUP_ENABLED'),'legacy_activation_marker_exists':os.path.lexists('/state/.fullmag/docker-startup/activation.json'),'reservation_states':reservation_states,'lease_states':lease_states,'active_lease_count':0}
if api_start_failure:
    result['failure_mode']=API_START_FAILURE_MODE
print(json.dumps(result,sort_keys=True))
'''


def _capture_native_failure_probe(container_id: str) -> dict[str, object]:
    result = docker_capture(
        'exec', container_id, '/usr/local/bin/python3', '-B', '-c',
        _native_failure_probe_script(), timeout=90,
    )
    if result.returncode:
        raise BuildControlError(
            'native failed-admission proof probe failed: '
            + result.stderr.decode('utf-8', 'replace')[-4096:]
        )
    try:
        probe = json.loads(result.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError('native failed-admission proof probe returned invalid JSON') from error
    if not isinstance(probe, dict):
        raise BuildControlError('native failed-admission proof probe is not an object')
    return probe


def _native_failure_probe_cas(probe: Mapping[str, object]) -> tuple[object, ...]:
    """Return the receipt/OWNER raw-byte CAS pins used by pre-stop revalidation."""

    return (
        probe.get('process_receipt_sha256'),
        probe.get('process_receipt'),
        probe.get('failed_owner_sha256'),
        probe.get('failed_owner'),
    )


SUPERVISION_FAILURE_SCHEMA = 'fullmag.docker-runtime-supervision-failure-stop-probe.v1'
SUPERVISION_FAILURE_KIND = 'native-runtime-supervision-failure'
SUPERVISION_FAILURE_ERROR = 'runtime service owner observation failed during supervision: runtime service owner is not ready'


def _runtime_supervision_probe_script():
    # Reuse the fixed no-follow readers/lock helpers, not the startup-only proof.
    prelude, separator, _ = _native_failure_probe_script().partition("\nif os.environ.get('FULLMAG_RUNTIME_PROCESS_RECEIPT'")
    if not separator:
        raise BuildControlError('native failure probe prelude changed')
    return prelude + r"""
import sys, uuid, datetime, re
sys.path.insert(0,'/opt/fullmag')
import runtime_service

def canon(value): return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
def sha(raw): return hashlib.sha256(raw).hexdigest()
def empty(root):
 if not root.is_dir() or any(p.is_symlink() for p in (root,*root.parents)): raise RuntimeError('unsafe accepted inventory')
 if any(root.iterdir()): raise RuntimeError('accepted runs or pending transactions exist')
paths=runtime_service.canonical_paths()
if (str(runtime_service.process_receipt_path(paths))!=CANONICAL_RECEIPT
 or os.environ.get('FULLMAG_RUNTIME_PROCESS_RECEIPT',CANONICAL_RECEIPT)!=CANONICAL_RECEIPT
 or os.environ.get('FULLMAG_HOST_LEDGER_ROOT',CANONICAL_LEDGER)!=CANONICAL_LEDGER
 or os.environ.get('FULLMAG_ACCEPTED_STORE_SCOPE')
 or paths.store!=pathlib.Path(os.environ['FULLMAG_RUNS_ROOT'])/'session-store'):
 raise RuntimeError('runtime/store/ledger selection differs')
if os.environ.get('FULLMAG_STARTUP_ENABLED','0')!='0' or os.path.lexists('/state/.fullmag/docker-startup/activation.json'):
 raise RuntimeError('startup activation is outside supervision recovery')
receipt_raw=read_regular(CANONICAL_RECEIPT,'process receipt'); receipt=json.loads(receipt_raw)
if (receipt.get('schema')!='fullmag.docker-process-tree.v1' or receipt.get('state')!='failed_outcome_retained'
 or receipt.get('error')!='runtime service owner observation failed during supervision: runtime service owner is not ready'
 or type(receipt.get('api_exit_code')) is not int or 'terminal_service_owner' in receipt
 or 'startup_activation' in receipt or receipt.get('runtime_pid') is not None
 or receipt.get('accepted_store')!=str(paths.store)):
 raise RuntimeError('not the supported retained supervision failure')
pin=receipt.get('service_owner');runtime_service._validate_terminal_owner(pin,state='ready',name='supervision ready pin')
owner_root=runtime_service.runtime_services_root(paths)
owner_fd=lock_file(owner_root/'OWNER.lock','native owner lock')
try:
 owner_raw=read_regular(owner_root/'OWNER.json','failed owner');owner=json.loads(owner_raw)
 children=owner.get('children')
 if (owner.get('state')!='failed' or not isinstance(children,list) or len(children)!=2
  or any(not isinstance(x,dict) or set(x)!={'role','pid','status'} for x in children)
  or {x.get('role') for x in children}!={'compute','preparation'}
  or any(x.get('status') not in {'exited_success','exited_failure'} for x in children)
  or not any(x.get('status')=='exited_failure' for x in children)):
  raise RuntimeError('failed owner lacks terminal failed-child evidence')
 if runtime_service._owner_child_identity(owner)!=runtime_service._owner_child_identity(pin):
  raise RuntimeError('terminal children differ from ready pin')
 expected=dict(pin,state='failed',heartbeat_at=owner.get('heartbeat_at'),children=children)
 if owner!=expected: raise RuntimeError('failed owner identity differs from ready pin')
 def timestamp(value):
  # Chrono DateTime<Utc> serializes UTC with Z and up to nine fraction digits.
  match=re.fullmatch(r'([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(?:\.([0-9]{1,9}))?Z',value) if isinstance(value,str) else None
  if match is None:raise RuntimeError('invalid native UTC heartbeat')
  return (datetime.datetime.fromisoformat(match[1]),int((match[2] or '').ljust(9,'0')))
 if timestamp(owner['heartbeat_at'])<timestamp(pin['heartbeat_at']): raise RuntimeError('failed heartbeat predates ready pin')
 pids=[receipt.get('api_pid'),owner.get('pid'),*[x.get('pid') for x in children]]
 if any(type(pid) is not int or pid<=0 for pid in pids) or len(set(pids))!=4 or any(os.path.exists('/proc/'+str(pid)) for pid in pids):
  raise RuntimeError('API/native owner/child is live or ambiguous')
 host_raw=read_regular(paths.host_certificate,'Windows certificate');host=json.loads(host_raw)
 host_owner_raw=read_regular(paths.state/'.fullmag-windows-folder-owner.json','Windows owner');host_owner=json.loads(host_owner_raw)
 grant_raw=read_regular(paths.state/'.fullmag-windows-folder-grant.json','Windows grant');grant=json.loads(grant_raw)
 if (canon(host_owner)!=canon(host) or host.get('schema')!='fullmag.windows-folder-host.v1' or host.get('storage_profile')!='windows-folder-v1'
  or host.get('restart_verified') is not True or grant.get('state')!='operational'
  or grant.get('schema')!='fullmag.windows-folder-session.v1' or grant.get('container_root')!='/state'
  or grant.get('host_attestation_sha256')!=sha(host_raw) or grant.get('owner_token')!=host.get('owner_token')):
  raise RuntimeError('Windows owner/admission differs')
 token=host['owner_token'];relative=paths.store.relative_to(paths.state).as_posix()
 if str(uuid.UUID(token))!=token or uuid.UUID(token).int==0 or type(host.get('host_volume_serial')) is not int or host['host_volume_serial']<=0 or relative=='.':
  raise RuntimeError('invalid admitted store identity')
 identity={'schema':'fullmag.docker-admitted-store-identity.v2','host_root':host['host_root'].replace('\\','/').translate(str.maketrans('ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')),
  'host_volume_serial':host['host_volume_serial'],'engine_id':host['engine_id'],'owner_token':token,'relative_state_path':relative}
 store_id='sha256:'+sha(canon(identity))
 ledger=pathlib.Path(CANONICAL_LEDGER);ledger_fd=lock_file(ledger/'WRITER.lock','host ledger writer')
 try:
  store_fd=lock_file(paths.store/'WRITER.lock','accepted store writer')
  try:
   for name in ('runs','temp','recovery'):empty(paths.store/name)
   reservations=read_json(ledger/'HOST_RESOURCE_LEDGER.json','host ledger').get('reservations')
   if not isinstance(reservations,list):raise RuntimeError('ledger reservations missing')
   for row in reservations:
    item=row.get('identity') if isinstance(row,dict) else None;candidate=item.get('store_id') if isinstance(item,dict) else None
    if not isinstance(candidate,str) or len(candidate)!=71 or not candidate.startswith('sha256:') or any(c not in '0123456789abcdef' for c in candidate[7:]):
     raise RuntimeError('reservation ownership is unknown')
    if candidate==store_id:raise RuntimeError('affected store has a host reservation')
   config_raw=read_regular(paths.config,'runtime config')
   if (read_regular(CANONICAL_RECEIPT,'process receipt')!=receipt_raw or read_regular(owner_root/'OWNER.json','failed owner')!=owner_raw
    or read_regular(paths.host_certificate,'Windows certificate')!=host_raw
    or read_regular(paths.state/'.fullmag-windows-folder-owner.json','Windows owner')!=host_owner_raw
    or read_regular(paths.state/'.fullmag-windows-folder-grant.json','Windows grant')!=grant_raw
    or any(os.path.exists('/proc/'+str(pid)) for pid in pids)):
    raise RuntimeError('supervision evidence changed')
   print(json.dumps({'schema':'fullmag.docker-runtime-supervision-failure-stop-probe.v1','process_receipt_sha256':sha(receipt_raw),
    'ready_pin_sha256':sha(canon(pin)),'failed_owner_sha256':sha(owner_raw),'config_sha256':sha(config_raw),
    'accepted_store_id':store_id,'windows_certificate_sha256':sha(host_raw),'api_pid':pids[0],'runtime_pid':pids[1],
    'terminal_children':[{key:child[key] for key in ('role','pid','status')} for child in children],'processes_absent':True,'runs_empty':True,'transients_empty':True,'affected_reservations_empty':True},sort_keys=True))
  finally:fcntl.flock(store_fd,fcntl.LOCK_UN);os.close(store_fd)
 finally:fcntl.flock(ledger_fd,fcntl.LOCK_UN);os.close(ledger_fd)
finally:fcntl.flock(owner_fd,fcntl.LOCK_UN);os.close(owner_fd)
"""


def _validate_supervision_probe(probe, expected_sha):
    if not isinstance(probe, Mapping) or probe.get('schema') != SUPERVISION_FAILURE_SCHEMA or probe.get('process_receipt_sha256') != expected_sha:
        raise BuildControlError('runtime supervision proof identity differs')
    if set(probe)!={'schema','process_receipt_sha256','ready_pin_sha256','failed_owner_sha256','config_sha256','windows_certificate_sha256','accepted_store_id','api_pid','runtime_pid','terminal_children','processes_absent','runs_empty','transients_empty','affected_reservations_empty'}:
        raise BuildControlError('runtime supervision proof has unexpected fields')
    for key in ('process_receipt_sha256','ready_pin_sha256','failed_owner_sha256','config_sha256','windows_certificate_sha256'):
        if not isinstance(probe.get(key),str) or re.fullmatch('[0-9a-f]{64}',probe[key]) is None:
            raise BuildControlError('runtime supervision proof has invalid '+key)
    if not isinstance(probe.get('accepted_store_id'),str) or re.fullmatch('sha256:[0-9a-f]{64}',probe['accepted_store_id']) is None:
        raise BuildControlError('runtime supervision store identity differs')
    if any(probe.get(key) is not True for key in ('processes_absent','runs_empty','transients_empty','affected_reservations_empty')):
        raise BuildControlError('runtime supervision has live/accepted/ambiguous work')
    children=probe.get('terminal_children')
    if (not isinstance(children,list) or len(children)!=2 or any(not isinstance(row,dict) or set(row)!={'role','pid','status'} for row in children)
            or {row.get('role') for row in children}!={'compute','preparation'}
            or any(row.get('status') not in {'exited_success','exited_failure'} for row in children)
            or not any(row.get('status')=='exited_failure' for row in children)):
        raise BuildControlError('runtime supervision terminal child evidence differs')
    pids=[probe.get('api_pid'),probe.get('runtime_pid'),*[row.get('pid') for row in children]]
    if any(type(pid) is not int or pid<=0 for pid in pids) or len(set(pids))!=4:
        raise BuildControlError('runtime supervision process identity is ambiguous')
    return dict(probe)


def _supervision_terminal_proof(control, probe):
    from docker_volume_stop_unadmitted import _control_bytes
    raw=_control_bytes(control,'runtime-control/runtime-service/process-tree.json')
    owner_raw=_control_bytes(control,'runtime-control/runtime-services/OWNER.json')
    terminal=json.loads(raw)
    pin=terminal.get('service_owner')
    if (terminal.get('schema')!='fullmag.docker-process-tree.v1' or terminal.get('state')!='shutdown_unknown'
            or terminal.get('error')!=SUPERVISION_FAILURE_ERROR or terminal.get('shutdown_error')!='runtime service owner is not ready'
            or terminal.get('api_pid')!=probe['api_pid'] or type(terminal.get('api_exit_code')) is not int
            or terminal.get('runtime_pid') is not None or 'terminal_service_owner' in terminal or 'startup_activation' in terminal
            or not isinstance(pin,dict) or hashlib.sha256(json.dumps(pin,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()!=probe['ready_pin_sha256']
            or hashlib.sha256(owner_raw).hexdigest()!=probe['failed_owner_sha256']):
        raise BuildControlError('stopped supervision receipt/pin/failed owner changed')
    return hashlib.sha256(raw).hexdigest()


def _stop_runtime_supervision_failure(args, selected, identity, actual):
    from docker_build_control import toolchain_configuration, canonical
    from docker_volume_reconcile import fingerprint
    from docker_volume_dev import _validate_retained_service, _assert_private_restart_network, _read_runtime_config_digest
    configured=toolchain_configuration(selected,identity)
    control=BuildControl(identity,configured['services']['fem-gpu-toolchain']['build']['args']['FULLMAG_CUDA_BASE_IMAGE'])
    previous=control.read('development/current.json');attempt=previous.get('attempt')
    if (previous.get('state')!='succeeded' or previous.get('compose_project')!=control.project
            or not isinstance(attempt,str) or re.fullmatch('[0-9a-f]{32}',attempt) is None
            or previous.get('inputs',{}).get('source_root')!=str(selected)
            or previous.get('backend_container')!=args.container_id):
        raise BuildControlError('supervision stop has no exact retained development authority')
    base='development/attempts/'+attempt;document=control.read(base+'/compose.json')
    config_sha=hashlib.sha256(canonical(document)).hexdigest()
    if previous.get('config_sha256')!=config_sha or control.read(base+'/terminal.json')!=previous:
        raise BuildControlError('retained development/config CAS differs')
    ids={'backend':args.container_id,'frontend':previous.get('frontend_container')}
    image_config=json.loads(docker_capture('image','inspect',args.image_id).stdout)[0]['Config']
    initial={}
    def services():
        current={name:json.loads(docker_capture('inspect',identifier).stdout)[0] for name,identifier in ids.items()}
        for name,value in current.items():
            if value.get('Id')!=ids[name] or value.get('Image')!=args.image_id:
                raise BuildControlError('supervision stop service identity differs')
            _validate_retained_service(document,value,name,image_config)
            if initial and (value['State']['StartedAt'],fingerprint(value))!=initial[name]:
                raise BuildControlError('supervision stop service incarnation/config changed')
        return current
    current=services();_assert_private_restart_network(current,ids,control.project)
    if current['backend']['State']['StartedAt']!=actual['State']['StartedAt'] or fingerprint(current['backend'])!=fingerprint(actual):
        raise BuildControlError('backend changed since the pinned failed observation')
    initial.update({name:(value['State']['StartedAt'],fingerprint(value)) for name,value in current.items()})
    def probe():
        value=json.loads(docker_capture('exec',args.container_id,'/usr/local/bin/python3','-B','-c',_runtime_supervision_probe_script(),timeout=90).stdout)
        return _validate_supervision_probe(value,args.process_receipt_sha256)
    journal_path='verification/stop-failed-'+args.container_id+'.json'
    with control.operation('stop-failed-runtime',{'source_root':str(selected),'container_id':args.container_id,
            'image_id':args.image_id,'process_receipt_sha256':args.process_receipt_sha256,'attempt':attempt,'config_sha256':config_sha}) as operation:
        if (control.read('development/current.json')!=previous or control.read(base+'/terminal.json')!=previous
                or control.read(base+'/compose.json')!=document):
            raise BuildControlError('retained development authority changed before stop')
        if control.read(journal_path,optional=True) is not None:
            raise BuildControlError('supervision stop journal already exists')
        before=probe();current=services();_assert_private_restart_network(current,ids,control.project)
        if _read_runtime_config_digest(control)!=before['config_sha256']:
            raise BuildControlError('runtime config changed before supervision stop')
        journal={'schema':'fullmag.stop-failed-admission.v1','state':'stopping-confirmed-failed-supervisor',
            'failure_kind':SUPERVISION_FAILURE_KIND,'container_id':args.container_id,'image_id':args.image_id,
            'source_root':str(selected),'development_attempt':attempt,'compose_config_sha256':config_sha,
            'supervision_probe':before,'previous_config_sha256':before['config_sha256'],'operation_attempt':operation['receipt']['attempt']}
        control.write(journal_path,journal)
        current=services();_assert_private_restart_network(current,ids,control.project)
        if (probe()!=before or current['backend']['State'].get('Running') is not True
                or control.read('development/current.json')!=previous):
            raise BuildControlError('supervision stop proof changed before stop')
        operation['daemon_pending']=True
        docker_capture('stop','--time','60',args.container_id,timeout=90)
        after=services()['backend']
        if after['State'].get('Running') is not False or after['State'].get('Pid')!=0 or type(after['State'].get('ExitCode')) is not int:
            raise BuildControlError('supervision namespace stop is unconfirmed')
        terminal_sha=_supervision_terminal_proof(control,before)
        if _read_runtime_config_digest(control)!=before['config_sha256']:
            raise BuildControlError('runtime config changed after supervision stop')
        journal.update(state='stopped-confirmed',exit_code=after['State']['ExitCode'],terminal_process_receipt_sha256=terminal_sha,
                       stopped_started_at=after['State']['StartedAt'],namespace_processes_absent=True)
        control.write(journal_path,journal)
        operation['daemon_pending']=False;operation['receipt']['state']='succeeded'
    print(json.dumps({'state':'stopped-confirmed','failure_kind':SUPERVISION_FAILURE_KIND,'container_id':args.container_id}))


def _supervision_failed_restart_context(control, previous, journal, journal_raw, backend_id, fresh_state):
    if (fresh_state or journal.get('schema')!='fullmag.stop-failed-admission.v1' or journal.get('state')!='stopped-confirmed'
            or journal.get('container_id')!=backend_id or journal.get('image_id')!=previous.get('inputs',{}).get('image_id')
            or journal.get('source_root')!=previous.get('inputs',{}).get('source_root')
            or journal.get('development_attempt')!=previous.get('attempt')
            or journal.get('compose_config_sha256')!=previous.get('config_sha256')
            or journal.get('namespace_processes_absent') is not True or type(journal.get('exit_code')) is not int):
        raise BuildControlError('runtime supervision stopped namespace proof differs')
    probe=journal.get('supervision_probe');_validate_supervision_probe(probe,probe.get('process_receipt_sha256') if isinstance(probe,dict) else None)
    if _supervision_terminal_proof(control,probe)!=journal.get('terminal_process_receipt_sha256'):
        raise BuildControlError('runtime supervision terminal receipt changed')
    from docker_volume_dev import _read_runtime_config_digest
    if _read_runtime_config_digest(control)!=journal.get('previous_config_sha256') or journal['previous_config_sha256']!=probe['config_sha256']:
        raise BuildControlError('runtime supervision configuration changed')
    root=Path(previous['state_root'])/'runs/docker-all/session-store'
    for name in ('runs','temp','recovery'):
        path=root/name
        if not path.is_dir() or any(storage.is_link(p) for p in (path,*path.parents)) or any(path.iterdir()):
            raise BuildControlError('runtime supervision store acquired accepted/pending work')
    return {'previous_config_sha256':probe['config_sha256'],'native_restart_metadata':{
        'schema':'fullmag.docker-runtime-supervision-restart.v1','journal_sha256':hashlib.sha256(journal_raw).hexdigest(),
        'container_id':backend_id,'image_id':journal['image_id'],'terminal_failed_owner_sha256':probe['failed_owner_sha256'],
        'terminal_process_receipt_sha256':journal['terminal_process_receipt_sha256'],'claim_pending':False}}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root',type=Path,required=True)
    parser.add_argument('--container-id',required=True)
    parser.add_argument('--image-id',required=True)
    parser.add_argument('--process-receipt-sha256',required=True)
    args=parser.parse_args()
    if not re.fullmatch('[0-9a-f]{64}',args.container_id) or not re.fullmatch('sha256:[0-9a-f]{64}',args.image_id) or not re.fullmatch('[0-9a-f]{64}',args.process_receipt_sha256):
        raise BuildControlError('Stop requires complete immutable container/image/receipt identities')
    selected=args.source_root.resolve(strict=True)
    identity=compose_project_identity(storage.resolve_layout(selected,'docker-all-gpu'))
    actual=json.loads(docker_capture('inspect',args.container_id).stdout)
    if len(actual)!=1 or actual[0].get('Id')!=args.container_id or actual[0].get('Image')!=args.image_id:
        raise BuildControlError('Pinned backend identity differs')
    actual=actual[0]
    validate_source_labels(actual,identity)
    labels=actual.get('Config',{}).get('Labels',{})
    if labels.get('com.docker.compose.project')!=identity['project_name'] or labels.get('com.docker.compose.service')!='backend' or not actual.get('State',{}).get('Running'):
        raise BuildControlError('Stop requires this exact running DEV backend')
    log_result = docker_capture('logs','--since',actual['State']['StartedAt'],'--tail','100',args.container_id)
    logs = (log_result.stdout + log_result.stderr).decode('utf-8','replace')
    if 'Startup or runtime failed; admission closed:' not in logs:
        raise BuildControlError('This backend incarnation has no confirmed failed-admission event')
    script='''import hashlib,json,pathlib,sys,os
sys.path.insert(0,'/opt/fullmag')
import runtime_service
raw=runtime_service._bounded_regular(runtime_service.process_receipt_path(runtime_service.canonical_paths()),'failed process receipt')
document=json.loads(raw)
if isinstance(document.get('service_owner'),dict):
 runtime_service._validate_terminal_owner(document['service_owner'],state='ready',name='failed admission service owner')
pid=document.get('api_pid')
print(json.dumps({'sha256':hashlib.sha256(raw).hexdigest(),'receipt':document,'api_pid_exists':bool(pid and os.path.exists('/proc/'+str(pid))),
 'startup_enabled':os.environ.get('FULLMAG_STARTUP_ENABLED'),
 'managed_receipt_key':os.environ.get('FULLMAG_STARTUP_RECEIPT_KEY'),
 'legacy_activation_marker_exists':os.path.lexists('/state/.fullmag/docker-startup/activation.json')}))
'''
    observed=json.loads(docker_capture('exec',args.container_id,'/usr/local/bin/python3','-B','-c',script).stdout)
    receipt=observed['receipt']
    if (receipt.get('state') == 'failed_outcome_retained'
            and receipt.get('error') == SUPERVISION_FAILURE_ERROR
            and 'FULLMAG_SESSION_STORAGE_PROFILE=linux-native-v1' in actual.get('Config', {}).get('Env', [])):
        from docker_volume_linux_supervision_stop import stop as stop_linux_supervision
        result = stop_linux_supervision(args, selected, identity, actual)
        print(json.dumps({'state': result['state'], 'failure_kind': result['failure_kind'],
                          'container_id': args.container_id}))
        return
    if (receipt.get('state') == 'failed_outcome_retained' and 'service_owner' in receipt
            and receipt.get('error') == SUPERVISION_FAILURE_ERROR
            and 'FULLMAG_SESSION_STORAGE_PROFILE=windows-folder-v1' in actual.get('Config', {}).get('Env', [])):
        return _stop_runtime_supervision_failure(args,selected,identity,actual)
    native_failure = None
    native_failure_kind = None
    pre_marker_failure = (
        receipt.get('error') == 'startup activation state parent is unavailable: /state/.fullmag'
        and observed.get('startup_enabled') == '1'
        and observed.get('managed_receipt_key') is None
        and observed.get('legacy_activation_marker_exists') is False
        and 'startup_activation' not in receipt
        and isinstance(receipt.get('service_owner'), dict)
    )
    api_start_failure = (
        'service_owner' not in receipt
        and isinstance(receipt.get('error'), str)
        and receipt['error'].startswith(API_START_FAILURE_ERROR_PREFIX)
    )
    # A pre-marker startup failure is proven by its own drained-owner receipt
    # after stop; its post-stop evidence (terminal_service_owner present)
    # contradicts the native shutdown_unknown receipt, so the routes are
    # mutually exclusive.
    if receipt.get('state') == 'failed_outcome_retained' and not pre_marker_failure:
        native_probe = _capture_native_failure_probe(args.container_id)
        if 'service_owner' in receipt:
            native_failure = _validate_native_after_ready_failure_probe(
                native_probe, args.process_receipt_sha256
            )
            native_failure_kind = 'native-after-ready-failure'
        else:
            native_failure = _validate_native_failure_probe(
                native_probe,
                args.process_receipt_sha256,
                api_start_failure=api_start_failure,
            )
            native_failure_kind = 'native-start-failure'
        if (native_failure['receipt'] != receipt
                or native_failure['probe'].get('process_receipt_sha256') != observed['sha256']):
            raise BuildControlError('Native failure probe does not bind the exact failed process receipt')
    if (observed['sha256']!=args.process_receipt_sha256 or observed['api_pid_exists']
            or receipt.get('schema')!='fullmag.docker-process-tree.v1'
            or receipt.get('state')!='failed_outcome_retained'
            or not isinstance(receipt.get('api_exit_code'),int) or receipt.get('runtime_pid') is not None
            or (native_failure is None and not pre_marker_failure)):
        raise BuildControlError('Failed admission is not proven; no process will be stopped')
    from docker_build_control import toolchain_configuration
    config=toolchain_configuration(selected,identity)
    control=BuildControl(identity,config['services']['fem-gpu-toolchain']['build']['args']['FULLMAG_CUDA_BASE_IMAGE'])
    if native_failure is None and not pre_marker_failure:
        raise BuildControlError('Failed admission has no native proof before stop')
    if native_failure is not None:
        recheck_probe = _capture_native_failure_probe(args.container_id)
        if 'service_owner' in receipt:
            revalidated = _validate_native_after_ready_failure_probe(
                recheck_probe, args.process_receipt_sha256
            )
        else:
            revalidated = _validate_native_failure_probe(
                recheck_probe,
                args.process_receipt_sha256,
                api_start_failure=api_start_failure,
            )
        if (
            _native_failure_probe_cas(revalidated['probe'])
            != _native_failure_probe_cas(native_failure['probe'])
            or revalidated['receipt'] != receipt
        ):
            raise BuildControlError('Native failure receipt or OWNER changed during bounded pre-stop revalidation')
        native_failure = revalidated
    journal={'schema':'fullmag.stop-failed-admission.v1','state':'stopping-confirmed-failed-supervisor',
             'container_id':args.container_id,'image_id':args.image_id,'failure_receipt':observed}
    if native_failure is not None:
        journal.update(failure_kind=native_failure_kind, native_failure_probe=native_failure['probe'])
        if api_start_failure:
            journal['failure_mode'] = API_START_FAILURE_MODE
        if native_failure_kind == 'native-after-ready-failure':
            journal['retained_ready_owner'] = native_failure['ready_owner']
            journal['retained_ready_owner_sha256'] = hashlib.sha256(
                json.dumps(native_failure['ready_owner'], sort_keys=True, separators=(',', ':')).encode()
            ).hexdigest()
    path='verification/stop-failed-'+args.container_id+'.json'
    control.write(path,journal)
    docker_capture('stop','--time','60',args.container_id,timeout=90)
    after=json.loads(docker_capture('inspect',args.container_id).stdout)[0]
    if after.get('State',{}).get('Running'):
        raise BuildControlError('Failed supervisor is still running; no retry was attempted')
    if native_failure is not None:
        terminal = control.read('runtime-control/runtime-service/process-tree.json')
        from docker_volume_stop_unadmitted import _control_bytes
        terminal_owner_raw = _control_bytes(control, 'runtime-control/runtime-services/OWNER.json')
        terminal_owner = json.loads(terminal_owner_raw)
        terminal_ready_owner = terminal.get('service_owner') if isinstance(terminal, dict) else None
        terminal_owner_valid = (
            not isinstance(terminal, dict)
            or terminal.get('schema') != 'fullmag.docker-process-tree.v1'
            or terminal.get('state') != 'shutdown_unknown'
            or 'startup_activation' in terminal
            or 'terminal_service_owner' in terminal
            or type(terminal.get('api_exit_code')) is not int
            or terminal.get('runtime_pid') is not None
        )
        if native_failure_kind == 'native-after-ready-failure':
            terminal_owner_valid = terminal_owner_valid or not isinstance(terminal_ready_owner, Mapping)
            if isinstance(terminal_ready_owner, Mapping):
                terminal_owner_valid = terminal_owner_valid or terminal_ready_owner != native_failure['ready_owner']
        else:
            terminal_owner_valid = terminal_owner_valid or 'service_owner' in terminal
        if terminal_owner_valid:
            raise BuildControlError(
                'native failed supervisor stopped without the canonical shutdown_unknown receipt'
            )
        if (terminal_owner != native_failure['failed_owner']
                or hashlib.sha256(terminal_owner_raw).hexdigest()
                != native_failure['probe']['failed_owner_sha256']):
            raise BuildControlError(
                'native failed owner changed while stopping the retained supervisor'
            )
        journal['terminal_process_receipt'] = terminal
        journal['terminal_failed_owner'] = terminal_owner
        journal['terminal_failed_owner_sha256'] = hashlib.sha256(terminal_owner_raw).hexdigest()
        if native_failure_kind == 'native-after-ready-failure':
            journal['terminal_retained_ready_owner'] = terminal_ready_owner
    if pre_marker_failure:
        from docker_volume_stop_unadmitted import _read_terminal_process_receipt, _owner_identity_key
        drained_raw, drained = _read_terminal_process_receipt(after, control)
        before_owner = receipt['service_owner']
        terminal_owner = drained.get('terminal_service_owner')
        if (_owner_identity_key(terminal_owner, 'terminal service owner')
                != _owner_identity_key(before_owner, 'failed admission service owner')):
            raise BuildControlError('Stopped startup failure has no matching authenticated drain; resources retained')
        journal['drained_process_receipt'] = drained
        journal['drained_process_receipt_sha256'] = hashlib.sha256(drained_raw).hexdigest()
    after_state = after.get('State', {})
    exit_code = after_state.get('ExitCode')
    if type(exit_code) is not int:
        raise BuildControlError('Stopped supervisor has no canonical Docker exit code')
    journal.update(
        state='stopped-confirmed',
        exit_code=exit_code,
        container_state={
            'id': after.get('Id'),
            'image': after.get('Image'),
            'started_at': after_state.get('StartedAt'),
            'finished_at': after_state.get('FinishedAt'),
            'exit_code': exit_code,
        },
    )
    control.write(path,journal)
    print(json.dumps({'state':journal['state'],'container_id':args.container_id}))
    return 0


if __name__=='__main__':
    raise SystemExit(main())
