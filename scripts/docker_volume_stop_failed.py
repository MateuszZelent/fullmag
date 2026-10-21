"""Stop one pinned DEV supervisor after a bounded failed-admission proof.

The proof distinguishes native startup, API binding failure with a retained
historical failed owner, the explicit pre-marker activation-parent failure,
and failure after READY with a ready identity pin. None of these observations
releases resources or rewrites owner state.
"""
import argparse
import base64
import binascii
import hashlib
import io
import json
import subprocess
import tarfile
import time
import uuid
from collections.abc import Mapping
from pathlib import Path
import re
import sys

import fullmag_storage as storage
from docker_build_control import BuildControl, BuildControlError, MAX_DOCUMENT_BYTES, canonical, docker_capture
from docker_compose_identity import compose_project_identity, validate_source_labels


CANONICAL_PROCESS_RECEIPT = "/opt/fullmag/runtime-control/runtime-service/process-tree.json"
CANONICAL_RUNTIME_OWNER = "/opt/fullmag/runtime-control/runtime-services/OWNER.json"
CANONICAL_HOST_LEDGER_ROOT = "/host-ledger/ledger"
NATIVE_FAILURE_PROBE_SCHEMA = "fullmag.docker-native-start-failure-stop-probe.v1"
NATIVE_AFTER_READY_FAILURE_PROBE_SCHEMA = (
    "fullmag.docker-native-after-ready-failure-stop-probe.v1"
)
QUIESCENT_UNKNOWN_OWNER_PROBE_SCHEMA = "fullmag.docker-quiescent-unknown-owner-stop-probe.v1"
QUIESCENT_UNKNOWN_OWNER_JOURNAL_SCHEMA = "fullmag.docker-quiescent-unknown-owner-stop.v1"
QUIESCENT_UNKNOWN_OWNER_RECEIPT_MAX_BYTES = 4 * 1024 * 1024
API_START_FAILURE_MODE = "api-start-failure"
API_START_FAILURE_ERROR_PREFIX = "API binding did not become ready:"
QUIESCENT_AFTER_READY_ERROR_PATTERN = (
    r"runtime observation stayed degraded for [0-9]+s: "
    r"API identity probe failed during supervision: "
    r"API loopback probe failed for /v2/platform/openapi\.json: timed out"
)


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


def _quiescent_unknown_owner_probe_script() -> str:
    """Return a read-only proof limited to the retained unknown-owner incident."""

    return r'''import base64, fcntl, hashlib, json, os, pathlib, re, stat, sys, time
MAX=8*1024*1024
MAX_RECEIPT=4*1024*1024
MAX_ENTRIES=8192
MAX_RUNS=8192
PROBE_MARKER='FULLMAG_QUIESCENT_UNKNOWN_OWNER_STOP_PROBE_V1'
ERROR_PATTERN=r'runtime observation stayed degraded for [0-9]+s: API identity probe failed during supervision: API loopback probe failed for /v2/platform/openapi\.json: timed out'
CANONICAL_RECEIPT='/opt/fullmag/runtime-control/runtime-service/process-tree.json'
CANONICAL_OWNER='/opt/fullmag/runtime-control/runtime-services/OWNER.json'
CANONICAL_LEDGER='/host-ledger/ledger'
ENTRYPOINT_PID=7

def read_raw(path, label, maximum=MAX):
    path=pathlib.Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise RuntimeError(label+' path is unsafe')
    fd=os.open(path,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0))
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size>maximum:
            raise RuntimeError(label+' is not a bounded regular file')
        data=os.read(fd,maximum+1)
        if len(data)>maximum:
            raise RuntimeError(label+' exceeds bound')
        return data
    finally:
        os.close(fd)

def read_document(raw,label):
    try:
        value=json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError,json.JSONDecodeError) as error:
        raise RuntimeError(label+' is invalid JSON') from error
    if not isinstance(value,dict):
        raise RuntimeError(label+' is not an object')
    return value

def lock_file(path,label):
    path=pathlib.Path(path)
    if not path.is_file() or path.is_symlink():
        raise RuntimeError(label+' is missing')
    fd=os.open(path,os.O_RDWR|getattr(os,'O_NOFOLLOW',0))
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise RuntimeError(label+' is not a regular file')
        deadline=time.monotonic()+5
        while True:
            try:
                fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
                return fd
            except BlockingIOError as error:
                if time.monotonic()>=deadline:
                    raise RuntimeError(label+' remained busy within the observation budget') from error
                time.sleep(.025)
            except OSError as error:
                raise RuntimeError(label+' lock outcome is unknown') from error
    except Exception:
        os.close(fd)
        raise

def scan_ledger():
    if os.environ.get('FULLMAG_HOST_LEDGER_ROOT',CANONICAL_LEDGER)!=CANONICAL_LEDGER:
        raise RuntimeError('host ledger root override differs from the canonical mount')
    root=pathlib.Path(CANONICAL_LEDGER)
    fd=lock_file(root/'WRITER.lock','host ledger writer lock')
    try:
        raw=read_raw(root/'HOST_RESOURCE_LEDGER.json','host resource ledger')
        document=read_document(raw,'host resource ledger')
        rows=document.get('reservations')
        if not isinstance(rows,list) or len(rows)>MAX_ENTRIES:
            raise RuntimeError('host ledger reservation inventory is missing or unbounded')
        states=[]
        for row in rows:
            if not isinstance(row,dict) or not isinstance(row.get('state'),str):
                raise RuntimeError('host ledger reservation is invalid')
            states.append(row['state'])
        return states
    finally:
        fcntl.flock(fd,fcntl.LOCK_UN)
        os.close(fd)

def scan_leases(store):
    root=pathlib.Path(store)
    fd=lock_file(root/'WRITER.lock','accepted-store writer lock')
    try:
        runs=root/'runs'
        if not runs.is_dir() or runs.is_symlink():
            raise RuntimeError('accepted store runs directory is missing')
        states=[]; entries=0; run_count=0
        for run in os.scandir(runs):
            run_count+=1
            entries+=1
            if entries>MAX_ENTRIES or run_count>MAX_RUNS or run.is_symlink() or not run.is_dir(follow_symlinks=False):
                raise RuntimeError('accepted store run inventory is invalid or unbounded')
            for directory_name in ('resource_leases','preparation_resource_leases'):
                lease_root=pathlib.Path(run.path)/directory_name
                if not os.path.lexists(lease_root):
                    continue
                if lease_root.is_symlink() or not lease_root.is_dir():
                    raise RuntimeError('accepted store lease root is invalid')
                for resource in os.scandir(lease_root):
                    entries+=1
                    if entries>MAX_ENTRIES:
                        raise RuntimeError('accepted store lease inventory is unbounded')
                    if resource.is_symlink() or not resource.is_dir(follow_symlinks=False):
                        raise RuntimeError('accepted store lease resource entry is invalid')
                    for entry in os.scandir(resource.path):
                        entries+=1
                        if entries>MAX_ENTRIES or entry.is_symlink() or not entry.is_file(follow_symlinks=False) or not entry.name.endswith('.json'):
                            raise RuntimeError('accepted store lease record inventory is invalid or unbounded')
                        record=read_document(read_raw(entry.path,'accepted store lease record'),'accepted store lease record')
                        state=record.get('state')
                        if state not in {'released','active'}:
                            raise RuntimeError('accepted store lease state is unknown')
                        states.append(state)
        return states
    finally:
        fcntl.flock(fd,fcntl.LOCK_UN)
        os.close(fd)

def read_proc_file(path,label,maximum=256*1024):
    fd=os.open(path,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0))
    try:
        data=os.read(fd,maximum+1)
        if len(data)>maximum:
            raise RuntimeError(label+' exceeds its observation bound')
        return data
    finally:
        os.close(fd)

def proc_status(pid):
    raw=read_proc_file('/proc/'+str(pid)+'/status','process status',64*1024)
    parent=None; state=None
    for line in raw.decode('ascii','strict').splitlines():
        if line.startswith('PPid:'):
            parent=int(line.split(':',1)[1].strip())
        elif line.startswith('State:'):
            state=line.split(':',1)[1].strip().split()[0]
    if parent is None or state is None:
        raise RuntimeError('process parent or state identity is unavailable')
    return parent,state

def process_inventory(api_pid):
    proc=pathlib.Path('/proc')
    try:
        entries=[]
        with os.scandir(proc) as iterator:
            for entry in iterator:
                entries.append(entry.name)
                if len(entries)>4096:
                    raise RuntimeError('private process namespace inventory is unbounded')
    except OSError as error:
        raise RuntimeError('cannot enumerate private process namespace') from error
    pids=[]
    for name in entries:
        if name.isdigit():
            pids.append(int(name))
            if len(pids)>1024:
                raise RuntimeError('private process namespace inventory is unbounded')
    probe_pid=os.getpid()
    expected={1,ENTRYPOINT_PID,probe_pid}
    if (type(api_pid) is not int or api_pid<=0 or api_pid in expected
            or len(expected)!=3 or set(pids) not in (expected,expected|{api_pid})):
        raise RuntimeError('private process namespace differs from init, entrypoint, this probe, and optional pinned API zombie')
    observed=[]
    for pid in sorted(pids):
        base='/proc/'+str(pid)
        try:
            raw=read_proc_file(base+'/cmdline','process command line')
            argv=[part.decode('utf-8','strict') for part in raw.split(b'\0') if part]
            parent,state=proc_status(pid)
        except (OSError,UnicodeDecodeError,ValueError) as error:
            raise RuntimeError('private process namespace identity is incomplete') from error
        if pid==api_pid:
            try:
                os.readlink(base+'/exe')
            except FileNotFoundError:
                executable=None
            except OSError as error:
                raise RuntimeError('pinned API process executable observation failed') from error
            else:
                raise RuntimeError('pinned API process is still live')
            if state!='Z' or parent!=ENTRYPOINT_PID or raw!=b'':
                raise RuntimeError('extra API PID is not the exact exited-child zombie')
        else:
            try:
                executable=os.readlink(base+'/exe')
            except OSError as error:
                raise RuntimeError('private process executable identity is incomplete') from error
            if state=='Z':
                raise RuntimeError('an unexpected private process is a zombie')
        if pid==1:
            if executable!='/usr/sbin/docker-init' or parent!=0:
                raise RuntimeError('PID 1 is not the expected private docker-init')
        elif pid==ENTRYPOINT_PID:
            if (executable!='/usr/local/bin/python3.10' or parent!=1
                    or argv!=['/usr/local/bin/python3','/opt/fullmag/entrypoint.py']):
                raise RuntimeError('entrypoint process identity differs from the retained backend')
        elif pid==api_pid:
            # This exact already-exited API child may remain a zombie until
            # the entrypoint reaps it. Its identity was checked above; no other zombie
            # or missing executable is admitted here.
            pass
        else:
            if (executable!='/usr/local/bin/python3.10' or len(argv)!=4
                    or argv[0]!='/usr/local/bin/python3' or argv[1:3]!=['-B','-c']
                    or PROBE_MARKER not in argv[3]):
                raise RuntimeError('the sole extra process is not this bounded managed probe')
        observed.append({'pid':pid,'ppid':parent,'state':state,'exe':executable,'argv':argv})
    return observed

if os.environ.get('FULLMAG_HOST_LEDGER_ROOT',CANONICAL_LEDGER)!=CANONICAL_LEDGER:
    raise RuntimeError('host ledger root override differs from the canonical mount')
if os.environ.get('FULLMAG_RUNTIME_PROCESS_RECEIPT',CANONICAL_RECEIPT)!=CANONICAL_RECEIPT:
    raise RuntimeError('runtime process receipt override differs from the canonical path')
sys.path.insert(0,'/opt/fullmag')
import runtime_service
paths=runtime_service.canonical_paths()
receipt_path=runtime_service.process_receipt_path(paths)
owner_path=runtime_service.runtime_services_root(paths)/'OWNER.json'
if str(receipt_path)!=CANONICAL_RECEIPT or str(owner_path)!=CANONICAL_OWNER:
    raise RuntimeError('runtime service returned a noncanonical receipt or owner path')
receipt_raw=read_raw(receipt_path,'runtime process receipt',MAX_RECEIPT)
receipt=read_document(receipt_raw,'runtime process receipt')
if (receipt.get('schema')!='fullmag.docker-process-tree.v1'
        or receipt.get('state')!='failed_outcome_retained'
        or receipt.get('api_shutdown')!='unknown'
        or 'api_exit_code' in receipt
        or receipt.get('runtime_pid') is not None
        or 'terminal_service_owner' in receipt
        or 'startup_activation' in receipt):
    raise RuntimeError('process receipt is outside the exact unknown-owner retained failure state')
error=receipt.get('error')
if not isinstance(error,str) or re.fullmatch(ERROR_PATTERN,error) is None:
    raise RuntimeError('process receipt does not prove the exact after-READY API supervision timeout')
api_pid=receipt.get('api_pid')
if type(api_pid) is not int or api_pid<=0:
    raise RuntimeError('retained process receipt has no positive API pid')
ready_owner=receipt.get('service_owner')
if not isinstance(ready_owner,dict):
    raise RuntimeError('unknown-owner route has no retained Ready identity')
runtime_service._validate_terminal_owner(ready_owner,state='ready',name='retained ready service owner')
owner_raw=read_raw(owner_path,'runtime service OWNER')
owner=read_document(owner_raw,'runtime service OWNER')
if (owner.get('schema_version')!='runtime_service_owner.v1'
        or owner.get('protocol')!='stdin-v1'
        or owner.get('state')!='unknown'
        or owner.get('target_id')!='docker-all'):
    raise RuntimeError('current OWNER is not the exact retained unknown owner')
children=owner.get('children')
if not isinstance(children,list) or len(children)!=2:
    raise RuntimeError('unknown OWNER does not contain exactly two terminal children')
roles=set(); child_pids=set()
for child in children:
    if not isinstance(child,dict):
        raise RuntimeError('unknown OWNER child is invalid')
    role=child.get('role'); pid=child.get('pid'); status=child.get('status')
    if (role not in {'compute','preparation'} or role in roles
            or type(pid) is not int or pid<=0 or pid in child_pids
            or status not in {'exited_success','exited_failure'}):
        raise RuntimeError('unknown OWNER child identity or terminal status is invalid')
    roles.add(role); child_pids.add(pid)
if roles!={'compute','preparation'}:
    raise RuntimeError('unknown OWNER is missing a scheduler child')
owner_ready=dict(owner)
owner_ready['state']='ready'
owner_ready['children']=[dict(child,status='running') for child in children]
runtime_service._validate_terminal_owner(owner_ready,state='ready',name='retained unknown owner identity')
if (runtime_service._owner_identity(ready_owner)!=runtime_service._owner_identity(owner)
        or runtime_service._owner_child_identity(ready_owner)!=runtime_service._owner_child_identity(owner)):
    raise RuntimeError('unknown OWNER identity differs from the retained Ready identity')
if os.environ.get('FULLMAG_STARTUP_ENABLED')=='1' or os.path.lexists('/state/.fullmag/docker-startup/activation.json'):
    raise RuntimeError('startup activation is outside the quiescent unknown-owner route')
processes=process_inventory(api_pid)
namespace_pids={item['pid'] for item in processes}
if owner['pid'] in namespace_pids or child_pids.intersection(namespace_pids):
    raise RuntimeError('owner or scheduler child PID appears in the private namespace')
api_pid_zombie=any(item['pid']==api_pid and item['state']=='Z' for item in processes)
reservation_states=scan_ledger()
lease_states=scan_leases(paths.store)
if (any(state!='released' for state in reservation_states)
        or any(state!='released' for state in lease_states)):
    raise RuntimeError('host resource reservations or accepted-store leases are not all released')
print(json.dumps({
 'schema':'fullmag.docker-quiescent-unknown-owner-stop-probe.v1',
 'process_receipt_sha256':hashlib.sha256(receipt_raw).hexdigest(),
 'process_receipt_raw_base64':base64.b64encode(receipt_raw).decode('ascii'),
 'api_pid':api_pid,
 'owner_sha256':hashlib.sha256(owner_raw).hexdigest(),
 'owner':owner,
 'ready_owner':ready_owner,
 'api_pid_exists':api_pid in namespace_pids,
 'api_pid_live':False,
 'api_pid_zombie':api_pid_zombie,
 'owner_pid_exists':False,
 'child_pids_exist':False,
 'process_inventory':processes,
 'startup_enabled':os.environ.get('FULLMAG_STARTUP_ENABLED'),
 'legacy_activation_marker_exists':False,
 'reservation_states':reservation_states,
 'lease_states':lease_states,
 'writer_locks':['host-ledger-writer','accepted-store-writer'],
},sort_keys=True))
'''


def _capture_quiescent_unknown_owner_probe(container_id: str) -> dict[str, object]:
    result = docker_capture(
        'exec', container_id, '/usr/local/bin/python3', '-B', '-c',
        _quiescent_unknown_owner_probe_script(), timeout=90,
    )
    if result.returncode:
        raise BuildControlError(
            'quiescent unknown-owner proof probe failed: '
            + result.stderr.decode('utf-8', 'replace')[-4096:]
        )
    try:
        probe = json.loads(result.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError('quiescent unknown-owner probe returned invalid JSON') from error
    if not isinstance(probe, dict):
        raise BuildControlError('quiescent unknown-owner probe is not an object')
    return probe


def _validate_quiescent_unknown_owner_probe(
    probe: Mapping[str, object], expected_process_receipt_sha256: str,
) -> dict[str, object]:
    if probe.get('schema') != QUIESCENT_UNKNOWN_OWNER_PROBE_SCHEMA:
        raise BuildControlError('quiescent unknown-owner probe schema differs')
    receipt_sha = probe.get('process_receipt_sha256')
    owner_sha = probe.get('owner_sha256')
    if (receipt_sha != expected_process_receipt_sha256
            or not isinstance(owner_sha, str) or re.fullmatch(r'[0-9a-f]{64}', owner_sha) is None):
        raise BuildControlError('quiescent unknown-owner raw receipt pins differ')
    receipt_raw_b64 = probe.get('process_receipt_raw_base64')
    owner = probe.get('owner')
    ready_owner = probe.get('ready_owner')
    if not isinstance(receipt_raw_b64, str) or not isinstance(owner, Mapping):
        raise BuildControlError('quiescent unknown-owner probe omitted raw documents')
    try:
        receipt_raw = base64.b64decode(receipt_raw_b64, validate=True)
        receipt = json.loads(receipt_raw.decode('utf-8'))
    except (binascii.Error, UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise BuildControlError('quiescent unknown-owner process receipt raw bytes are invalid') from error
    if (len(receipt_raw) > QUIESCENT_UNKNOWN_OWNER_RECEIPT_MAX_BYTES
            or base64.b64encode(receipt_raw).decode('ascii') != receipt_raw_b64
            or hashlib.sha256(receipt_raw).hexdigest() != receipt_sha
            or not isinstance(receipt, dict)):
        raise BuildControlError('quiescent unknown-owner raw process receipt pins differ')
    if (receipt.get('schema') != 'fullmag.docker-process-tree.v1'
            or receipt.get('state') != 'failed_outcome_retained'
            or receipt.get('api_shutdown') != 'unknown'
            or 'api_exit_code' in receipt
            or receipt.get('runtime_pid') is not None
            or 'terminal_service_owner' in receipt
            or 'startup_activation' in receipt
            or receipt.get('service_owner') != ready_owner):
        raise BuildControlError('process receipt is outside the exact unknown-owner state')
    error = receipt.get('error')
    if (not isinstance(error, str)
            or re.fullmatch(QUIESCENT_AFTER_READY_ERROR_PATTERN, error) is None):
        raise BuildControlError('process receipt does not prove the exact after-READY API supervision timeout')
    if type(receipt.get('api_pid')) is not int or receipt['api_pid'] <= 0:
        raise BuildControlError('quiescent process receipt has no positive API pid')
    if not isinstance(ready_owner, Mapping):
        raise BuildControlError('quiescent process receipt has no retained Ready owner')
    ready = _validate_native_ready_owner(ready_owner)
    unknown = dict(owner)
    if (unknown.get('schema_version') != 'runtime_service_owner.v1'
            or unknown.get('protocol') != 'stdin-v1'
            or unknown.get('state') != 'unknown'
            or unknown.get('target_id') != 'docker-all'):
        raise BuildControlError('current OWNER is not the expected unknown owner')
    children = unknown.get('children')
    if not isinstance(children, list) or len(children) != 2:
        raise BuildControlError('unknown OWNER does not have exactly two terminal children')
    roles: set[object] = set()
    child_pids: set[int] = set()
    for child in children:
        if not isinstance(child, Mapping):
            raise BuildControlError('unknown OWNER child is invalid')
        role = child.get('role')
        pid = child.get('pid')
        if (role not in {'compute', 'preparation'} or role in roles
                or type(pid) is not int or pid <= 0 or pid in child_pids
                or child.get('status') not in {'exited_success', 'exited_failure'}):
            raise BuildControlError('unknown OWNER child identity or terminal status is invalid')
        roles.add(role)
        child_pids.add(pid)
    if roles != {'compute', 'preparation'}:
        raise BuildControlError('unknown OWNER child roles are incomplete')
    normalized_unknown = dict(unknown)
    normalized_unknown['state'] = 'ready'
    normalized_unknown['children'] = [dict(child, status='running') for child in children]
    normalized_unknown = _validate_native_ready_owner(normalized_unknown)
    if _owner_identity_key(ready, 'retained Ready owner') != _owner_identity_key(
            normalized_unknown, 'current unknown owner'):
        raise BuildControlError('unknown OWNER identity differs from retained Ready identity')
    if probe.get('owner_pid_exists') is not False or probe.get('child_pids_exist') is not False:
        raise BuildControlError('owner or scheduler child is still live')
    if probe.get('startup_enabled') == '1' or probe.get('legacy_activation_marker_exists') is not False:
        raise BuildControlError('startup activation is outside the quiescent unknown-owner route')
    if probe.get('writer_locks') != ['host-ledger-writer', 'accepted-store-writer']:
        raise BuildControlError('quiescent proof did not acquire both writer locks')
    reservations = probe.get('reservation_states')
    leases = probe.get('lease_states')
    if not isinstance(reservations, list) or any(state != 'released' for state in reservations):
        raise BuildControlError('host resource reservations are not all released')
    if not isinstance(leases, list) or any(state != 'released' for state in leases):
        raise BuildControlError('accepted-store leases are not all released')
    inventory = probe.get('process_inventory')
    api_pid = receipt.get('api_pid')
    if (not isinstance(inventory, list) or len(inventory) not in {3, 4}
            or type(api_pid) is not int or probe.get('api_pid') != api_pid):
        raise BuildControlError('private process inventory is not exact init, entrypoint, probe, and optional pinned API zombie')
    by_pid: dict[int, Mapping[str, object]] = {}
    for process in inventory:
        if not isinstance(process, Mapping) or type(process.get('pid')) is not int or process['pid'] in by_pid:
            raise BuildControlError('private process inventory has an invalid PID record')
        if (type(process.get('ppid')) is not int or not isinstance(process.get('state'), str)
                or not isinstance(process.get('argv'), list)
                or any(not isinstance(argument, str) for argument in process['argv'])):
            raise BuildControlError('private process inventory record has invalid types')
        if process['pid'] == api_pid:
            if (process.get('state') != 'Z' or process.get('ppid') != 7
                    or process.get('exe') is not None or process.get('argv') != []):
                raise BuildControlError('extra API PID is not the exact pinned child zombie')
        elif not isinstance(process.get('exe'), str) or process.get('state') == 'Z':
            raise BuildControlError('non-API private process is missing its executable or is a zombie')
        by_pid[process['pid']] = process
    if not {1, 7}.issubset(by_pid):
        raise BuildControlError('private process inventory is missing PID 1 or entrypoint PID 7')
    api_pid_zombie = api_pid in by_pid
    if (probe.get('api_pid_exists') is not api_pid_zombie
            or probe.get('api_pid_zombie') is not api_pid_zombie
            or probe.get('api_pid_live') is not False):
        raise BuildControlError('pinned API PID liveness differs from the process inventory')
    if (by_pid[1].get('exe') != '/usr/sbin/docker-init'
            or by_pid[1].get('ppid') != 0
            or by_pid[7].get('exe') != '/usr/local/bin/python3.10'
            or by_pid[7].get('ppid') != 1
            or by_pid[7].get('argv') != ['/usr/local/bin/python3', '/opt/fullmag/entrypoint.py']):
        raise BuildControlError('private PID 1 or entrypoint identity differs')
    probe_processes = [process for pid, process in by_pid.items() if pid not in {1, 7}]
    probe_processes = [process for process in probe_processes if process.get('pid') != api_pid]
    if len(probe_processes) != 1:
        raise BuildControlError('private process inventory has another non-API process')
    probe_process = probe_processes[0]
    probe_argv = probe_process.get('argv')
    if (probe_process.get('exe') != '/usr/local/bin/python3.10'
            or not isinstance(probe_argv, list) or len(probe_argv) != 4
            or probe_argv[:3] != ['/usr/local/bin/python3', '-B', '-c']
            or not isinstance(probe_argv[3], str)
            or 'FULLMAG_QUIESCENT_UNKNOWN_OWNER_STOP_PROBE_V1' not in probe_argv[3]):
        raise BuildControlError('private namespace extra process is not the managed probe')
    pids = set(by_pid)
    owner_pid = unknown.get('pid')
    if type(owner_pid) is not int or owner_pid in pids or child_pids.intersection(pids):
        raise BuildControlError('owner or scheduler child PID appears in the private namespace')
    return {
        'receipt': dict(receipt),
        'receipt_raw': receipt_raw,
        'owner': unknown,
        'ready_owner': ready,
        'probe': dict(probe),
    }


def _quiescent_unknown_owner_probe_cas(probe: Mapping[str, object]) -> str:
    """Compare all proof pins while allowing the short-lived probe PID to change."""

    stable = dict(probe)
    inventory = stable.get('process_inventory')
    if not isinstance(inventory, list):
        raise BuildControlError('quiescent process inventory is missing during CAS')
    stable_inventory=[]
    for item in inventory:
        if not isinstance(item, Mapping):
            continue
        pid=item.get('pid')
        if pid in {1,7}:
            stable_process=dict(item)
            stable_process.pop('state',None)
            stable_inventory.append(stable_process)
        elif pid==probe.get('api_pid'):
            stable_inventory.append(dict(item))
    stable['process_inventory']=stable_inventory
    return json.dumps(stable, sort_keys=True, separators=(',', ':'))


def _inspect_quiescent_backend(container_id: str, image_id: str, identity: Mapping[str, object], started_at: str | None = None, *, running: bool | None = True) -> dict[str, object]:
    result = docker_capture('inspect', container_id, timeout=5)
    try:
        records = json.loads(result.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError('Docker inspect returned invalid backend identity') from error
    if not isinstance(records, list) or len(records) != 1 or not isinstance(records[0], dict):
        raise BuildControlError('Docker inspect did not return exactly one backend')
    actual = records[0]
    state = actual.get('State')
    labels = (actual.get('Config') or {}).get('Labels') or {}
    if (actual.get('Id') != container_id or actual.get('Image') != image_id
            or labels.get('com.docker.compose.project') != identity['project_name']
            or labels.get('com.docker.compose.service') != 'backend'):
        raise BuildControlError('quiescent stop Docker identity or Compose service differs')
    validate_source_labels(actual, identity)
    if (not isinstance(state, dict) or type(state.get('Running')) is not bool
            or (running is not None and state.get('Running') is not running)
            or state.get('OOMKilled') is not False):
        raise BuildControlError('quiescent stop requires the exact non-OOM backend state')
    actual_started = state.get('StartedAt')
    if not isinstance(actual_started, str) or not actual_started or (started_at is not None and actual_started != started_at):
        raise BuildControlError('quiescent stop backend StartedAt changed or is missing')
    if (actual.get('HostConfig') or {}).get('PidMode') not in {'', 'private'}:
        raise BuildControlError('quiescent stop requires the private Docker PID namespace')
    pid = state.get('Pid')
    if type(pid) is not int or (state['Running'] and pid <= 0) or (not state['Running'] and pid != 0):
        raise BuildControlError('quiescent stop backend PID does not match its Docker state')
    return actual


def _require_quiescent_failure_log(container_id: str, started_at: str) -> str:
    result = docker_capture('logs', '--since', started_at, '--tail', '100', container_id, timeout=15)
    logs = (result.stdout + result.stderr).decode('utf-8', 'replace')
    if 'Startup or runtime failed; admission closed:' not in logs:
        raise BuildControlError('this exact backend incarnation has no confirmed failed-admission event')
    return hashlib.sha256((result.stdout + result.stderr)).hexdigest()


def _copy_stopped_container_file(container_id: str, path: str, label: str) -> bytes:
    result = docker_capture('cp', f'{container_id}:{path}', '-', timeout=30)
    if result.returncode:
        raise BuildControlError(f'could not read stopped {label} from its exact container')
    if len(result.stdout) > 8 * 1024 * 1024:
        raise BuildControlError(f'stopped {label} archive exceeds its bound')
    try:
        with tarfile.open(fileobj=io.BytesIO(result.stdout), mode='r:') as archive:
            members = archive.getmembers()
            if len(members) != 1:
                raise BuildControlError(f'stopped {label} archive has an unexpected member set')
            member = members[0]
            clean_name = member.name.removeprefix('./')
            clean_parts = clean_name.split('/')
            if (not member.isreg() or member.size > 8 * 1024 * 1024
                    or clean_parts[-1] != path.rsplit('/', 1)[-1]
                    or any(part in {'', '.', '..'} for part in clean_parts)):
                raise BuildControlError(f'stopped {label} archive member is not the exact bounded file')
            stream = archive.extractfile(member)
            if stream is None:
                raise BuildControlError(f'stopped {label} archive member cannot be read')
            raw = stream.read(member.size + 1)
            if len(raw) != member.size:
                raise BuildControlError(f'stopped {label} archive member size differs')
            return raw
    except (tarfile.TarError, OSError) as error:
        raise BuildControlError(f'stopped {label} archive is invalid') from error


def _validate_quiescent_post_documents(
    process_raw: bytes, owner_raw: bytes, before: Mapping[str, object],
) -> tuple[dict[str, object], dict[str, object]]:
    try:
        receipt = json.loads(process_raw.decode('utf-8'))
        owner = json.loads(owner_raw.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError('stopped process receipt or OWNER is invalid JSON') from error
    before_receipt = before['receipt']
    before_receipt_raw = before.get('receipt_raw')
    before_owner = before['owner']
    if not isinstance(receipt, dict) or not isinstance(owner, dict):
        raise BuildControlError('stopped process receipt or OWNER is not an object')
    if not isinstance(before_receipt_raw, bytes):
        raise BuildControlError('pre-stop process receipt raw bytes are unavailable')
    unchanged_receipt = process_raw == before_receipt_raw
    natural_shutdown_receipt = False
    if not unchanged_receipt:
        api_exit_code = receipt.get('api_exit_code')
        shutdown_error = receipt.get('shutdown_error')
        expected_receipt = dict(before_receipt)
        expected_receipt.update(
            state='shutdown_unknown',
            api_exit_code=api_exit_code,
            shutdown_error=shutdown_error,
        )
        natural_shutdown_receipt = (
            type(api_exit_code) is int
            and isinstance(shutdown_error, str)
            and bool(shutdown_error)
            and receipt == expected_receipt
        )
    if not (unchanged_receipt or natural_shutdown_receipt):
        raise BuildControlError('stopped process receipt no longer preserves its historical unknown outcome')
    if (owner.get('schema_version') != 'runtime_service_owner.v1'
            or owner.get('protocol') != 'stdin-v1'
            or owner.get('state') != 'unknown'
            or owner != before_owner
            or _owner_identity_key(owner, 'stopped unknown OWNER') != _owner_identity_key(before_owner, 'before unknown OWNER')
            or owner.get('children') != before_owner.get('children')):
        raise BuildControlError('stopped OWNER no longer preserves the historical unknown owner')
    return receipt, owner


def _start_quiescent_control_lock(control: BuildControl, inputs: Mapping[str, object]) -> dict[str, object]:
    phase = 'quiescent-stop'
    token = uuid.uuid4().hex
    root = f'{phase}/attempts/{token}'
    name = 'fullmag-control-' + token
    receipt: dict[str, object] = {
        'schema': 'fullmag.docker-build-operation.v1',
        'phase': phase,
        'state': 'starting',
        'attempt': token,
        'compose_project': control.project,
        'control_volume': control.volume,
        'helper_container': name,
        'inputs': dict(inputs),
        'started_at': time.time(),
        'build_data_qualification': 'NOT VERIFIED',
        'purpose': 'bounded quiescent unknown-owner namespace stop; no restart',
    }
    if control.namespace:
        receipt.update(control_namespace=control.namespace,
                       namespace_registry_sha256=control.namespace_registry_sha256)
    logger = subprocess.Popen(
        control.helper_args(control.operation_script(phase, token), name=name),
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    line = BuildControl._line(logger)
    if line != 'READY':
        try:
            logger.wait(timeout=10)
        except subprocess.TimeoutExpired:
            pass
        raise BuildControlError('managed stop-operation serialization was not admitted')
    operation = {'root': root, 'logger': logger, 'receipt': receipt, 'daemon_pending': False}
    try:
        control.write(root + '/receipt.json', receipt)
    except Exception as error:
        try:
            _finish_quiescent_control_lock(control, operation, succeeded=False, error=str(error))
        except Exception:
            pass
        raise
    return operation


def _finish_quiescent_control_lock(
    control: BuildControl, operation: Mapping[str, object], *, succeeded: bool, error: str | None = None,
) -> None:
    receipt = operation['receipt']
    logger = operation['logger']
    if not isinstance(receipt, dict) or not isinstance(logger, subprocess.Popen):
        raise BuildControlError('managed stop-operation lock state is invalid')
    receipt['state'] = 'succeeded' if succeeded else 'failed-confirmed'
    receipt['finished_at'] = time.time()
    if error:
        receipt['error'] = error[:2048]
    if logger.stdin is not None and not logger.stdin.closed:
        logger.stdin.close()
    if BuildControl._line(logger) != 'LOGGED':
        raise BuildControlError('managed stop-operation log was not acknowledged')
    control.write(operation['root'] + '/receipt.json', receipt)
    control.write(operation['root'] + '/terminal.json', receipt)
    if logger.wait(timeout=30) != 0:
        raise BuildControlError('managed stop-operation lock did not finalize')


def _retain_unknown_quiescent_outcome(control: BuildControl, operation: Mapping[str, object], error: BaseException) -> None:
    receipt = operation.get('receipt')
    if isinstance(receipt, dict):
        receipt['state'] = 'outcome-unknown-resources-retained'
        receipt['error'] = str(error)[:2048]
        receipt['finished_at'] = time.time()
        try:
            control.write(operation['root'] + '/receipt.json', receipt)
        except Exception:
            pass
    journal_path = operation.get('journal_path')
    if isinstance(journal_path, str):
        try:
            journal = control.read(journal_path, optional=True)
            if isinstance(journal, dict) and journal.get('state') != 'stopped-confirmed':
                journal['state'] = 'stop-outcome-unknown'
                journal['signal_outcome'] = journal.get('signal_outcome', 'unknown')
                journal['observation_error'] = str(error)[:2048]
                control.write(journal_path, journal)
        except Exception:
            pass
    # Keep the image-owned active marker and advisory lock. A later invocation
    # must observe and reconcile the existing intent; it must never re-send TERM.


def _stop_quiescent_unknown_owner(args: argparse.Namespace, selected: Path, identity: Mapping[str, object], initial: dict[str, object]) -> int:
    container_id = args.container_id
    image_id = args.image_id
    initial_state = initial.get('State')
    if not isinstance(initial_state, dict):
        raise BuildControlError('quiescent stop backend has no Docker state')
    started_at = initial_state.get('StartedAt')
    if not isinstance(started_at, str) or not started_at:
        raise BuildControlError('quiescent stop backend has no StartedAt pin')
    _inspect_quiescent_backend(container_id, image_id, identity, started_at, running=True)
    initial_log_sha = _require_quiescent_failure_log(container_id, started_at)
    first_probe = _capture_quiescent_unknown_owner_probe(container_id)
    first = _validate_quiescent_unknown_owner_probe(first_probe, args.process_receipt_sha256)
    from docker_build_control import toolchain_configuration
    config = toolchain_configuration(selected, identity)
    control = BuildControl(identity, config['services']['fem-gpu-toolchain']['build']['args']['FULLMAG_CUDA_BASE_IMAGE'])
    journal_path = 'verification/quiescent-unknown-owner-stop-' + container_id + '.json'
    journal = {
        'schema': QUIESCENT_UNKNOWN_OWNER_JOURNAL_SCHEMA,
        'state': 'term-signal-armed',
        'stop_kind': 'quiescent_unknown_owner_namespace_stop',
        'container_id': container_id,
        'image_id': image_id,
        'started_at': started_at,
        'failure_log_sha256': initial_log_sha,
        'process_receipt_before_sha256': first_probe['process_receipt_sha256'],
        'owner_before_sha256': first_probe['owner_sha256'],
        'quiescent_unknown_owner_probe': {
            key: value for key, value in first_probe.items()
            if key not in {'process_receipt_raw_base64', 'owner', 'ready_owner'}
        },
        'historical_process_receipt_raw_base64': base64.b64encode(first['receipt_raw']).decode('ascii'),
        'retained_ready_owner': first['ready_owner'],
        'historical_unknown_owner': first['owner'],
        'authenticated_native_drain': False,
        'restart_performed': False,
        'signal': 'SIGTERM',
    }
    operation = _start_quiescent_control_lock(control, {
        'container_id': container_id,
        'image_id': image_id,
        'started_at': started_at,
        'process_receipt_sha256': args.process_receipt_sha256,
        'owner_sha256': first_probe['owner_sha256'],
    })
    try:
        if control.read(journal_path, optional=True) is not None:
            raise BuildControlError('quiescent stop journal already exists; signal replay is forbidden')
        # Repeat Docker, failure-log, OWNER/receipt, lease, ledger, and exact
        # private-namespace inventory checks immediately before arming TERM.
        _inspect_quiescent_backend(container_id, image_id, identity, started_at, running=True)
        rechecked_log_sha = _require_quiescent_failure_log(container_id, started_at)
        second_probe = _capture_quiescent_unknown_owner_probe(container_id)
        second = _validate_quiescent_unknown_owner_probe(second_probe, args.process_receipt_sha256)
        if (_quiescent_unknown_owner_probe_cas(second_probe) != _quiescent_unknown_owner_probe_cas(first_probe)
                or second['owner'] != first['owner']
                or second['ready_owner'] != first['ready_owner'] or rechecked_log_sha != initial_log_sha):
            raise BuildControlError('quiescent proof changed during pre-signal revalidation')
        pinned = _inspect_quiescent_backend(container_id, image_id, identity, started_at, running=True)
        journal['docker_before'] = {
            'id': pinned.get('Id'), 'image': pinned.get('Image'), 'started_at': started_at,
            'pid_mode': (pinned.get('HostConfig') or {}).get('PidMode'),
        }
        journal['term_command_armed'] = True
        journal['signal_outcome'] = 'unknown-until-observed'
        serialized_journal = canonical(journal) + b'\n'
        if len(serialized_journal) > MAX_DOCUMENT_BYTES:
            raise BuildControlError('quiescent stop journal exceeds the BuildControl document limit')
        control.write(journal_path, journal)
        operation['daemon_pending'] = True
        operation['journal_path'] = journal_path
        try:
            signal_result = docker_capture('kill', '--signal', 'TERM', container_id, timeout=30)
        except Exception as error:
            journal['state'] = 'stop-outcome-unknown'
            journal['signal_error'] = str(error)[:2048]
            try:
                control.write(journal_path, journal)
            finally:
                raise BuildControlError('SIGTERM outcome is unknown; no retry was attempted') from error
        if signal_result.returncode != 0:
            journal['state'] = 'stop-outcome-unknown'
            journal['signal_outcome'] = 'client-reported-failure-or-unknown'
            journal['signal_error'] = signal_result.stderr.decode('utf-8', 'replace')[-2048:]
            control.write(journal_path, journal)
            raise BuildControlError('SIGTERM was not confirmed; no retry was attempted')
        journal['state'] = 'term-signal-accepted'
        journal['signal_outcome'] = 'accepted'
        journal['signal_accepted'] = True
        control.write(journal_path, journal)
        deadline = time.monotonic() + 45
        after = None
        while time.monotonic() < deadline:
            observed = _inspect_quiescent_backend(container_id, image_id, identity, started_at, running=None)
            if observed['State'].get('Running') is False:
                after = observed
                break
            time.sleep(.25)
        if after is None:
            journal['state'] = 'stop-outcome-unknown'
            journal['observation_error'] = 'bounded TERM observation expired while backend remained running'
            control.write(journal_path, journal)
            raise BuildControlError('backend did not stop within the bounded TERM window; no retry was attempted')
        state = after['State']
        exit_code = state.get('ExitCode')
        if (state.get('Running') is not False or state.get('Status') != 'exited' or state.get('OOMKilled') is not False
                or state.get('Pid') != 0 or type(exit_code) is not int or exit_code == 137):
            journal['state'] = 'stop-outcome-unknown'
            journal['observation_error'] = 'stopped backend did not satisfy exact non-OOM/non-137 Docker evidence'
            control.write(journal_path, journal)
            raise BuildControlError('stopped backend does not meet the confirmed namespace-stop contract')
        process_raw = _copy_stopped_container_file(container_id, CANONICAL_PROCESS_RECEIPT, 'process receipt')
        owner_raw = _copy_stopped_container_file(container_id, CANONICAL_RUNTIME_OWNER, 'OWNER')
        post_receipt, post_owner = _validate_quiescent_post_documents(process_raw, owner_raw, first)
        process_after_sha = hashlib.sha256(process_raw).hexdigest()
        owner_after_sha = hashlib.sha256(owner_raw).hexdigest()
        final_after = _inspect_quiescent_backend(container_id, image_id, identity, started_at, running=False)
        final_state = final_after['State']
        if (final_state.get('Status') != 'exited' or final_state.get('OOMKilled') is not False
                or final_state.get('Pid') != 0 or final_state.get('ExitCode') != exit_code
                or final_state.get('FinishedAt') != state.get('FinishedAt')):
            raise BuildControlError('backend Docker state changed after stopped receipt/OWNER capture')
        journal.update(
            state='stopped-confirmed',
            exit_code=exit_code,
            process_receipt_after_sha256=process_after_sha,
            owner_after_sha256=owner_after_sha,
            process_receipt_after=post_receipt,
            owner_after=post_owner,
            container_state={
                'id': final_after.get('Id'), 'image': final_after.get('Image'),
                'started_at': final_state.get('StartedAt'), 'finished_at': final_state.get('FinishedAt'),
                'pid': final_state.get('Pid'), 'oom_killed': final_state.get('OOMKilled'),
                'exit_code': exit_code,
            },
            authenticated_native_drain=False,
            restart_performed=False,
        )
        control.write(journal_path, journal)
        operation['receipt'].update(state='succeeded', stop_journal=journal_path,
                                    process_receipt_after_sha256=process_after_sha,
                                    owner_after_sha256=owner_after_sha)
        _finish_quiescent_control_lock(control, operation, succeeded=True)
        print(json.dumps({'state': 'stopped-confirmed', 'container_id': container_id,
                          'authenticated_native_drain': False, 'restart_performed': False}))
        return 0
    except BaseException as error:
        if operation.get('daemon_pending'):
            _retain_unknown_quiescent_outcome(control, operation, error)
        else:
            try:
                _finish_quiescent_control_lock(control, operation, succeeded=False, error=str(error))
            except Exception:
                pass
        raise


def _native_failure_probe_cas(probe: Mapping[str, object]) -> tuple[object, ...]:
    """Return the receipt/OWNER raw-byte CAS pins used by pre-stop revalidation."""

    return (
        probe.get('process_receipt_sha256'),
        probe.get('process_receipt'),
        probe.get('failed_owner_sha256'),
        probe.get('failed_owner'),
    )


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root',type=Path,required=True)
    parser.add_argument('--container-id',required=True)
    parser.add_argument('--image-id',required=True)
    parser.add_argument('--process-receipt-sha256',required=True)
    parser.add_argument('--quiescent-unknown-owner', action='store_true',
                        help='use the explicit read-only-quiescence plus SIGTERM namespace-stop variant')
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
    if args.quiescent_unknown_owner:
        return _stop_quiescent_unknown_owner(args, selected, identity, actual)
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
