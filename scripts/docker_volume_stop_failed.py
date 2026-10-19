"""Stop one pinned DEV supervisor only after failed admission reaped its API."""
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
def _validate_native_failed_owner(owner: object) -> dict[str, object]:
    """Validate the terminal native owner shape at the operator boundary."""

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
        if status != "exited_success":
            raise BuildControlError("native failed owner has a live or unknown child")
        roles.add(role)
        pids.add(pid)
    if roles != {"compute", "preparation"}:
        raise BuildControlError("native failed owner is missing compute or preparation")
    return dict(owner)


def _validate_native_failure_probe(
    probe: Mapping[str, object], expected_process_receipt_sha256: str
) -> dict[str, object]:
    """Validate the bounded in-container proof before stopping PID 1."""

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
    if receipt.get("runtime_pid") is not None:
        raise BuildControlError("native failure still has a runtime pid")
    if "service_owner" in receipt or "terminal_service_owner" in receipt:
        raise BuildControlError("native failure receipt already contains an owner transition")
    if probe.get("api_pid_exists") is not False:
        raise BuildControlError("native failure API process is still live")
    if probe.get("native_processes_live") is not False:
        raise BuildControlError("native failed owner or child is still live")
    if probe.get("startup_enabled") == "1" or probe.get("legacy_activation_marker_exists") is True:
        raise BuildControlError("internal startup activation is outside the native failure route")
    owner = _validate_native_failed_owner(probe.get("failed_owner"))
    if probe.get("active_lease_count") != 0:
        raise BuildControlError("native failure still has an active durable resource lease")
    reservation_states = probe.get("reservation_states")
    if not isinstance(reservation_states, list) or any(state != "released" for state in reservation_states):
        raise BuildControlError("native failure host ledger is not fully released")
    lease_states = probe.get("lease_states")
    if not isinstance(lease_states, list) or any(state != "released" for state in lease_states):
        raise BuildControlError("native failure session leases are not fully released")
    return {"receipt": dict(receipt), "failed_owner": owner, "probe": dict(probe)}


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
if 'service_owner' in receipt or 'terminal_service_owner' in receipt:
    raise RuntimeError('retained native failure already contains an owner transition')
api_pid=receipt.get('api_pid')
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
for child in children:
    if not isinstance(child,dict):
        raise RuntimeError('failed runtime service owner child is invalid')
    role=child.get('role'); pid=child.get('pid'); status=child.get('status')
    if role not in {'compute','preparation'} or role in roles or type(pid) is not int or pid <= 0 or pid in pids or status != 'exited_success':
        raise RuntimeError('failed runtime service owner child identity/status is invalid')
    roles.add(role); pids.add(pid)
    if os.path.exists('/proc/'+str(pid)):
        live.append(pid)
if roles != {'compute','preparation'}:
    raise RuntimeError('failed runtime service owner child roles are incomplete')
try:
    runtime_service._validate_terminal_owner(owner,state='failed',name='failed runtime service owner')
except Exception as error:
    raise RuntimeError('image-owned failed runtime service owner validation failed') from error
if live:
    raise RuntimeError('failed runtime service owner has live native processes')
reservation_states=scan_ledger()
lease_states=scan_leases(paths.store)
if any(state!='released' for state in reservation_states) or any(state!='released' for state in lease_states):
    raise RuntimeError('native failure has active or unknown host resource state')
print(json.dumps({'schema':'fullmag.docker-native-start-failure-stop-probe.v1','process_receipt_sha256':hashlib.sha256(receipt_raw).hexdigest(),'process_receipt':receipt,'failed_owner_sha256':hashlib.sha256(owner_raw).hexdigest(),'failed_owner':owner,'api_pid_exists':api_pid_exists,'native_processes_live':False,'startup_enabled':os.environ.get('FULLMAG_STARTUP_ENABLED'),'legacy_activation_marker_exists':os.path.lexists('/state/.fullmag/docker-startup/activation.json'),'reservation_states':reservation_states,'lease_states':lease_states,'active_lease_count':0},sort_keys=True))
'''


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
pid=document.get('api_pid')
print(json.dumps({'sha256':hashlib.sha256(raw).hexdigest(),'receipt':document,'api_pid_exists':bool(pid and os.path.exists('/proc/'+str(pid)))}))
'''
    observed=json.loads(docker_capture('exec',args.container_id,'/usr/local/bin/python3','-B','-c',script).stdout)
    receipt=observed['receipt']
    native_failure = None
    if receipt.get('state') == 'failed_outcome_retained' and 'service_owner' not in receipt:
        native_result = docker_capture(
            'exec', args.container_id, '/usr/local/bin/python3', '-B', '-c',
            _native_failure_probe_script(), timeout=90,
        )
        if native_result.returncode:
            raise BuildControlError(
                'native failed-admission proof probe failed: '
                + native_result.stderr.decode('utf-8', 'replace')[-4096:]
            )
        try:
            native_probe = json.loads(native_result.stdout)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise BuildControlError('native failed-admission proof probe returned invalid JSON') from error
        native_failure = _validate_native_failure_probe(
            native_probe, args.process_receipt_sha256
        )
    if (observed['sha256']!=args.process_receipt_sha256 or observed['api_pid_exists']
            or receipt.get('schema')!='fullmag.docker-process-tree.v1'
            or receipt.get('state')!='failed_outcome_retained'
            or not isinstance(receipt.get('api_exit_code'),int) or receipt.get('runtime_pid') is not None
            or not (receipt.get('error','').startswith('API binding did not become ready:')
                    or native_failure is not None)):
        raise BuildControlError('Failed admission is not proven; no process will be stopped')
    from docker_build_control import toolchain_configuration
    config=toolchain_configuration(selected,identity)
    control=BuildControl(identity,config['services']['fem-gpu-toolchain']['build']['args']['FULLMAG_CUDA_BASE_IMAGE'])
    journal={'schema':'fullmag.stop-failed-admission.v1','state':'stopping-confirmed-failed-supervisor',
             'container_id':args.container_id,'image_id':args.image_id,'failure_receipt':observed}
    if native_failure is not None:
        journal.update(failure_kind='native-start-failure', native_failure_probe=native_failure['probe'])
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
        if (
            not isinstance(terminal, dict)
            or terminal.get('schema') != 'fullmag.docker-process-tree.v1'
            or terminal.get('state') != 'shutdown_unknown'
            or 'startup_activation' in terminal
            or 'service_owner' in terminal
            or 'terminal_service_owner' in terminal
            or type(terminal.get('api_exit_code')) is not int
            or terminal.get('runtime_pid') is not None
        ):
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
    journal.update(state='stopped-confirmed',exit_code=after['State']['ExitCode'])
    control.write(path,journal)
    print(json.dumps({'state':journal['state'],'container_id':args.container_id}))
    return 0


if __name__=='__main__':
    raise SystemExit(main())
