"""Explicit quarantine of a removed DEV namespace; never replay its run.

Only a single held, unprepared manual run and a fully released ledger are
eligible. Original control records and Windows data remain in place. The new
namespace shares the original operation-lock inode and build/package caches.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys
import time

from docker_build_control import (
    BuildControlError, bounded_capture, canonical, control_read_script, docker_capture,
)

SCHEMA = "fullmag.docker-control-namespace-quarantine.v1"
SOURCE_TRANSFER_SCHEMA = "fullmag.docker-control-source-transfer.v1"
SOURCE_TRANSFER_STATE = "source-transferred-not-replayed"
REGISTRY_SCHEMA = "fullmag.docker-control-namespace-registry.v1"
REGISTRY_PATH = "namespaces/current.json"
HEX = re.compile(r"[0-9a-f]{32}\Z")
SHA = re.compile(r"[0-9a-f]{64}\Z")


def _raw(control, relative, optional=False):
    result = bounded_capture(control.helper_args(control_read_script(control.path(relative))),
                             data=b"", timeout=60)
    if optional and result.returncode == 44:
        return None
    if result.returncode:
        raise BuildControlError("Cannot authenticate control record: " + relative)
    return result.stdout


def _safe_relative(control, value):
    """Validate an explicit receipt path with the control-volume path rules."""
    if not isinstance(value, str):
        raise BuildControlError("Source-transfer receipt has an invalid archived path")
    absolute = control.path(value)
    if absolute != "/control/" + value:
        raise BuildControlError("Source-transfer receipt path is not canonical")
    return value


def _is_quarantined_receipt(receipt, *, namespace, project, volume,
                            worktree_id, project_id):
    """Keep the original unknown-activation quarantine contract intact."""
    return (
        isinstance(receipt, dict)
        and receipt.get("schema") == SCHEMA
        and receipt.get("state") == "quarantined-not-replayed"
        and receipt.get("namespace") == namespace
        and receipt.get("compose_project") == project
        and receipt.get("control_volume") == volume
        and receipt.get("source_worktree_id") == worktree_id
        and receipt.get("source_project_id") == project_id
        and receipt.get("allow_new_requests") is True
        and receipt.get("allow_old_request_replay") is False
        and isinstance(receipt.get("old_request_id"), str)
        and bool(receipt.get("old_request_id"))
    )


def _validate_source_transfer(control, receipt, *, namespace, receipt_path):
    """Authenticate an imported namespace against its archived Windows state."""
    identity = control.identity
    if (receipt.get("schema") != SOURCE_TRANSFER_SCHEMA
            or receipt.get("state") != SOURCE_TRANSFER_STATE
            or receipt.get("namespace") != namespace
            or receipt.get("compose_project") != control.project
            or receipt.get("control_volume") != control.volume
            or receipt.get("source_worktree_id") != identity["worktree_id"]
            or receipt.get("source_project_id") != identity["project_id"]
            or receipt.get("allow_new_requests") is not True
            or receipt.get("allow_old_request_replay") is not False
            or not isinstance(receipt.get("old_request_id"), str)
            or not receipt.get("old_request_id")):
        raise BuildControlError("Control namespace has no valid source-transfer authorization")

    previous_registry_path = _safe_relative(control, receipt.get("previous_registry_path"))
    previous_receipt_path = _safe_relative(control, receipt.get("previous_receipt_path"))
    previous_registry_sha256 = receipt.get("previous_registry_sha256")
    previous_receipt_sha256 = receipt.get("previous_receipt_sha256")
    if (SHA.fullmatch(previous_registry_sha256 or "") is None
            or SHA.fullmatch(previous_receipt_sha256 or "") is None
            or previous_registry_path in {REGISTRY_PATH, receipt_path}
            or previous_receipt_path in {REGISTRY_PATH, receipt_path, previous_registry_path}):
        raise BuildControlError("Source-transfer archive references are invalid")

    previous_registry_raw = _raw(control, previous_registry_path)
    if hashlib.sha256(previous_registry_raw).hexdigest() != previous_registry_sha256:
        raise BuildControlError("Archived source registry digest differs")
    previous_registry = json.loads(previous_registry_raw)
    if not isinstance(previous_registry, dict):
        raise BuildControlError("Archived source registry is invalid")
    previous_token = previous_registry.get("recovery_id", "")
    if not isinstance(previous_token, str) or HEX.fullmatch(previous_token) is None:
        raise BuildControlError("Archived source registry has an invalid identity")
    previous_namespace = "namespaces/" + previous_token
    expected_previous_receipt_path = "namespace-recovery/" + previous_token + "/terminal.json"
    previous_worktree_id = previous_registry.get("source_worktree_id")
    previous_project_id = previous_registry.get("source_project_id")
    if (previous_registry.get("schema") != REGISTRY_SCHEMA
            or previous_registry.get("namespace") != previous_namespace
            or previous_registry.get("receipt_path") != expected_previous_receipt_path
            or previous_registry.get("compose_project") != control.project
            or previous_registry.get("control_volume") != control.volume
            or not isinstance(previous_worktree_id, str) or not previous_worktree_id
            or not isinstance(previous_project_id, str) or not previous_project_id
            or previous_worktree_id == identity["worktree_id"]
            or previous_project_id == identity["project_id"]
            or previous_namespace == namespace
            or previous_receipt_path != expected_previous_receipt_path
            or SHA.fullmatch(previous_registry.get("receipt_sha256", "")) is None):
        raise BuildControlError("Archived source registry does not bind a distinct prior source")

    previous_receipt_raw = _raw(control, previous_receipt_path)
    previous_receipt_digest = hashlib.sha256(previous_receipt_raw).hexdigest()
    if (previous_receipt_digest != previous_receipt_sha256
            or previous_receipt_digest != previous_registry["receipt_sha256"]):
        raise BuildControlError("Archived source retirement receipt digest differs")
    previous_receipt = json.loads(previous_receipt_raw)
    if not _is_quarantined_receipt(
            previous_receipt, namespace=previous_namespace, project=control.project,
            volume=control.volume, worktree_id=previous_worktree_id,
            project_id=previous_project_id):
        raise BuildControlError("Archived source has no valid retirement quarantine")

    if (receipt.get("old_request_id") != previous_receipt.get("old_request_id")
            or receipt.get("activation_receipt_path")
            != previous_receipt.get("activation_receipt_path")
            or receipt.get("control_pins") != previous_receipt.get("control_pins")):
        raise BuildControlError("Source-transfer authorization differs from archived quarantine")


def resolve_namespace(control):
    """Resolve one immutable, explicitly authorized retirement boundary."""
    inspection = docker_capture("volume", "inspect", control.volume, allow_failure=True)
    if inspection.returncode:
        names = docker_capture("volume", "ls", "--format", "{{.Name}}").stdout.decode().splitlines()
        if control.volume in names:
            raise BuildControlError("Existing control volume could not be inspected")
        return
    records = json.loads(inspection.stdout)
    if (len(records) != 1 or records[0].get("Driver") != "local" or records[0].get("Options")
            or any((records[0].get("Labels") or {}).get(k) != v
                   for k, v in control.shared_labels.items())):
        raise BuildControlError("Control registry volume ownership differs")
    raw = _raw(control, REGISTRY_PATH, optional=True)
    if raw is None:
        return
    registry = json.loads(raw)
    if not isinstance(registry, dict):
        raise BuildControlError("Control namespace registry is invalid")
    token = registry.get("recovery_id", "")
    if not isinstance(token, str) or HEX.fullmatch(token) is None:
        raise BuildControlError("Control namespace registry has an invalid identity")
    namespace = "namespaces/" + token
    receipt_path = "namespace-recovery/" + token + "/terminal.json"
    expected = {
        "schema": REGISTRY_SCHEMA, "namespace": namespace, "receipt_path": receipt_path,
        "compose_project": control.project, "control_volume": control.volume,
        "source_worktree_id": control.identity["worktree_id"],
        "source_project_id": control.identity["project_id"],
    }
    if any(registry.get(k) != v for k, v in expected.items()):
        raise BuildControlError("Control namespace registry does not bind this source group")
    receipt_raw = _raw(control, receipt_path)
    if hashlib.sha256(receipt_raw).hexdigest() != registry.get("receipt_sha256"):
        raise BuildControlError("Control namespace retirement receipt digest differs")
    receipt = json.loads(receipt_raw)
    if not isinstance(receipt, dict):
        raise BuildControlError("Control namespace retirement receipt is invalid")
    if _is_quarantined_receipt(
            receipt, namespace=namespace, project=control.project, volume=control.volume,
            worktree_id=control.identity["worktree_id"],
            project_id=control.identity["project_id"]):
        pass
    elif receipt.get("schema") == SOURCE_TRANSFER_SCHEMA:
        _validate_source_transfer(control, receipt, namespace=namespace,
                                  receipt_path=receipt_path)
    else:
        raise BuildControlError("Control namespace has no explicit new-request authorization")
    # The original unknown marker remains the admission fence for old clients.
    activation_path = _safe_relative(control, receipt.get("activation_receipt_path"))
    control_pins = receipt.get("control_pins")
    if not isinstance(control_pins, dict):
        raise BuildControlError("Control namespace activation pins are invalid")
    active_pin = control_pins.get("active")
    activation_pin = control_pins.get(activation_path)
    if (SHA.fullmatch(active_pin or "") is None
            or SHA.fullmatch(activation_pin or "") is None):
        raise BuildControlError("Control namespace activation pins are invalid")
    active = _raw(control, "active")
    original = _raw(control, activation_path)
    if (hashlib.sha256(active).hexdigest() != active_pin
            or hashlib.sha256(original).hexdigest() != activation_pin
            or _raw(control, REGISTRY_PATH) != raw):
        raise BuildControlError("Quarantined activation or registry changed; resources retained")
    control.namespace = namespace
    control.namespace_registry = {**registry, "retirement": receipt}
    control.namespace_registry_sha256 = hashlib.sha256(raw).hexdigest()


def assert_namespace_activation(control, request_id=None):
    if not control.namespace:
        return
    record = control.namespace_registry["retirement"]
    if request_id is not None and request_id == record["old_request_id"]:
        raise BuildControlError("The quarantined request cannot be replayed in a new namespace")
    # Every helper read also checks the base registry SHA. Missing old local
    # unresolved.json is not itself permission: the constructor validates the
    # explicit immutable quarantine/new-request authorization above.


def _regular(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 8 * 1024 * 1024:
        raise BuildControlError("Retained metadata is not a bounded regular file: " + str(path))
    return path.read_bytes()


def _store_snapshot(root):
    result = {}
    for parent, directories, files in os.walk(root, followlinks=False):
        for name in directories:
            if Path(parent, name).is_symlink():
                raise BuildControlError("Retained store contains a linked directory")
        for name in files:
            path = Path(parent, name)
            relative = path.relative_to(root).as_posix()
            if not re.fullmatch(r"[A-Za-z0-9_./-]+", relative) or len(result) >= 64:
                raise BuildControlError("Retained store exceeds the held-run quarantine scope")
            result[relative] = _file_hash(path)
    return dict(sorted(result.items()))


def _file_hash(path):
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
            or info.st_size > 256 * 1024 * 1024):
        raise BuildControlError("Retained evidence exceeds its regular-file budget: " + str(path))
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(65536), b""):
            digest.update(block)
    after = path.lstat()
    if (info.st_ino, info.st_size, info.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
        raise BuildControlError("Retained evidence changed while hashing")
    return digest.hexdigest()


def _held_run(root, activation):
    runs = sorted(path.name for path in (root / "runs").iterdir())
    if len(runs) != 1 or not re.fullmatch(r"run-live-[0-9a-f]{64}", runs[0]):
        raise BuildControlError("Quarantine requires exactly one held live run")
    run_id = runs[0]
    intent = json.loads(_regular(root / "runs" / run_id / "run_intent.json"))
    catalog = json.loads(_regular(root / "runs" / run_id / "run_catalog.json"))
    specification = intent["specification"]
    parameters = specification["parameters"]
    command = parameters["live_workspace"]["command"]
    tasks = catalog["tasks"]
    if (intent.get("run_id") != run_id or catalog.get("run_id") != run_id
            or parameters["fullmag.accepted_run_start"].get("mode") != "manual"
            or command.get("kind") != "startup_script"
            or command.get("request_id") != activation["request_id"]
            or command.get("source_sha256") != activation["source_sha256"]
            or intent.get("idempotency_key") != "live-http-" + activation["activation_receipt_key"]
            or len(tasks) != 1 or tasks[0].get("lifecycle") != "accepted"
            or tasks[0].get("readiness") != {"state": "blocked", "reason": "accepted_task_awaiting_preparation"}
            or tasks[0].get("artifact_ids") != []):
        raise BuildControlError("Retained run is not the exact unprepared manual activation")
    cancel_dir = root / "runs" / run_id / "task_cancellation_intents"
    cancel_files = list(cancel_dir.iterdir())
    if len(cancel_files) != 1:
        raise BuildControlError("Held-run quarantine requires one existing cancellation intent")
    cancellation = json.loads(_regular(cancel_files[0]))
    if (cancellation.get("run_id") != run_id or cancellation.get("task") != tasks[0]
            or cancellation.get("expected_catalog_revision", -2) + 1 != catalog.get("revision")):
        raise BuildControlError("Cancellation intent does not bind the held task/catalog")
    expected = {"WRITER.lock", "WRITER.owner.json", "compute/EXECUTION_PROFILES.json",
                "scheduler_pools/docker-all.compute.resources.json",
                "scheduler_pools/docker-all.preparation.preparation-resources.json",
                "runs/" + run_id + "/run_intent.json", "runs/" + run_id + "/run_catalog.json",
                cancel_files[0].relative_to(root).as_posix()}
    for key in ("definition_object_ref", "study_object_ref", "study_catalog_object_ref"):
        digest = intent[key]
        if not isinstance(digest, str) or SHA.fullmatch(digest) is None:
            raise BuildControlError("Invalid immutable held-run object reference")
        expected.update({"objects/sha256/" + digest, "objects/pins/" + digest + ".json"})
        if _file_hash(root / "objects" / "sha256" / digest) != digest:
            raise BuildControlError("Held-run immutable object content differs")
    snapshot = _store_snapshot(root)
    if set(snapshot) != expected:
        raise BuildControlError("Retained store contains execution or unexpected metadata; quarantine refused")
    return run_id, snapshot


def _inventory(control, protected_names, state_root, ledger_root, helper_name=None):
    from docker_volume_activate import _canonical_host_path
    state_path = _canonical_host_path(state_root).casefold().rstrip("/")
    ledger_path = _canonical_host_path(ledger_root).casefold().rstrip("/")
    def overlaps(left, right):
        return left == right or left.startswith(right + "/") or right.startswith(left + "/")
    identifiers = docker_capture("ps", "-aq", "--no-trunc").stdout.decode().splitlines()
    if len(identifiers) > 256:
        raise BuildControlError("Container inventory exceeds recovery budget")
    containers = json.loads(docker_capture("inspect", *identifiers).stdout) if identifiers else []
    for container in containers:
        if container.get("Name", "").lstrip("/") == helper_name:
            continue
        labels = container.get("Config", {}).get("Labels") or {}
        if labels.get("com.docker.compose.project") == control.project:
            raise BuildControlError("Project still has a container: " + container["Id"])
        state = container.get("State", {})
        live = (state.get("Running") is not False or state.get("Pid", 0) != 0
                or state.get("Status") not in {"exited", "dead", "created"})
        if not live:
            # No data/volume is deleted. A stopped foreign container's
            # rollback reference is retained, but is not a live writer.
            continue
        for mount in container.get("Mounts", []):
            source = _canonical_host_path(str(mount.get("Source", ""))).casefold().rstrip("/")
            if (mount.get("Name") in protected_names
                    or (source and (overlaps(source, state_path)
                                    or overlaps(source, ledger_path)))):
                raise BuildControlError("Retained state/cache still has a container consumer: " + container["Id"])
    return sorted(identifiers)


# Fixed helper protocol; data arrives only through bounded JSON stdin. It has
# no Docker socket, network or writable host mounts. Native lock files are
# opened readonly: flock still serializes their shared Linux inode.
COMMIT = r'''
import fcntl,hashlib,json,os,pathlib,stat,sys
P=pathlib.Path
payload=json.loads(sys.stdin.buffer.readline(1024*1024))
record=payload['record']; namespace=record['namespace']; root=P('/control')
def regular(path):
    st=path.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_nlink!=1 or st.st_size>8*1024*1024: raise RuntimeError('unsafe metadata')
    return path.read_bytes()
def digest(path):
    before=path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_nlink!=1 or before.st_size>256*1024*1024: raise RuntimeError('unsafe evidence file')
    h=hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda:f.read(65536),b''): h.update(block)
    after=path.lstat()
    if (before.st_ino,before.st_size,before.st_mtime_ns)!=(after.st_ino,after.st_size,after.st_mtime_ns): raise RuntimeError('evidence changed while hashing')
    return h.hexdigest()
locks=[]
for path in [root/'operation.lock',root/'runtime-control/runtime-services/STARTUP-GATE.lock',root/'runtime-control/runtime-services/LAUNCH.lock',root/'runtime-control/runtime-services/OWNER.lock',P('/ledger/ledger/WRITER.lock'),P('/ledger/ledger/HOST_INVENTORY_OWNER.lock'),P('/retained/WRITER.lock')]:
    if not stat.S_ISREG(path.lstat().st_mode) or path.is_symlink(): raise RuntimeError('unsafe lock')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW); fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB); locks.append(fd)
def verify():
    for relative,expected in record['control_pins'].items():
        if digest(root/relative)!=expected: raise RuntimeError('control pin changed: '+relative)
    ledger=P('/ledger/ledger/HOST_RESOURCE_LEDGER.json')
    if digest(ledger)!=record['ledger_sha256']: raise RuntimeError('ledger changed')
    data=json.loads(regular(ledger)); reservations=data['reservations']
    if isinstance(reservations,dict): reservations=list(reservations.values())
    if any(v.get('state')!='released' for v in reservations): raise RuntimeError('ledger has unreleased reservations')
    actual={}
    for parent,dirs,files in os.walk('/retained',followlinks=False):
        if any(P(parent,d).is_symlink() for d in dirs): raise RuntimeError('linked retained directory')
        for name in files:
            p=P(parent,name); actual[p.relative_to('/retained').as_posix()]=digest(p)
            if len(actual)>64: raise RuntimeError('retained store grew')
    if actual!=record['store_snapshot']: raise RuntimeError('retained store changed')
    if (root/'namespaces/current.json').exists(): raise RuntimeError('namespace already selected')
verify()
print('LOCKED',flush=True)
if sys.stdin.buffer.readline(16)!=b'COMMIT\n': raise RuntimeError('no host revalidation')
verify()
def directory(p):
    if p.is_symlink(): raise RuntimeError('linked control directory')
    if p.exists():
        if not p.is_dir(): raise RuntimeError('not a control directory')
    else: p.mkdir(mode=0o750)
    if p.resolve()!=p: raise RuntimeError('noncanonical control directory')
def publish(p,data):
    if p.exists() or p.is_symlink():
        if regular(p)!=data: raise RuntimeError('immutable destination differs')
        return
    tmp=p.parent/('.publish-'+record['recovery_id'])
    fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o640)
    try:
        with os.fdopen(fd,'wb') as f: f.write(data); f.flush(); os.fsync(f.fileno())
        os.link(tmp,p); tmp.unlink()
        d=os.open(p.parent,os.O_RDONLY|os.O_DIRECTORY); os.fsync(d); os.close(d)
    finally:
        if tmp.exists(): tmp.unlink()
for rel in ['namespace-recovery','namespace-recovery/'+record['recovery_id'],'namespaces',namespace]: directory(root/rel)
target=root/namespace
# Existing reconcilers use /control/operation.lock; this is the same global
# inode, never a second exclusion domain.
if (target/'operation.lock').exists():
    if not os.path.samefile(root/'operation.lock',target/'operation.lock'): raise RuntimeError('global lock inode differs')
else: os.link(root/'operation.lock',target/'operation.lock')
encoded=(json.dumps(record,sort_keys=True,separators=(',',':'),ensure_ascii=False)+'\n').encode()
receipt='namespace-recovery/'+record['recovery_id']+'/terminal.json'
publish(root/receipt,encoded); publish(target/'namespace.json',encoded)
# Adopt only immutable verified image attestations; source digests are still
# rechecked by the normal toolchain/image builder before any cache hit.
for rel in ['toolchain/verified.json','toolchain/dependency-versions.json','image-dev/verified.json','image-backend/verified.json']:
    source=root/rel
    if source.exists():
        directory(target/rel.split('/')[0]); publish(target/rel,regular(source))
registry={'schema':'fullmag.docker-control-namespace-registry.v1','namespace':namespace,'recovery_id':record['recovery_id'],'receipt_path':receipt,'receipt_sha256':hashlib.sha256(encoded).hexdigest(),'compose_project':record['compose_project'],'control_volume':record['control_volume'],'source_worktree_id':record['source_worktree_id'],'source_project_id':record['source_project_id']}
publish(root/'namespaces/current.json',(json.dumps(registry,sort_keys=True,separators=(',',':'))+'\n').encode())
print(json.dumps({'state':record['state'],'namespace':namespace,'receipt_path':receipt}),flush=True)
'''


def quarantine(args):
    from docker_dev_up import _selected_context
    import fullmag_storage as storage
    _, selected, layout, identity, control = _selected_context(args)
    if control.namespace:
        raise BuildControlError("A namespace has already been selected; inspect its receipt, do not repeat recovery")
    if HEX.fullmatch(args.activation) is None or HEX.fullmatch(args.recovery_id) is None:
        raise BuildControlError("Recovery/activation identities must be 32 lowercase hex characters")
    active = _raw(control, "active")
    if active.decode().strip() != args.activation:
        raise BuildControlError("Recovery does not bind the current activation")
    relative = "activation/attempts/" + args.activation + "/receipt.json"
    activation_raw = _raw(control, relative)
    activation = json.loads(activation_raw)
    if (activation.get("phase") != "activation" or activation.get("attempt") != args.activation
            or activation.get("state") != "outcome-unknown-resources-retained"
            or activation.get("compose_project") != control.project
            or activation.get("source_root") != str(selected)):
        raise BuildControlError("Only the exact retained unknown activation is eligible")
    development = activation["development_attempt"]
    if HEX.fullmatch(development) is None:
        raise BuildControlError("Invalid retained development attempt")
    prefix = "development/attempts/" + development
    terminal_raw = _raw(control, prefix + "/terminal.json")
    compose_raw = _raw(control, prefix + "/compose.json")
    terminal, compose = json.loads(terminal_raw), json.loads(compose_raw)
    if (compose.get("name") != control.project or terminal.get("attempt") != development
            or terminal.get("inputs", {}).get("source_root") != str(selected)
            or hashlib.sha256(canonical(compose)).hexdigest() != activation["config_sha256"]):
        raise BuildControlError("Retained Compose/source/configuration pins differ")
    state = storage.validate_path(Path(terminal["state_root"]), layout["runtime_root"], "retained state")
    store = state / "runs/docker-all/session-store"
    run_id, snapshot = _held_run(store, activation)
    mounts = compose["services"]["backend"]["volumes"]
    ledger_mounts = [m for m in mounts if m.get("target") == "/host-ledger"]
    import docker_group_ledger as group_ledger
    group_volume = compose.get("volumes", {}).get(group_ledger.COMPOSE_VOLUME)
    if (len(ledger_mounts) == 1 and ledger_mounts[0].get("type") == "volume"
            and ledger_mounts[0].get("source") == group_ledger.COMPOSE_VOLUME
            and isinstance(group_volume, dict) and group_volume.get("external") is True
            and str(group_volume.get("name", "")).startswith(group_ledger.VOLUME_PREFIX)
            and group_ledger.is_group_ledger_backend(compose["services"]["backend"].get("environment", {}))):
        # ADR 0067: the group's own ledger volume, never a host path.
        ledger_root = group_volume["name"]
        ledger_mount = "type=volume,src=" + ledger_root + ",dst=/ledger,readonly,volume-nocopy"
    elif (len(ledger_mounts) != 1 or ledger_mounts[0].get("type") != "bind"
            or not re.fullmatch(r"/mnt/fullmag-host-ledger-[a-z0-9_-]+", ledger_mounts[0].get("source", ""))):
        raise BuildControlError("Recovery requires the exact retained canonical ledger bind or group volume")
    else:
        ledger_root = ledger_mounts[0]["source"]
        ledger_mount = "type=bind,src=" + ledger_root + ",dst=/ledger,readonly"
    paths = ["active", relative, prefix + "/terminal.json", prefix + "/compose.json",
             "runtime-control/runtime-services/OWNER.json", "runtime-control/runtime-services/LAUNCH.json",
             "runtime-control/runtime-service/process-tree.json"]
    pins = {p: hashlib.sha256(_raw(control, p)).hexdigest() for p in paths}
    owner = control.read("runtime-control/runtime-services/OWNER.json")
    if owner.get("state") != "failed" or any(
        child.get("status") not in {"exited_success", "exited_failure"} for child in owner.get("children", [])
    ):
        raise BuildControlError("Retained native owner is not terminal failed")
    protected = set(terminal.get("backend_volumes", {}).values()) | {control.volume}
    if ledger_root.startswith(group_ledger.VOLUME_PREFIX):
        protected.add(ledger_root)
    helper_name = "fullmag-namespace-recovery-" + args.recovery_id
    _inventory(control, protected, str(state), ledger_root)
    engine = docker_capture("info", "--format", "{{.ID}}").stdout.decode().strip()
    toolchain = control.read("toolchain/verified.json")
    image = toolchain.get("image_id", "")
    if toolchain.get("state") != "succeeded" or not re.fullmatch(r"sha256:[0-9a-f]{64}", image):
        raise BuildControlError("Recovery requires a retained verified immutable helper toolchain")
    probe = control.helper_args("head -c 8388608 /ledger/ledger/HOST_RESOURCE_LEDGER.json")
    i = probe.index("--entrypoint")
    probe[i:i] = ["--mount", ledger_mount]
    observed = bounded_capture(probe, data=b"", timeout=60)
    if observed.returncode:
        raise BuildControlError("Cannot read the exact retained ledger")
    ledger = json.loads(observed.stdout)
    reservations = ledger["reservations"]
    if isinstance(reservations, dict):
        reservations = list(reservations.values())
    if ledger.get("schema_version") != "host_resource_ledger.v4" or any(r.get("state") != "released" for r in reservations):
        raise BuildControlError("Active or unknown reservations prevent namespace quarantine")
    record = {"schema": SCHEMA, "state": "quarantined-not-replayed", "recovery_id": args.recovery_id,
              "namespace": "namespaces/" + args.recovery_id, "compose_project": control.project,
              "control_volume": control.volume, "source_root": str(selected),
              "source_project_id": identity["project_id"], "source_worktree_id": identity["worktree_id"],
              "old_activation_attempt": args.activation, "old_request_id": activation["request_id"],
              "old_activation_outcome": "unknown-retained", "activation_receipt_path": relative,
              "control_pins": pins, "store_snapshot": snapshot, "retained_run_id": run_id,
              "retained_state_root": str(state), "ledger_root": ledger_root,
              "ledger_sha256": hashlib.sha256(observed.stdout).hexdigest(),
              "released_reservation_count": len(reservations), "docker_engine_id": engine,
              "allow_new_requests": True, "allow_old_request_replay": False,
              "authorization": "explicit-user-recovery-and-new-start", "created_at": time.time()}
    partial = _raw(control, "namespace-recovery/" + args.recovery_id + "/terminal.json", optional=True)
    if partial is not None:
        previous = json.loads(partial)
        if {k: v for k, v in previous.items() if k != "created_at"} != {
            k: v for k, v in record.items() if k != "created_at"
        }:
            raise BuildControlError("Partial recovery evidence differs; inspect retained records")
        record = previous
    if not args.apply:
        print(json.dumps(record, ensure_ascii=False, indent=2))
        return
    command = control.helper_args("exec python3 -I -B -c " + shlex.quote(COMMIT), name=helper_name)
    command[command.index(control.image)] = image
    i = command.index("--entrypoint")
    command[i:i] = ["--mount", ledger_mount,
                   "--mount", "type=bind,src=" + str(store) + ",dst=/retained,readonly"]
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        process.stdin.write(canonical({"record": record}) + b"\n")
        process.stdin.flush()
        if control._line(process) != "LOCKED":
            raise BuildControlError("Namespace helper did not acquire its complete lock set")
        _inventory(control, protected, str(state), ledger_root, helper_name)
        if docker_capture("info", "--format", "{{.ID}}").stdout.decode().strip() != engine:
            raise BuildControlError("Docker engine changed at namespace commit boundary")
        process.stdin.write(b"COMMIT\n")
        process.stdin.flush()
        process.stdin.close()
        result = control._line(process)
        if process.wait(timeout=60) != 0:
            raise BuildControlError("Namespace commit failed; evidence retained")
        print(result)
    finally:
        if process.stdin and not process.stdin.closed:
            process.stdin.close()
        if process.poll() is None:
            # Closing stdin aborts a helper awaiting COMMIT. If COMMIT was
            # sent, preserve the unknown outcome and inspect the registry.
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                pass
        if process.poll() is not None:
            diagnostic = process.stderr.read(8192).decode("utf-8", "replace")
            if diagnostic:
                print(diagnostic, file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--activation", required=True)
    parser.add_argument("--recovery-id", required=True)
    parser.add_argument("--apply", action="store_true")
    try:
        quarantine(parser.parse_args())
        return 0
    except (BuildControlError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print("namespace-recovery: " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
