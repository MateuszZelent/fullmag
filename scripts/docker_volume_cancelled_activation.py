"""Stop and authenticate the drain of one pinned cancelled-startup backend.

The recovery preserves the accepted SessionStore/runtime namespace. It does
not retry startup, Solve, retirement, or archive operations. A later explicit
fresh-state recreation is the only permitted continuation.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import shlex
import time
from collections.abc import Mapping
from typing import Any

from docker_build_control import (
    BuildControl,
    BuildControlError,
    ControlOutcomeUnknown,
    bounded_capture,
    canonical,
    docker_capture,
    toolchain_configuration,
)
from docker_dev_browser_qa import _resolve_selected, _validate_existing_control_volume
from docker_volume_activate import (
    _read_control_bytes,
    _retained_retirement_context,
    _validate_running_group,
    _wait_retirement_lease_release,
)
from docker_volume_activation_reconcile import _validate_helper
from docker_volume_dev import (
    _cancelled_activation_id,
    _cancelled_activation_preparation_evidence,
    _cancelled_activation_preparation_host_reservations,
    _cancelled_activation_probe_script,
    _cancelled_activation_sha,
    _retained_startup_enabled,
)
from docker_volume_stop_diagnostic import _port_matches, _validate_resume_terminal
from docker_volume_stop_failed import _owner_identity_key as _native_owner_identity_key
from docker_volume_stop_failed import _validate_native_ready_owner
from docker_volume_stop_unadmitted import (
    _preflight_terminal_process_receipt,
    _read_terminal_process_receipt,
)


ATTEMPT_RE = re.compile(r"[0-9a-f]{32}\Z")
CONTAINER_RE = re.compile(r"[0-9a-f]{64}\Z")
IMAGE_RE = re.compile(r"sha256:[0-9a-f]{64}\Z")
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
JOURNAL_SCHEMA = "fullmag.cancelled-activation-stop-journal.v1"
PLAN_SCHEMA = "fullmag.cancelled-activation-stop-plan.v1"
RECOVERY_SCHEMA = "fullmag.cancelled-activation-recovery.v1"
RECOVERY_STATE = "stopped-awaiting-fresh-archive"
ACTIVATION_TERMINAL_STATE = "operator-cancelled-after-confirmed-drain"
PROCESS_RECEIPT_SCHEMA = "fullmag.docker-process-tree.v1"
MAX_RECORD_BYTES = 8 * 1024 * 1024
MAX_PROCESS_RECEIPT_BYTES = 512 * 1024
MAX_SCOPE_OUTPUT_BYTES = 1024 * 1024
RECOVERY_CURRENT = "cancelled-activation-recovery/current.json"


class CancelledActivationRecoveryError(BuildControlError):
    """The exact cancelled-startup proof is absent or inconsistent."""


def _fail(message: str) -> CancelledActivationRecoveryError:
    return CancelledActivationRecoveryError(message)


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _strict_object(raw: bytes, label: str, *, maximum: int = MAX_RECORD_BYTES) -> dict[str, Any]:
    if len(raw) > maximum:
        raise _fail(f"{label} exceeds its byte bound")

    def unique(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, value in pairs:
            if key in result:
                raise _fail(f"{label} contains a duplicate JSON key")
            result[key] = value
        return result

    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=unique)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise _fail(f"{label} is not valid JSON") from error
    if not isinstance(value, dict):
        raise _fail(f"{label} is not a JSON object")
    return value


def _require(value: object, pattern: re.Pattern[str], label: str) -> str:
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        raise _fail(f"{label} is not a complete immutable identity")
    return value


def _stable_store_probe(probe: Mapping[str, object]) -> dict[str, object]:
    """Keep immutable cancellation evidence while excluding live heartbeat snapshots."""
    required = (
        "run_id",
        "task_id",
        "request_id",
        "source_sha256",
        "catalog_revision",
        "cancellation_id",
        "run_intent_sha256",
        "run_catalog_sha256",
        "cancellation_intent_sha256",
        "activation_marker_sha256",
        "matching_reservations",
        "task_count",
        "live_api_instance_id",
        "live_session_id",
        "live_session_epoch",
        "live_scene_revision",
        "live_workspace_sha256",
        "retained_current_run_sha256",
        "retained_current_run_task_count",
        "preparation_evidence",
        "preparation_host_reservations",
        "failed_preparation",
    )
    stable: dict[str, object] = {"schema": "fullmag.docker-activation-cancel-probe.v1"}
    for key in required:
        if key in probe:
            stable[key] = probe[key]
    stable["compute_queue_empty"] = (
        isinstance(probe.get("compute_queue"), Mapping)
        and probe["compute_queue"].get("items") == []
    )
    runtime = probe.get("runtime_service")
    stable["runtime_ready"] = (
        isinstance(runtime, Mapping)
        and runtime.get("configured") is True
        and runtime.get("state") == "ready"
        and isinstance(runtime.get("reason"), Mapping)
        and runtime["reason"].get("code") == "service_ready"
    )
    health = probe.get("health")
    stable["api_healthy"] = (
        isinstance(health, Mapping)
        and health.get("status") == "ok"
        and health.get("active_session") is True
    )
    return stable


def _validate_failed_preparation_probe(
    probe: Mapping[str, object],
    *,
    request_id: str,
    source_sha256: str,
    expected_run_id: str | None = None,
    expected_session_id: str | None = None,
) -> dict[str, object]:
    if probe.get("schema") != "fullmag.docker-activation-cancel-probe.v1":
        raise _fail("cancelled task probe schema differs")
    for key, expected in {
        "request_id": request_id,
        "source_sha256": source_sha256,
    }.items():
        if probe.get(key) != expected:
            raise _fail(f"cancelled task probe {key} differs from the unknown activation")
    if expected_run_id is not None and probe.get("run_id") != expected_run_id:
        raise _fail("cancelled task run differs from the retained retirement identity")
    if expected_session_id is not None and probe.get("live_session_id") != expected_session_id:
        raise _fail("cancelled task session differs from the retained retirement identity")
    _cancelled_activation_id(probe.get("run_id"), "run_id")
    _cancelled_activation_id(probe.get("task_id"), "task_id")
    _cancelled_activation_id(probe.get("cancellation_id"), "cancellation_id")
    _cancelled_activation_sha(probe.get("run_intent_sha256"), "run intent")
    _cancelled_activation_sha(probe.get("run_catalog_sha256"), "run catalog")
    _cancelled_activation_sha(probe.get("cancellation_intent_sha256"), "cancellation intent")
    _cancelled_activation_sha(probe.get("activation_marker_sha256"), "activation marker")
    _cancelled_activation_sha(probe.get("live_workspace_sha256"), "live workspace")
    if not isinstance(probe.get("live_api_instance_id"), str) or not probe["live_api_instance_id"]:
        raise _fail("cancelled task probe has no live API instance")
    if not isinstance(probe.get("live_session_id"), str) or not probe["live_session_id"]:
        raise _fail("cancelled task probe has no live session")
    for key in ("live_session_epoch", "live_scene_revision", "catalog_revision", "task_count"):
        value = probe.get(key)
        if type(value) is not int or value < 0:
            raise _fail(f"cancelled task probe {key} is invalid")
    if probe["catalog_revision"] <= 0 or probe["task_count"] != 1:
        raise _fail("cancelled task probe does not identify one current accepted task")
    if probe.get("matching_reservations") != 0:
        raise _fail("cancelled task still has a host resource reservation")
    queue = probe.get("compute_queue")
    if not isinstance(queue, Mapping) or queue.get("items") != []:
        raise _fail("cancelled task still has queued compute")
    runtime = probe.get("runtime_service")
    if (not isinstance(runtime, Mapping)
            or runtime.get("configured") is not True
            or runtime.get("state") != "ready"):
        raise _fail("native runtime service is not Ready")
    health = probe.get("health")
    if (not isinstance(health, Mapping)
            or health.get("status") != "ok"
            or health.get("active_session") is not True):
        raise _fail("cancelled task probe lost the active Ready session")
    if not isinstance(probe.get("retained_current_run_sha256"), str):
        raise _fail("cancelled task probe has no retained current run read model")
    _cancelled_activation_sha(
        probe["retained_current_run_sha256"], "retained current run",
    )
    if (type(probe.get("retained_current_run_task_count")) is not int
            or probe["retained_current_run_task_count"] != probe["task_count"]):
        raise _fail("cancelled current run planned task count differs from the accepted catalog")

    evidence = _cancelled_activation_preparation_evidence(
        probe.get("preparation_evidence"), "failed preparation evidence",
    )
    failed = probe.get("failed_preparation")
    if not isinstance(failed, Mapping):
        raise _fail("cancelled task has no failed preparer receipt")
    required = {
        "launch_id",
        "preparation_attempt_id",
        "resource_id",
        "lease_token",
        "exit_receipt_path",
        "exit_receipt_sha256",
        "lease_path",
        "lease_sha256",
        "lease_heartbeat_sequence",
        "status_success",
        "exit_code",
        "timed_out",
        "lease_state",
        "released_at",
    }
    if set(failed) != required:
        raise _fail("failed preparation identity fields differ")
    for key in ("launch_id", "preparation_attempt_id", "resource_id", "lease_token"):
        _cancelled_activation_id(failed.get(key), "preparation " + key)
    for key in ("exit_receipt_sha256", "lease_sha256"):
        _cancelled_activation_sha(failed.get(key), "preparation " + key)
    if (
        failed.get("status_success") is not False
        or type(failed.get("exit_code")) is not int
        or failed.get("exit_code") != 1
        or failed.get("timed_out") is not False
        or failed.get("lease_state") != "released"
        or not isinstance(failed.get("released_at"), str)
        or not failed["released_at"]
        or type(failed.get("lease_heartbeat_sequence")) is not int
        or failed.get("lease_heartbeat_sequence") < 0
    ):
        raise _fail("failed preparer exit or exact released lease is not confirmed")
    exit_path = failed.get("exit_receipt_path")
    lease_path = failed.get("lease_path")
    if not isinstance(exit_path, str) or not exit_path.startswith("preparation_process_exit_receipts/"):
        raise _fail("failed preparation exit receipt path is invalid")
    expected_lease_path = (
        "preparation_resource_leases/"
        + str(failed["resource_id"])
        + "/"
        + str(failed["lease_token"])
        + ".json"
    )
    if lease_path != expected_lease_path:
        raise _fail("released preparation lease path differs from its exact identity")
    evidence_by_path = {entry["path"]: entry["sha256"] for entry in evidence}
    if (evidence_by_path.get(exit_path) != failed["exit_receipt_sha256"]
            or evidence_by_path.get(lease_path) != failed["lease_sha256"]):
        raise _fail("failed process exit or released lease digest differs from the locked evidence")
    if len(evidence) < 3:
        raise _fail("cancelled task preparation evidence is incomplete")
    host_reservations = _cancelled_activation_preparation_host_reservations(
        probe.get("preparation_host_reservations", []),
        "failed preparation host reservation evidence",
    )
    return {
        "run_id": probe["run_id"],
        "task_id": probe["task_id"],
        "session_id": probe["live_session_id"],
        "cancellation_id": probe["cancellation_id"],
        "request_id": request_id,
        "source_sha256": source_sha256,
        "catalog_revision": probe["catalog_revision"],
        "run_intent_sha256": probe["run_intent_sha256"],
        "run_catalog_sha256": probe["run_catalog_sha256"],
        "cancellation_intent_sha256": probe["cancellation_intent_sha256"],
        "activation_marker_sha256": probe["activation_marker_sha256"],
        "live_api_instance_id": probe["live_api_instance_id"],
        "live_session_epoch": probe["live_session_epoch"],
        "live_scene_revision": probe["live_scene_revision"],
        "live_workspace_sha256": probe["live_workspace_sha256"],
        "retained_current_run_sha256": probe["retained_current_run_sha256"],
        "preparation_evidence": evidence,
        "preparation_host_reservations": host_reservations,
        "failed_preparation": dict(failed),
        "probe": _stable_store_probe(probe),
    }


def _failed_preparation_probe_script() -> str:
    """Reuse the locked read-only cancellation proof with failed-run evidence.

    Failed preparers do not publish a task or stage receipt. This variant
    requires those receipts to be absent and binds the unique process launch,
    failed exit receipt, and released lease directly to the cancelled task.
    """
    source = _cancelled_activation_probe_script()
    start_marker = "    preparation_records=task_receipts+stage_receipts+prep_launches+prep_exits+prep_leases\n"
    end_marker = "    solver_matches=matching_json("
    start = source.find(start_marker)
    end = source.find(end_marker, start + len(start_marker))
    if start < 0 or end < 0 or source.find(start_marker, start + 1) >= 0:
        raise _fail("existing cancellation probe preparation evidence block changed")
    failed_evidence = '''    preparation_records=task_receipts+stage_receipts+prep_launches+prep_exits+prep_leases
    preparation_evidence=[]
    if task_receipts or stage_receipts:
        fail("failed preparer unexpectedly published a task or stage receipt")
    if len(prep_launches)!=1 or len(prep_exits)!=1 or len(prep_leases)!=1:
        fail("failed preparation launch, exit receipt, and lease are not unique")
    launch_record=prep_launches[0]; launch=launch_record["value"]
    exit_record=prep_exits[0]; process_exit=exit_record["value"]
    lease_record=prep_leases[0]; prep_lease=lease_record["value"]
    launch_required={"schema_version","launch_id","run_id","task_id","preparation_attempt_id",
                     "resource_id","lease_token","lease_heartbeat_sequence","supervisor_process_id",
                     "supervisor_start_token","created_at"}
    exit_required={"schema_version","receipt_id","run_id","task_id","preparation_attempt_id",
                   "resource_id","lease_token","lease_heartbeat_sequence","process_id",
                   "process_start_token","status_success","exit_code","timed_out","failure_reason","observed_at"}
    lease_required={"schema_version","resource_id","budget","run_id","task_id","preparation_attempt_id",
                    "lease_token","state","acquired_at","heartbeat_at","heartbeat_sequence","released_at",
                    "host_launch_binding"}
    launch_id=launch.get("launch_id"); exit_id=process_exit.get("receipt_id")
    preparation_attempt=launch.get("preparation_attempt_id")
    resource_id=launch.get("resource_id"); lease_token=launch.get("lease_token")
    launch_heartbeat=launch.get("lease_heartbeat_sequence")
    exit_heartbeat=process_exit.get("lease_heartbeat_sequence")
    lease_heartbeat=prep_lease.get("heartbeat_sequence")
    identity={"run_id":run_id,"task_id":task_id,"preparation_attempt_id":preparation_attempt,
              "resource_id":resource_id,"lease_token":lease_token}
    portable=lambda value: isinstance(value,str) and bool(value) and len(value)<=200 and value[0] in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789" and all(char in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-" for char in value) and not value.endswith(".")
    if (not all(portable(value) for value in (launch_id,exit_id,preparation_attempt,resource_id,lease_token))
            or not all(type(value) is int and value>=0 for value in (launch_heartbeat,exit_heartbeat,lease_heartbeat))
            or launch_heartbeat>exit_heartbeat or exit_heartbeat!=lease_heartbeat):
        fail("failed preparation process identity or lease heartbeat is invalid")
    if (launch_record["path"]!="preparation_process_launches/"+launch_id+".json"
            or set(launch)!=launch_required or launch.get("schema_version")!="preparation_process_launch.v1"
            or any(launch.get(key)!=value for key,value in identity.items())
            or not isinstance(launch.get("supervisor_process_id"),int)
            or isinstance(launch.get("supervisor_process_id"),bool) or launch.get("supervisor_process_id",0)<=0
            or not isinstance(launch.get("supervisor_start_token"),str) or not launch["supervisor_start_token"]
            or not isinstance(launch.get("created_at"),str)
            or exit_id!="prep-exit-"+launch_id
            or exit_record["path"]!="preparation_process_exit_receipts/"+exit_id+".json"
            or set(process_exit)!=exit_required
            or process_exit.get("schema_version")!="preparation_process_exit_receipt.v1"
            or any(process_exit.get(key)!=value for key,value in identity.items())
            or process_exit.get("status_success") is not False
            or type(process_exit.get("exit_code")) is not int or process_exit.get("exit_code")!=1
            or process_exit.get("timed_out") is not False
            or not isinstance(process_exit.get("failure_reason"),str) or not process_exit["failure_reason"]
            or not isinstance(process_exit.get("process_id"),int)
            or isinstance(process_exit.get("process_id"),bool) or process_exit.get("process_id",0)<=0
            or not isinstance(process_exit.get("process_start_token"),str) or not process_exit["process_start_token"]
            or not isinstance(process_exit.get("observed_at"),str)):
        fail("preparation process does not have one exact failed exit receipt")
    if (lease_record["path"]!="preparation_resource_leases/"+resource_id+"/"+lease_token+".json"
            or set(prep_lease)!=lease_required
            or prep_lease.get("schema_version")!="preparation_resource_lease.v1"
            or any(prep_lease.get(key)!=value for key,value in identity.items())
            or prep_lease.get("heartbeat_sequence")!=exit_heartbeat
            or prep_lease.get("state")!="released"
            or not isinstance(prep_lease.get("released_at"),str) or not prep_lease["released_at"]
            or not isinstance(prep_lease.get("budget"),dict)
            or any(not isinstance(prep_lease.get(key),str) or not prep_lease.get(key)
                   for key in ("acquired_at","heartbeat_at"))):
        fail("preparation lease is not released for the exact failed process")
    preparation_evidence=sorted(
        ({"path":record["path"],"sha256":digest(record["raw"])} for record in preparation_records),
        key=lambda item:item["path"],
    )
'''
    source = source[:start] + failed_evidence + source[end:]
    for old, new, label in (
        (
            'intent=obj(intent_path,"accepted RunIntent")',
            'intent=strict_obj(intent_raw,"accepted RunIntent")',
            "RunIntent",
        ),
        (
            'catalog=obj(catalog_path,"run catalog")',
            'catalog=strict_obj(catalog_raw,"run catalog")',
            "run catalog",
        ),
        (
            'cancellation=obj(cancellation_path,"cancellation intent")',
            'cancellation=strict_obj(cancellation_raw,"cancellation intent")',
            "cancellation intent",
        ),
        (
            'marker=obj(marker_path,"startup activation marker")',
            'marker=strict_obj(marker_raw,"startup activation marker")',
            "startup activation marker",
        ),
    ):
        if source.count(old) != 1:
            raise _fail("existing cancellation probe " + label + " parser point changed")
        source = source.replace(old, new)
    zero_step_guard = (
        '            if (retained_run.get("run_id")!=run_id'
    )
    if source.count(zero_step_guard) != 1:
        raise _fail("existing cancellation probe current-run validation point changed")
    source = source.replace(
        zero_step_guard,
        '            if (type(retained_run.get("total_steps")) is not int or retained_run.get("total_steps")!=len(tasks)\n'
        '                    or retained_run.get("run_id")!=run_id',
    )
    step_output = (
        '    if retained_current_run_sha256 is not None: probe["retained_current_run_sha256"]=retained_current_run_sha256'
    )
    if source.count(step_output) != 1:
        raise _fail("existing cancellation probe current-run output point changed")
    source = source.replace(
        step_output,
        '    if retained_current_run_sha256 is not None:\n'
        '        probe["retained_current_run_sha256"]=retained_current_run_sha256\n'
        '        probe["retained_current_run_task_count"]=retained_run.get("total_steps")',
    )
    output_marker = '    print(json.dumps(probe,sort_keys=True))'
    output_extension = '''    if "process_exit" not in locals() or "prep_lease" not in locals():
        fail("failed preparation receipt and released lease are missing")
    probe["failed_preparation"]={
        "launch_id":launch["launch_id"],
        "preparation_attempt_id":process_exit["preparation_attempt_id"],
        "resource_id":process_exit["resource_id"],
        "lease_token":process_exit["lease_token"],
        "exit_receipt_path":exit_record["path"],
        "exit_receipt_sha256":digest(exit_record["raw"]),
        "lease_path":lease_record["path"],
        "lease_sha256":digest(lease_record["raw"]),
        "lease_heartbeat_sequence":prep_lease["heartbeat_sequence"],
        "status_success":process_exit["status_success"],
        "exit_code":process_exit["exit_code"],
        "timed_out":process_exit["timed_out"],
        "lease_state":prep_lease["state"],
        "released_at":prep_lease["released_at"],
    }
    print(json.dumps(probe,sort_keys=True))'''
    if source.count(output_marker) != 1:
        raise _fail("existing cancellation probe output point changed")
    source = source.replace(output_marker, output_extension)
    for old, new, label in (
        (
            "if not task_receipts or preparation_host_reservations:",
            "if preparation_host_reservations:",
            "released host preparation reservation",
        ),
        (
            "if (task_receipts and isinstance(prep_lease.get(\"host_launch_binding\"),dict)",
            "if (isinstance(prep_lease.get(\"host_launch_binding\"),dict)",
            "host launch binding release proof",
        ),
    ):
        if source.count(old) != 1:
            raise _fail("existing cancellation probe " + label + " check changed")
        source = source.replace(old, new)
    return source


def _scope_discovery_script() -> str:
    """Read the exact live run/task from API and its bounded current catalog."""
    return r'''import json, os, pathlib, re, stat, sys, urllib.request
MAX=1024*1024
def fail(message): raise RuntimeError(message)
def unique(pairs):
    value={}
    for key,item in pairs:
        if key in value: fail("duplicate JSON key")
        value[key]=item
    return value
def obj(raw,label):
    try: value=json.loads(raw.decode("utf-8"),object_pairs_hook=unique)
    except (UnicodeDecodeError,json.JSONDecodeError) as error: raise RuntimeError(label+" is invalid JSON") from error
    if not isinstance(value,dict): fail(label+" is not an object")
    return value
def get(path,label):
    request=urllib.request.Request("http://127.0.0.1:8081"+path,headers={"Accept":"application/json","Host":"localhost"})
    with urllib.request.urlopen(request,timeout=5) as response:
        raw=response.read(MAX+1)
        if response.status!=200 or len(raw)>MAX: fail(label+" response is invalid")
        value=obj(raw,label)
        instance=response.headers.get("x-fullmag-api-instance")
        if not isinstance(instance,str) or not instance: fail(label+" API instance is missing")
        return value,instance
def regular(path,label):
    path=pathlib.Path(path)
    if (not path.is_absolute() or ".." in path.parts or path.is_symlink()
            or path.parent.resolve(strict=True)!=path.parent): fail(label+" path is unsafe")
    fd=os.open(path,os.O_RDONLY|getattr(os,"O_NOFOLLOW",0))
    try:
        meta=os.fstat(fd)
        if not stat.S_ISREG(meta.st_mode) or meta.st_size>MAX: fail(label+" is not bounded regular")
        raw=os.read(fd,MAX+1)
        if len(raw)>MAX: fail(label+" exceeds its byte bound")
        return raw
    finally: os.close(fd)
status, status_instance=get("/v2/sessions/current/status","current session status")
session=status.get("session")
if not isinstance(session,dict) or not isinstance(session.get("session_id"),str): fail("current session identity is missing")
current, current_instance=get("/v2/sessions/current","current session")
run, run_instance=get("/v2/sessions/current/simulation/runs/current","current run")
scene, scene_instance=get("/v2/sessions/current/model/scene","current scene")
instances={status_instance,current_instance,run_instance,scene_instance}
if len(instances)!=1: fail("current session, run, and scene API instances differ")
run_id=run.get("run_id")
if (not isinstance(run_id,str) or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}",run_id) is None
        or run_id in {".",".."} or run_id.endswith(".")
        or run.get("session_id")!=session.get("session_id")):
    fail("current run is not bound to the current session")
store_root=os.environ.get("FULLMAG_RUNS_ROOT","/state/runs/docker-all")+"/session-store"
store=pathlib.Path(store_root)
if (not store.is_absolute() or ".." in store.parts or store.is_symlink()
        or not store.is_dir() or store.resolve(strict=True)!=store): fail("accepted store root is unsafe")
runs=store/"runs"
run_dir=runs/run_id
if (runs.is_symlink() or not runs.is_dir() or runs.resolve(strict=True)!=runs
        or run_dir.is_symlink() or not run_dir.is_dir()
        or run_dir.resolve(strict=True)!=run_dir): fail("current accepted run path is unsafe")
catalog_path=run_dir/"run_catalog.json"
catalog=obj(regular(catalog_path,"current run catalog"),"current run catalog")
tasks=catalog.get("tasks")
if (catalog.get("schema_version")!="run_catalog.v1" or catalog.get("run_id")!=run_id
        or not isinstance(tasks,list) or len(tasks)!=1 or not isinstance(tasks[0],dict)):
    fail("current accepted run does not have one unambiguous task")
task_id=tasks[0].get("task_id")
if (not isinstance(task_id,str)
        or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}",task_id) is None
        or task_id in {".",".."} or task_id.endswith(".")): fail("current task identity is missing")
revision=scene.get("revision",scene.get("scene_revision"))
if type(revision) is not int or revision<0: fail("current scene revision is invalid")
print(json.dumps({"run_id":run_id,"task_id":task_id,"session_id":session["session_id"],
                  "scene_revision":revision,"api_instance_id":next(iter(instances))},sort_keys=True))
'''


def _discover_scope(backend_id: str) -> dict[str, object]:
    result = docker_capture(
        "exec", backend_id, "/usr/local/bin/python3", "-I", "-B", "-c",
        _scope_discovery_script(), timeout=30, allow_failure=True,
    )
    if result.returncode:
        raise _fail(
            "current cancelled run/task could not be discovered read-only: "
            + result.stderr.decode("utf-8", "replace")[-2048:]
        )
    scope = _strict_object(bytes(result.stdout), "cancelled run/task discovery",
                           maximum=MAX_SCOPE_OUTPUT_BYTES)
    for key in ("run_id", "task_id", "session_id"):
        _cancelled_activation_id(scope.get(key), key)
    if (type(scope.get("scene_revision")) is not int
            or scope["scene_revision"] < 0
            or not isinstance(scope.get("api_instance_id"), str)
            or not scope["api_instance_id"]):
        raise _fail("current cancelled run/task discovery identity is invalid")
    return scope


def _failed_preparation_store_probe(
    backend_id: str,
    *,
    run_id: str,
    task_id: str,
    request_id: str,
    source_sha256: str,
    marker_path: str,
    expected_scene_revision: int,
    environment: Mapping[str, object],
) -> dict[str, object]:
    runs_root = environment.get("FULLMAG_RUNS_ROOT", "/state/runs/docker-all")
    ledger_root = environment.get("FULLMAG_HOST_LEDGER_ROOT", "/host-ledger/ledger")
    if not isinstance(runs_root, str) or not isinstance(ledger_root, str):
        raise _fail("retained backend accepted-store or host-ledger root is invalid")
    store_root = runs_root.rstrip("/") + "/session-store"
    result = docker_capture(
        "exec", "-i", backend_id, "/usr/local/bin/python3", "-B", "-",
        run_id, task_id, request_id, source_sha256, marker_path,
        store_root, ledger_root, str(expected_scene_revision),
        data=_failed_preparation_probe_script().encode("utf-8"),
        timeout=90, allow_failure=True,
    )
    if result.returncode:
        raise _fail(
            "locked cancelled-task proof failed: "
            + result.stderr.decode("utf-8", "replace")[-4096:]
        )
    probe = _strict_object(bytes(result.stdout), "cancelled task probe")
    probe["preparation_evidence"] = _cancelled_activation_preparation_evidence(
        probe.get("preparation_evidence", []), "failed preparation probe evidence",
    )
    probe["preparation_host_reservations"] = _cancelled_activation_preparation_host_reservations(
        probe.get("preparation_host_reservations", []),
        "failed preparation host reservation evidence",
    )
    return probe


def _read_original_process_receipt(backend_id: str) -> tuple[bytes, dict[str, Any]]:
    script = r'''import os,stat,sys
sys.path.insert(0,"/opt/fullmag")
import runtime_service
path=runtime_service.process_receipt_path(runtime_service.canonical_paths())
for parent in (path,*path.parents):
    if parent.is_symlink(): raise RuntimeError("process receipt path contains a symlink")
fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
with os.fdopen(fd,"rb") as source:
    if not stat.S_ISREG(os.fstat(source.fileno()).st_mode): raise RuntimeError("process receipt is not regular")
    raw=source.read(512*1024+1)
if len(raw)>512*1024: raise RuntimeError("process receipt exceeds its bound")
sys.stdout.buffer.write(raw)
'''
    result = docker_capture(
        "exec", backend_id, "/usr/local/bin/python3", "-I", "-B", "-c",
        script, timeout=30, allow_failure=True,
    )
    if result.returncode:
        raise _fail("Ready process receipt could not be read from the exact backend")
    raw = bytes(result.stdout)
    return raw, _strict_object(raw, "original Ready process receipt",
                               maximum=MAX_PROCESS_RECEIPT_BYTES)


def _validate_original_process(
    process: Mapping[str, object],
) -> dict[str, object]:
    if (process.get("schema") != PROCESS_RECEIPT_SCHEMA
            or process.get("state") != "ready"
            or not isinstance(process.get("service_owner"), Mapping)
            or "terminal_service_owner" in process
            or "startup_activation" in process):
        raise _fail("backend process receipt is not the canonical Ready state")
    return _validate_native_ready_owner(process["service_owner"])


def _explicit_activation_environment(compose: Mapping[str, object]) -> Mapping[str, object]:
    services = compose.get("services")
    backend = services.get("backend") if isinstance(services, Mapping) else None
    environment = backend.get("environment") if isinstance(backend, Mapping) else None
    if (not isinstance(environment, Mapping)
            or environment.get("FULLMAG_STARTUP_ENABLED", "0") != "0"
            or _retained_startup_enabled(backend)):
        raise _fail("explicit activation recovery requires the retained backend startup to be disabled")
    return environment


def _drained_owner_valid(
    owner: Mapping[str, object],
    ready_owner: Mapping[str, object],
    label: str,
) -> str:
    if (owner.get("schema_version") != "runtime_service_owner.v1"
            or owner.get("protocol") != "stdin-v1"
            or owner.get("state") != "drained"
            or owner.get("target_id") != "docker-all"):
        raise _fail(f"{label} is not the canonical drained runtime owner")
    children = owner.get("children")
    if not isinstance(children, list) or len(children) != 2:
        raise _fail(f"{label} does not identify both native schedulers")
    roles: set[str] = set()
    pids: set[int] = set()
    for child in children:
        if not isinstance(child, Mapping):
            raise _fail(f"{label} has an invalid scheduler child")
        role, pid = child.get("role"), child.get("pid")
        if (role not in {"compute", "preparation"} or role in roles
                or type(pid) is not int or pid <= 0 or pid in pids
                or child.get("status") != "exited_success"):
            raise _fail(f"{label} has a scheduler child that did not exit successfully")
        roles.add(role)
        pids.add(pid)
    if roles != {"compute", "preparation"}:
        raise _fail(f"{label} is missing a native scheduler")
    if _native_owner_identity_key(owner, label) != _native_owner_identity_key(
        ready_owner, "original Ready owner"
    ):
        raise _fail(f"{label} identity differs from the original Ready owner")
    return _sha256(canonical([list(_native_owner_identity_key(owner, label)[0]),
                              [list(item) for item in _native_owner_identity_key(owner, label)[1]]]))


def _validate_drain(
    stopped: Mapping[str, object],
    raw: bytes,
    receipt: Mapping[str, object],
    *,
    proof: Mapping[str, object],
    ready_owner: Mapping[str, object],
) -> dict[str, object]:
    state = stopped.get("State")
    if (stopped.get("Id") != proof.get("backend_container")
            or stopped.get("Image") != proof.get("image_id")
            or not isinstance(state, Mapping)
            or state.get("StartedAt") != proof.get("backend_started_at")
            or state.get("Running") is not False
            or state.get("OOMKilled") is not False
            or type(state.get("ExitCode")) is not int
            or state.get("ExitCode") != 0):
        raise _fail("backend did not stop gracefully as the exact pinned incarnation")
    if (receipt.get("schema") != PROCESS_RECEIPT_SCHEMA
            or receipt.get("state") != "drained"
            or not isinstance(receipt.get("service_owner"), Mapping)
            or not isinstance(receipt.get("terminal_service_owner"), Mapping)):
        raise _fail("authenticated terminal process receipt is not drained")
    if (_native_owner_identity_key(receipt["service_owner"], "drained Ready owner")
            != _native_owner_identity_key(ready_owner, "original Ready owner")):
        raise _fail("drained receipt Ready owner differs from the pre-stop owner")
    terminal_owner_sha = _drained_owner_valid(
        receipt["terminal_service_owner"], ready_owner, "terminal drained owner",
    )
    return {
        "backend_container": stopped["Id"],
        "image_id": stopped["Image"],
        "backend_started_at": state["StartedAt"],
        "backend_finished_at": state.get("FinishedAt"),
        "backend_exit_code": state["ExitCode"],
        "docker_oom_killed": state["OOMKilled"],
        "process_receipt_sha256": _sha256(raw),
        "process_receipt": dict(receipt),
        "terminal_owner_identity_sha256": terminal_owner_sha,
        "native_children_exit_status": "exited_success",
    }


def _identity_hash(owner: Mapping[str, object]) -> str:
    identity = _native_owner_identity_key(owner, "Ready owner")
    return _sha256(canonical([list(identity[0]), [list(item) for item in identity[1]]]))


def _selected_context(args: argparse.Namespace) -> tuple[Any, dict[str, str], BuildControl]:
    for value, pattern, label in (
        (getattr(args, "attempt", None), ATTEMPT_RE, "development attempt"),
        (getattr(args, "iteration_attempt", None), ATTEMPT_RE, "iteration attempt"),
        (getattr(args, "activation_attempt", None), ATTEMPT_RE, "activation attempt"),
        (getattr(args, "config_sha256", None), SHA256_RE, "Compose config"),
    ):
        _require(value, pattern, label)
    port = getattr(args, "port", None)
    if type(port) is not int or not 1 <= port <= 65535:
        raise _fail("frontend port is invalid")
    selected, _, identity = _resolve_selected(args)
    configured = toolchain_configuration(selected, identity)
    try:
        helper_image = configured["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"]
    except (KeyError, TypeError) as error:
        raise _fail("canonical Docker control helper image is unavailable") from error
    control = BuildControl(identity, helper_image)
    _validate_existing_control_volume(control)
    return selected, identity, control


def _read_control_record(
    control: BuildControl, relative: str, *, optional: bool = False,
) -> tuple[dict[str, Any] | None, bytes | None]:
    raw = _read_control_bytes(control, relative, optional=optional, maximum=MAX_RECORD_BYTES)
    if raw is None:
        return None, None
    return _strict_object(raw, "control record " + relative), raw


def _require_recovery_current_clear(
    control: BuildControl,
    activation_attempt: str,
) -> None:
    raw = _read_control_bytes(control, RECOVERY_CURRENT, optional=True, maximum=MAX_RECORD_BYTES)
    if raw is None:
        return
    current = _strict_object(raw, "cancelled activation recovery current pointer")
    if current.get("activation_attempt") == activation_attempt:
        raise _fail(
            "this activation already has a recovery current record; resume its retained journal"
        )
    raise _fail(
        "a prior cancelled-activation recovery current record must be reconciled before another drain"
    )


def _build_proof(args: argparse.Namespace) -> dict[str, Any]:
    selected, identity, control = _selected_context(args)
    _require_recovery_current_clear(control, args.activation_attempt)
    development_root = "development/attempts/" + args.attempt
    previous = control.read(development_root + "/terminal.json")
    compose = control.read(development_root + "/compose.json")
    if not isinstance(previous, Mapping) or not isinstance(compose, Mapping):
        raise _fail("retained development terminal or Compose document is missing")
    if _sha256(canonical(dict(compose))) != args.config_sha256:
        raise _fail("retained Compose digest differs from the requested config pin")
    _port_matches(compose, args.port)
    pin = _validate_resume_terminal(
        control,
        args.iteration_attempt,
        development_attempt=args.attempt,
        config_sha256=args.config_sha256,
        previous=previous,
        phase="iteration",
    )
    if (previous.get("compose_project") != control.project
            or previous.get("state_root") is None):
        raise _fail("retained development receipt is not bound to this Compose group/state root")
    inputs = previous.get("inputs")
    if not isinstance(inputs, Mapping):
        raise _fail("retained development receipt has no immutable runtime inputs")
    image_id = inputs.get("image_id")
    if not isinstance(image_id, str) or IMAGE_RE.fullmatch(image_id) is None:
        raise _fail("retained development image identity is invalid")
    effective_previous = dict(
        previous,
        backend_container=pin["backend_container"],
        frontend_container=pin["frontend_container"],
    )
    backend_id, frontend_id = _validate_running_group(
        control,
        identity,
        compose,
        effective_previous,
        image_id,
        source_root=str(selected),
        require_healthy=True,
    )
    if (backend_id != pin["backend_container"]
            or frontend_id != pin["frontend_container"]):
        raise _fail("live Compose group differs from the exact iteration service IDs")
    backend_rows = json.loads(docker_capture("inspect", backend_id, timeout=60).stdout)
    frontend_rows = json.loads(docker_capture("inspect", frontend_id, timeout=60).stdout)
    if (not isinstance(backend_rows, list) or len(backend_rows) != 1
            or not isinstance(backend_rows[0], Mapping)
            or not isinstance(frontend_rows, list) or len(frontend_rows) != 1
            or not isinstance(frontend_rows[0], Mapping)):
        raise _fail("backend or frontend incarnation inspection is ambiguous")
    backend, frontend = dict(backend_rows[0]), dict(frontend_rows[0])
    backend_state, frontend_state = backend.get("State"), frontend.get("State")
    if (backend.get("Id") != backend_id or backend.get("Image") != image_id
            or not isinstance(backend_state, Mapping)
            or backend_state.get("Running") is not True
            or backend_state.get("StartedAt") != pin["backend_started_at"]):
        raise _fail("backend is not the exact healthy running iteration incarnation")
    if (frontend.get("Id") != frontend_id
            or not isinstance(frontend_state, Mapping)
            or frontend_state.get("Running") is not True
            or not isinstance(frontend_state.get("StartedAt"), str)
            or not frontend_state["StartedAt"]):
        raise _fail("frontend is not the exact running iteration incarnation")

    activation_root = "activation/attempts/" + args.activation_attempt
    retained = _retained_retirement_context(
        control,
        development_attempt=args.attempt,
        config_sha256=args.config_sha256,
        source_root=str(selected),
        image_id=str(image_id),
        backend_id=backend_id,
    )
    if retained is None:
        raise _fail("original unknown activation helper lease is not present")
    receipt, retirement_context, receipt_raw = retained
    if (receipt.get("attempt") != args.activation_attempt
            or receipt.get("state") != "outcome-unknown-resources-retained"
            or receipt.get("phase") != "activation"):
        raise _fail("retained operation is not the exact unknown activation attempt")
    bindings = retirement_context.get("bindings")
    if not isinstance(bindings, Mapping):
        raise _fail("unknown activation has no validated request/source bindings")
    if retirement_context.get("operation_id") != args.activation_attempt:
        raise _fail("active helper lease belongs to another activation")
    for key, expected in {
        "development_attempt": args.attempt,
        "config_sha256": args.config_sha256,
        "source_root": str(selected),
        "image_id": image_id,
        "backend_container": backend_id,
    }.items():
        if receipt.get("inputs", {}).get(key) != expected:
            raise _fail("unknown activation input differs: " + key)
    request_id = bindings.get("request_id")
    source_sha256 = bindings.get("source_sha256")
    marker_path = bindings.get("activation_receipt_path")
    if (not isinstance(request_id, str) or not request_id
            or not isinstance(source_sha256, str) or SHA256_RE.fullmatch(source_sha256) is None
            or not isinstance(marker_path, str) or not marker_path.startswith("/opt/fullmag/control/backend/")):
        raise _fail("unknown activation startup marker binding is incomplete")

    active_raw = _read_control_bytes(control, "active", optional=True, maximum=256)
    if active_raw is None or active_raw.strip() != args.activation_attempt.encode("ascii"):
        raise _fail("original activation helper no longer owns its active lease")
    _, helper_id = _validate_helper(
        control, str(receipt.get("helper_container")), args.activation_attempt,
    )
    if not CONTAINER_RE.fullmatch(helper_id):
        raise _fail("original activation helper container identity is invalid")
    result_path = activation_root + "/result.json"
    result_raw = _read_control_bytes(control, result_path, optional=True)
    current_raw = _read_control_bytes(control, "activation/current.json", optional=True)
    if current_raw is None:
        raise _fail("original activation current pointer is missing")
    current = _strict_object(current_raw, "original activation current pointer")
    if current.get("attempt") == args.activation_attempt:
        raise _fail("original activation current pointer unexpectedly targets this unknown attempt")
    terminal_raw = _read_control_bytes(
        control, activation_root + "/terminal.json", optional=True,
    )
    if terminal_raw is not None:
        raise _fail("original activation already has a terminal outside this recovery")

    process_raw, process = _read_original_process_receipt(backend_id)
    ready_owner = _validate_original_process(process)
    _preflight_terminal_process_receipt(backend, control)

    environment = _explicit_activation_environment(compose)
    scope = _discover_scope(backend_id)
    expected_run = retirement_context.get("run_id")
    expected_session = retirement_context.get("session_id")
    if expected_run is not None and scope.get("run_id") != expected_run:
        raise _fail("live accepted run differs from the retained startup retirement scope")
    if expected_session is not None and scope.get("session_id") != expected_session:
        raise _fail("live session differs from the retained startup retirement scope")
    probe = _failed_preparation_store_probe(
        backend_id,
        run_id=str(scope["run_id"]),
        task_id=str(scope["task_id"]),
        request_id=request_id,
        source_sha256=source_sha256,
        marker_path=marker_path,
        expected_scene_revision=int(scope["scene_revision"]),
        environment=environment,
    )
    cancellation = _validate_failed_preparation_probe(
        probe,
        request_id=request_id,
        source_sha256=source_sha256,
        expected_run_id=str(scope["run_id"]),
        expected_session_id=str(scope["session_id"]),
    )
    if cancellation.get("live_api_instance_id") != scope["api_instance_id"]:
        raise _fail("run discovery and locked cancellation probe observed different API instances")
    if cancellation.get("activation_marker_sha256") != probe.get("activation_marker_sha256"):
        raise _fail("failed preparation proof marker digest differs")

    return {
        "selected": selected,
        "identity": identity,
        "control": control,
        "config_sha256": args.config_sha256,
        "previous": dict(previous),
        "compose": dict(compose),
        "pin": dict(pin),
        "state_root": str(previous["state_root"]),
        "image_id": str(image_id),
        "backend": backend,
        "frontend": frontend,
        "backend_container": backend_id,
        "frontend_container": frontend_id,
        "backend_started_at": str(backend_state["StartedAt"]),
        "frontend_started_at": str(frontend_state["StartedAt"]),
        "receipt": dict(receipt),
        "receipt_raw": receipt_raw,
        "receipt_sha256": _sha256(receipt_raw),
        "retirement_context": dict(retirement_context),
        "helper_id": helper_id,
        "active_raw": active_raw,
        "result_raw": result_raw,
        "current_raw": current_raw,
        "terminal_path": activation_root + "/terminal.json",
        "process_raw": process_raw,
        "process": process,
        "ready_owner": ready_owner,
        "ready_owner_identity_sha256": _identity_hash(ready_owner),
        "request_id": request_id,
        "source_sha256": source_sha256,
        "marker_path": marker_path,
        "cancellation": cancellation,
    }


def _plan(proof: Mapping[str, object]) -> dict[str, object]:
    cancellation = proof.get("cancellation")
    if not isinstance(cancellation, Mapping):
        raise _fail("cancelled preparation proof is missing")
    body: dict[str, object] = {
        "schema": PLAN_SCHEMA,
        "state": "ready-for-explicit-apply",
        "target": {
            "compose_project": proof["identity"]["project_name"],
            "control_volume": proof["control"].volume,
            "control_namespace": proof["control"].namespace,
            "development_attempt": proof["previous"]["attempt"],
            "iteration_attempt": proof["pin"]["attempt"],
            "activation_attempt": proof["receipt"]["attempt"],
            "config_sha256": proof["config_sha256"],
            "source_root": str(proof["selected"]),
            "image_id": proof["image_id"],
            "backend_container": proof["backend"]["Id"],
            "backend_started_at": proof["backend_started_at"],
            "frontend_container": proof["frontend"]["Id"],
            "frontend_started_at": proof["frontend_started_at"],
            "state_root": proof["state_root"],
            "request_id": proof["request_id"],
            "source_sha256": proof["source_sha256"],
            "original_receipt_sha256": proof["receipt_sha256"],
            "helper_container_id": proof["helper_id"],
            "original_process_receipt_sha256": _sha256(proof["process_raw"]),
            "activation_current_sha256": _sha256(proof["current_raw"]),
            "activation_result_sha256": (
                _sha256(proof["result_raw"]) if proof["result_raw"] is not None else None
            ),
            "run_id": cancellation["run_id"],
            "session_id": cancellation["session_id"],
            "task_id": cancellation["task_id"],
        },
        "cancellation_proof": dict(cancellation),
        "stop": {
            "command": ["docker", "stop", "--time", "60", str(proof["backend"]["Id"])],
            "scope": "the exact pinned backend container only",
        },
        "post_stop": [
            "require the same container ID, image, and StartedAt with Running=false, OOMKilled=false, and exit code 0",
            "authenticate the image-owned terminal process receipt as drained",
            "match Ready and drained native owner identities and require every native child exited_success",
            "publish identical immutable/current recovery records before the original activation terminal",
            "wait for the original activation helper to release its own active lease",
        ],
        "preserved": [
            "original activation receipt, result, and current pointer bytes",
            "accepted SessionStore, run/task records, runtime-control namespace, and all Docker volumes",
            "frontend container and state root",
            "original Ready process receipt in the recovery journal",
        ],
        "continuation": {
            "restart_policy": "fresh-state-only",
            "execution_state": "not-started",
            "archive_present": False,
            "solve_or_retry": False,
            "backend_restart": False,
            "frontend_stop_or_restart": False,
            "volume_removal": False,
            "runtime_namespace_retirement": False,
        },
    }
    return {**body, "plan_sha256": _sha256(canonical(body))}


def _plan_from_journal(journal: Mapping[str, object]) -> dict[str, object]:
    saved = journal.get("plan")
    if not isinstance(saved, Mapping) or saved.get("schema") != PLAN_SCHEMA:
        raise _fail("cancelled activation journal has no canonical reviewed plan")
    body = dict(saved)
    digest = body.pop("plan_sha256", None)
    if not isinstance(digest, str) or _sha256(canonical(body)) != digest:
        raise _fail("cancelled activation journal plan digest is invalid")
    return dict(saved)


def _journal_path(activation_attempt: str) -> str:
    _require(activation_attempt, ATTEMPT_RE, "activation attempt")
    return f"verification/cancelled-activation-{activation_attempt}/journal.json"


def _recovery_terminal_path(activation_attempt: str) -> str:
    _require(activation_attempt, ATTEMPT_RE, "activation attempt")
    return f"verification/cancelled-activation-{activation_attempt}/terminal.json"


def _record_from_journal(journal: Mapping[str, object]) -> dict[str, object]:
    plan = _plan_from_journal(journal)
    target = plan["target"]
    cancellation = plan["cancellation_proof"]
    drain = journal.get("drain")
    if not isinstance(target, Mapping) or not isinstance(cancellation, Mapping) or not isinstance(drain, Mapping):
        raise _fail("drain-confirmed journal is incomplete")
    return {
        "schema": RECOVERY_SCHEMA,
        "state": RECOVERY_STATE,
        "activation_attempt": target["activation_attempt"],
        "development_attempt": target["development_attempt"],
        "iteration_attempt": target["iteration_attempt"],
        "config_sha256": target["config_sha256"],
        "source_root": target["source_root"],
        "image_id": target["image_id"],
        "backend_container": target["backend_container"],
        "backend_started_at": target["backend_started_at"],
        "frontend_container": target["frontend_container"],
        "frontend_started_at": target["frontend_started_at"],
        "state_root": target["state_root"],
        "request_id": target["request_id"],
        "source_sha256": target["source_sha256"],
        "original_receipt_sha256": target["original_receipt_sha256"],
        "helper_container_id": target["helper_container_id"],
        "restart_policy": "fresh-state-only",
        "execution_state": "not-started",
        "compose_project": target["compose_project"],
        "control_volume": target["control_volume"],
        "control_namespace": target["control_namespace"],
        "run_id": target["run_id"],
        "session_id": target["session_id"],
        "task_id": target["task_id"],
        "journal_path": journal["journal_path"],
        "journal_sha256": _sha256(canonical(dict(journal)) + b"\n"),
        "proof": dict(cancellation),
        "drain": dict(drain),
        "confirmed_at": journal.get("drain_confirmed_at"),
        "stop_command_return_code": journal.get("docker_stop_command_return_code"),
        "stop_response": journal.get("stop_response"),
        "archive_present": False,
        "successor_marker_present": False,
        "solve_or_retry": False,
    }


def _activation_terminal(
    receipt: Mapping[str, object],
    *,
    recovery_sha256: str,
    recovery_path: str,
    journal: Mapping[str, object],
) -> dict[str, object]:
    drain = journal.get("drain")
    if not isinstance(drain, Mapping):
        raise _fail("drain-confirmed journal has no terminal drain")
    terminal = dict(receipt)
    terminal.update(
        state="failed-confirmed",
        activation_state=ACTIVATION_TERMINAL_STATE,
        cancelled_recovery_path=recovery_path,
        cancelled_recovery_sha256=recovery_sha256,
        cancelled_recovery_journal_path=journal["journal_path"],
        terminal_process_receipt_sha256=drain["process_receipt_sha256"],
        backend_container_id=drain["backend_container"],
        backend_image_id=drain["image_id"],
        backend_started_at=drain["backend_started_at"],
        backend_exit_code=drain["backend_exit_code"],
        archive_present=False,
        execution_state="not-started",
        restart_policy="fresh-state-only",
    )
    return terminal


def _publish_cas(
    control: BuildControl,
    relative: str,
    document: Mapping[str, object],
    *,
    expected_raw: bytes | None,
) -> bytes:
    path = control.path(relative)
    parent = path.rsplit("/", 1)[0]
    lock_path = control.path("verification/.cancelled-activation-recovery.lock")
    raw = canonical(dict(document)) + b"\n"
    if len(raw) > MAX_RECORD_BYTES:
        raise _fail("cancelled activation record exceeds its byte bound")
    new_sha = _sha256(raw)
    expected_sha = "ABSENT" if expected_raw is None else _sha256(expected_raw)
    temporary_template = parent + "/.cancelled-activation.XXXXXXXX"
    command = (
        "set -euo pipefail; umask 027; "
        f'mkdir -p {shlex.quote(parent)}; test "$(readlink -f {shlex.quote(parent)})" = {shlex.quote(parent)}; '
        f"test ! -L {shlex.quote(lock_path)}; exec 9>{shlex.quote(lock_path)}; flock -x 9; "
        f"test ! -L {shlex.quote(path)}; "
        f"if test -e {shlex.quote(path)}; then test -f {shlex.quote(path)}; "
        f'test "$(stat -c %h {shlex.quote(path)})" = 1; '
        f"current=$(sha256sum {shlex.quote(path)} | cut -d ' ' -f 1); "
        f'if test "$current" = "{new_sha}"; then printf "%s\\\\n" SAME; exit 0; fi; '
        f'test "{expected_sha}" != ABSENT; test "$current" = "{expected_sha}"; '
        f"else test '{expected_sha}' = ABSENT; fi; "
        f"temporary=$(mktemp {shlex.quote(temporary_template)}); "
        "trap 'rm -f -- \"$temporary\"' EXIT; cat > \"$temporary\"; sync \"$temporary\"; "
        f'test "$(sha256sum "$temporary" | cut -d " " -f 1)" = "{new_sha}"; '
        f"if test '{expected_sha}' = ABSENT; then "
        f"if ln -- \"$temporary\" {shlex.quote(path)}; then rm -- \"$temporary\"; sync {shlex.quote(parent)}; printf \"%s\\\\n\" PUBLISHED; "
        f"else test -f {shlex.quote(path)}; test ! -L {shlex.quote(path)}; "
        f'test "$(sha256sum {shlex.quote(path)} | cut -d " " -f 1)" = "{new_sha}"; '
        "printf \"%s\\\\n\" SAME; fi; "
        f"else mv -T -- \"$temporary\" {shlex.quote(path)}; sync {shlex.quote(parent)}; printf \"%s\\\\n\" PUBLISHED; fi"
    )
    result = bounded_capture(control.helper_args(command), data=raw, timeout=90)
    if result.returncode:
        raise ControlOutcomeUnknown(
            "cancelled activation record publication is unknown; retained journal and Docker state require inspection: "
            + result.stderr.decode("utf-8", "replace")[-1024:]
        )
    observed = _read_control_bytes(control, relative, maximum=MAX_RECORD_BYTES)
    if observed != raw:
        raise ControlOutcomeUnknown("cancelled activation control-record readback differs")
    return raw


def _preserve_original_records(
    control: BuildControl,
    activation_attempt: str,
    pins: Mapping[str, object],
) -> None:
    root = "activation/attempts/" + activation_attempt
    receipt = _read_control_bytes(control, root + "/receipt.json")
    result = _read_control_bytes(control, root + "/result.json", optional=True)
    current = _read_control_bytes(control, "activation/current.json", optional=True)
    terminal = _read_control_bytes(control, root + "/terminal.json", optional=True)
    if (receipt != pins["receipt_raw"]
            or result != pins["result_raw"]
            or current != pins["activation_current_raw"]):
        raise ControlOutcomeUnknown("original activation receipt, result, or current pointer changed")
    if terminal is not None and terminal != pins.get("activation_terminal_raw"):
        raise ControlOutcomeUnknown("original activation terminal differs from its recovery-published bytes")


def _inspect_exact_backend(proof: Mapping[str, object]) -> dict[str, Any]:
    identifier = str(proof["backend_container"])
    result = docker_capture("inspect", identifier, timeout=60)
    try:
        rows = json.loads(result.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise _fail("exact backend inspection is not valid JSON") from error
    if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], Mapping):
        raise _fail("exact backend inspection is ambiguous")
    return dict(rows[0])


def _verify_frontend_unchanged(
    proof: Mapping[str, object],
    *,
    require_running: bool,
) -> None:
    identifier = str(proof["frontend_container"])
    result = docker_capture("inspect", identifier, timeout=60)
    rows = json.loads(result.stdout)
    if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], Mapping):
        raise _fail("pinned frontend inspection is ambiguous")
    frontend = rows[0]
    state = frontend.get("State")
    if (frontend.get("Id") != identifier
            or not isinstance(state, Mapping)
            or state.get("StartedAt") != proof["frontend_started_at"]
            or (require_running and state.get("Running") is not True)):
        raise _fail("frontend incarnation changed during cancelled activation recovery")


def _validate_stopped_incarnation(
    proof: Mapping[str, object],
    *,
    allow_running: bool,
) -> dict[str, Any]:
    actual = _inspect_exact_backend(proof)
    state = actual.get("State")
    if (actual.get("Id") != proof.get("backend_container")
            or actual.get("Image") != proof.get("image_id")
            or not isinstance(state, Mapping)
            or state.get("StartedAt") != proof.get("backend_started_at")):
        raise _fail("backend ID, image, or StartedAt differs from the journaled incarnation")
    if allow_running and state.get("Running") is True:
        return actual
    if state.get("Running") is not False:
        raise ControlOutcomeUnknown("journaled stop has not produced an inspectable stopped backend")
    return actual


def _read_journal(control: BuildControl, relative: str) -> tuple[dict[str, Any] | None, bytes | None]:
    raw = _read_control_bytes(control, relative, optional=True, maximum=MAX_RECORD_BYTES)
    if raw is None:
        return None, None
    return _strict_object(raw, "cancelled activation stop journal"), raw


def _proof_from_journal(
    args: argparse.Namespace,
    selected: Any,
    identity: Mapping[str, object],
    control: BuildControl,
    journal: Mapping[str, object],
) -> dict[str, Any]:
    plan = _plan_from_journal(journal)
    target = plan.get("target")
    cancellation = plan.get("cancellation_proof")
    if not isinstance(target, Mapping) or not isinstance(cancellation, Mapping):
        raise _fail("stop journal has incomplete immutable proof pins")
    expected = {
        "development_attempt": args.attempt,
        "iteration_attempt": args.iteration_attempt,
        "activation_attempt": args.activation_attempt,
        "config_sha256": args.config_sha256,
        "source_root": str(selected),
        "compose_project": control.project,
        "control_volume": control.volume,
        "control_namespace": control.namespace,
    }
    if any(target.get(key) != value for key, value in expected.items()):
        raise _fail("stop journal belongs to another selected development/control identity")
    if journal.get("schema") != JOURNAL_SCHEMA or journal.get("journal_path") != _journal_path(args.activation_attempt):
        raise _fail("cancelled activation stop journal schema/path differs")
    raw_process_b64 = journal.get("original_process_receipt_b64")
    if not isinstance(raw_process_b64, str):
        raise _fail("stop journal does not retain the original Ready process receipt")
    try:
        process_raw = base64.b64decode(raw_process_b64, validate=True)
    except (ValueError, base64.binascii.Error) as error:
        raise _fail("journaled original process receipt encoding is invalid") from error
    if (_sha256(process_raw) != target.get("original_process_receipt_sha256")
            or len(process_raw) > MAX_PROCESS_RECEIPT_BYTES):
        raise _fail("journaled original process receipt digest differs")
    process = _strict_object(process_raw, "journaled original Ready process receipt",
                             maximum=MAX_PROCESS_RECEIPT_BYTES)
    owner = _validate_original_process(process)
    if _identity_hash(owner) != journal.get("ready_owner_identity_sha256"):
        raise _fail("journaled Ready owner identity digest differs")
    original = _read_pinned_original_records(
        control, args.activation_attempt, target,
    )
    active_raw = _read_control_bytes(control, "active", optional=True, maximum=256)
    if active_raw is not None and active_raw.strip() != args.activation_attempt.encode("ascii"):
        raise ControlOutcomeUnknown("control active lease belongs to a different operation")
    proof = {
        "selected": selected,
        "identity": dict(identity),
        "control": control,
        "previous": {"attempt": args.attempt, "config_sha256": args.config_sha256},
        "compose": {},
        "pin": {"attempt": args.iteration_attempt},
        "config_sha256": args.config_sha256,
        "state_root": target["state_root"],
        "image_id": target["image_id"],
        "backend": {"Id": target["backend_container"]},
        "frontend": {"Id": target["frontend_container"]},
        "backend_container": target["backend_container"],
        "frontend_container": target["frontend_container"],
        "backend_started_at": target["backend_started_at"],
        "frontend_started_at": target["frontend_started_at"],
        "receipt": original["receipt"],
        "receipt_raw": original["receipt_raw"],
        "receipt_sha256": target["original_receipt_sha256"],
        "helper_id": target["helper_container_id"],
        "active_raw": active_raw,
        "result_raw": original["result_raw"],
        "current_raw": original["activation_current_raw"],
        "process_raw": process_raw,
        "process": process,
        "ready_owner": owner,
        "ready_owner_identity_sha256": journal["ready_owner_identity_sha256"],
        "request_id": target["request_id"],
        "source_sha256": target["source_sha256"],
        "cancellation": dict(cancellation),
        "terminal_path": "activation/attempts/" + args.activation_attempt + "/terminal.json",
    }
    return proof


def _read_pinned_original_records(
    control: BuildControl,
    activation_attempt: str,
    target: Mapping[str, object],
) -> dict[str, object]:
    root = "activation/attempts/" + activation_attempt
    receipt_raw = _read_control_bytes(control, root + "/receipt.json")
    result_raw = _read_control_bytes(control, root + "/result.json", optional=True)
    current_raw = _read_control_bytes(control, "activation/current.json", optional=True)
    if (_sha256(receipt_raw) != target.get("original_receipt_sha256")
            or (None if result_raw is None else _sha256(result_raw)) != target.get("activation_result_sha256")
            or (None if current_raw is None else _sha256(current_raw)) != target.get("activation_current_sha256")):
        raise ControlOutcomeUnknown("original activation records differ from the reviewed stop journal")
    receipt = _strict_object(receipt_raw, "original unknown activation receipt")
    current = _strict_object(current_raw, "original activation current pointer") if current_raw else None
    if (receipt.get("attempt") != activation_attempt
            or receipt.get("state") != "outcome-unknown-resources-retained"
            or not isinstance(receipt.get("inputs"), Mapping)
            or (current is not None and current.get("attempt") == activation_attempt)):
        raise ControlOutcomeUnknown("original activation is no longer the journaled unknown operation")
    terminal_path = root + "/terminal.json"
    terminal_raw = _read_control_bytes(control, terminal_path, optional=True)
    return {
        "receipt_raw": receipt_raw,
        "receipt": receipt,
        "result_raw": result_raw,
        "activation_current_raw": current_raw,
        "activation_terminal_raw": terminal_raw,
    }


def _validate_helper_and_active(
    control: BuildControl,
    activation_attempt: str,
    *,
    expected_helper_id: str,
    require_active: bool,
) -> bytes | None:
    active_raw = _read_control_bytes(control, "active", optional=True, maximum=256)
    if require_active:
        if active_raw is None or active_raw.strip() != activation_attempt.encode("ascii"):
            raise ControlOutcomeUnknown("original activation helper no longer owns the active lease")
    elif active_raw is None:
        return None
    if active_raw is not None:
        if active_raw.strip() != activation_attempt.encode("ascii"):
            raise ControlOutcomeUnknown("control active lease belongs to a different operation")
        receipt, _ = _read_control_record(
            control, "activation/attempts/" + activation_attempt + "/receipt.json",
        )
        if not isinstance(receipt, Mapping):
            raise _fail("original activation receipt is missing")
        _, helper_id = _validate_helper(
            control, str(receipt.get("helper_container")), activation_attempt,
        )
        if helper_id != expected_helper_id:
            raise ControlOutcomeUnknown("original activation helper incarnation changed")
    return active_raw


def _verify_drained_backend(
    proof: Mapping[str, object],
    *,
    control: BuildControl,
    journal: Mapping[str, object],
) -> dict[str, object]:
    stopped = _validate_stopped_incarnation(proof, allow_running=False)
    raw, receipt = _read_terminal_process_receipt(stopped, control)
    drain = _validate_drain(
        stopped, raw, receipt, proof=proof, ready_owner=proof["ready_owner"],
    )
    original_raw_b64 = journal.get("original_process_receipt_b64")
    if not isinstance(original_raw_b64, str):
        raise _fail("stop journal omitted original Ready process receipt bytes")
    if _sha256(base64.b64decode(original_raw_b64, validate=True)) != journal.get(
        "target", {},
    ).get("original_process_receipt_sha256"):
        raise _fail("original Ready process receipt is not preserved in the journal")
    _verify_frontend_unchanged(proof, require_running=True)
    return drain


def _publish_recovery_and_activation_terminal(
    args: argparse.Namespace,
    proof: Mapping[str, object],
    journal: dict[str, Any],
    journal_raw: bytes,
    pins: Mapping[str, object],
    control: BuildControl,
) -> dict[str, object]:
    _preserve_original_records(control, args.activation_attempt, pins)
    _verify_frontend_unchanged(proof, require_running=True)
    recovery_path = _recovery_terminal_path(args.activation_attempt)
    recovery_record = _record_from_journal(journal)
    recovery_raw = canonical(recovery_record) + b"\n"
    recovery_sha = _sha256(recovery_raw)
    existing_terminal = _read_control_bytes(control, recovery_path, optional=True)
    if existing_terminal is None:
        _publish_cas(control, recovery_path, recovery_record, expected_raw=None)
    elif existing_terminal != recovery_raw:
        raise ControlOutcomeUnknown("immutable cancelled-activation recovery terminal differs from the drain journal")
    existing_current = _read_control_bytes(control, RECOVERY_CURRENT, optional=True)
    if existing_current is None:
        _publish_cas(control, RECOVERY_CURRENT, recovery_record, expected_raw=None)
    elif existing_current != recovery_raw:
        raise ControlOutcomeUnknown("cancelled-activation recovery current pointer belongs to another generation")
    if (_read_control_bytes(control, recovery_path) != recovery_raw
            or _read_control_bytes(control, RECOVERY_CURRENT) != recovery_raw):
        raise ControlOutcomeUnknown("immutable and current cancelled-activation recovery records differ")

    active_raw = _validate_helper_and_active(
        control,
        args.activation_attempt,
        expected_helper_id=str(proof["helper_id"]),
        require_active=False,
    )
    activation_terminal_path = str(proof["terminal_path"])
    terminal = _activation_terminal(
        pins["receipt"],
        recovery_sha256=recovery_sha,
        recovery_path=recovery_path,
        journal=journal,
    )
    terminal_raw = canonical(terminal) + b"\n"
    existing_activation_terminal = _read_control_bytes(
        control, activation_terminal_path, optional=True,
    )
    if existing_activation_terminal is None:
        if active_raw is None or active_raw.strip() != args.activation_attempt.encode("ascii"):
            raise ControlOutcomeUnknown("original activation helper lease disappeared before its terminal")
        _validate_helper_and_active(
            control,
            args.activation_attempt,
            expected_helper_id=str(proof["helper_id"]),
            require_active=True,
        )
        _publish_cas(control, activation_terminal_path, terminal, expected_raw=None)
    elif existing_activation_terminal != terminal_raw:
        raise ControlOutcomeUnknown("original activation terminal differs from the recovery-bound drain")
    if _read_control_bytes(control, activation_terminal_path) != terminal_raw:
        raise ControlOutcomeUnknown("original activation terminal readback differs")
    if not _wait_retirement_lease_release(control, operation_id=args.activation_attempt):
        raise ControlOutcomeUnknown(
            "cancelled startup drain is confirmed, but the original helper has not released its active lease"
        )
    pins_after = dict(pins, activation_terminal_raw=terminal_raw)
    _preserve_original_records(control, args.activation_attempt, pins_after)
    if _read_control_bytes(control, recovery_path) != recovery_raw:
        raise ControlOutcomeUnknown("immutable recovery terminal changed after activation lease release")
    return {
        "schema": RECOVERY_SCHEMA,
        "state": RECOVERY_STATE,
        "recovery_terminal_path": recovery_path,
        "recovery_current_path": RECOVERY_CURRENT,
        "recovery_sha256": recovery_sha,
        "activation_terminal_path": activation_terminal_path,
        "activation_terminal_sha256": _sha256(terminal_raw),
        "original_receipt_sha256": proof["receipt_sha256"],
        "backend_container": proof["backend"]["Id"],
        "backend_exit_code": journal["drain"]["backend_exit_code"],
        "restart_policy": "fresh-state-only",
        "execution_state": "not-started",
        "archive_present": False,
        "active_lease_released": True,
        "original_records_preserved": True,
    }


def _initial_journal(
    args: argparse.Namespace,
    proof: Mapping[str, object],
    reviewed_plan: Mapping[str, object],
    control: BuildControl,
) -> dict[str, object]:
    target = reviewed_plan["target"]
    return {
        "schema": JOURNAL_SCHEMA,
        "state": "prepared",
        "plan_sha256": reviewed_plan["plan_sha256"],
        "journal_path": _journal_path(args.activation_attempt),
        "plan": dict(reviewed_plan),
        "target": dict(target),
        "proof": dict(reviewed_plan["cancellation_proof"]),
        "compose_project": control.project,
        "control_namespace": control.namespace,
        "activation_receipt_b64": base64.b64encode(proof["receipt_raw"]).decode("ascii"),
        "original_process_receipt_b64": base64.b64encode(proof["process_raw"]).decode("ascii"),
        "ready_owner_identity_sha256": proof["ready_owner_identity_sha256"],
        "original_result_b64": (
            base64.b64encode(proof["result_raw"]).decode("ascii")
            if proof["result_raw"] is not None else None
        ),
        "original_activation_current_b64": base64.b64encode(proof["current_raw"]).decode("ascii"),
        "journal_started_at": time.time(),
        "stop_command": ["docker", "stop", "--time", "60", str(proof["backend"]["Id"])],
        "stop_response": "not-issued",
        "execution_state": "not-started",
        "archive_present": False,
    }


def _validate_journal_pins(
    args: argparse.Namespace,
    journal: Mapping[str, object],
    proof: Mapping[str, object],
    reviewed_plan: Mapping[str, object],
) -> None:
    if (journal.get("schema") != JOURNAL_SCHEMA
            or journal.get("journal_path") != _journal_path(args.activation_attempt)
            or journal.get("plan_sha256") != reviewed_plan["plan_sha256"]
            or journal.get("plan") != dict(reviewed_plan)):
        raise _fail("existing cancelled activation journal differs from the reviewed plan")
    target = journal.get("target")
    if not isinstance(target, Mapping) or target != reviewed_plan["target"]:
        raise _fail("existing cancelled activation journal target pins changed")
    if journal.get("state") not in {
        "prepared", "stop-issued", "stop-command-confirmed", "drain-confirmed",
    }:
        raise _fail("existing cancelled activation journal is not resumable")
    process_b64 = journal.get("original_process_receipt_b64")
    receipt_b64 = journal.get("activation_receipt_b64")
    current_b64 = journal.get("original_activation_current_b64")
    if not all(isinstance(value, str) for value in (process_b64, receipt_b64, current_b64)):
        raise _fail("existing cancelled activation journal omits preserved original records")
    try:
        process_raw = base64.b64decode(process_b64, validate=True)
        receipt_raw = base64.b64decode(receipt_b64, validate=True)
        current_raw = base64.b64decode(current_b64, validate=True)
    except (ValueError, base64.binascii.Error) as error:
        raise _fail("existing cancelled activation journal contains invalid base64 evidence") from error
    if (_sha256(process_raw) != target.get("original_process_receipt_sha256")
            or _sha256(receipt_raw) != target.get("original_receipt_sha256")
            or _sha256(current_raw) != target.get("activation_current_sha256")):
        raise _fail("existing cancelled activation journal original evidence digests differ")
    _preserve_original_records(
        proof["control"],
        args.activation_attempt,
        {
            "receipt_raw": receipt_raw,
            "result_raw": (
                base64.b64decode(journal["original_result_b64"], validate=True)
                if isinstance(journal.get("original_result_b64"), str) else None
            ),
            "activation_current_raw": current_raw,
            "activation_terminal_raw": _read_control_bytes(
                proof["control"],
                "activation/attempts/" + args.activation_attempt + "/terminal.json",
                optional=True,
            ),
        },
    )


def _resume_pins_from_journal(
    control: BuildControl,
    args: argparse.Namespace,
    proof: Mapping[str, object],
    journal: Mapping[str, object],
) -> dict[str, object]:
    target = journal.get("target")
    if not isinstance(target, Mapping):
        raise _fail("cancelled activation journal has no target pins")
    pins = _read_pinned_original_records(control, args.activation_attempt, target)
    if pins["activation_terminal_raw"] is not None:
        terminal = _strict_object(pins["activation_terminal_raw"], "original activation terminal")
        if (terminal.get("state") != "failed-confirmed"
                or terminal.get("activation_state") != ACTIVATION_TERMINAL_STATE):
            raise _fail("existing original activation terminal is not this recovery outcome")
    pins["helper_id"] = target["helper_container_id"]
    return pins


def _verify_saved_drain(
    proof: Mapping[str, object],
    journal: Mapping[str, object],
) -> dict[str, object]:
    observed = _verify_drained_backend(
        proof, control=proof["control"], journal=journal,
    )
    saved = journal.get("drain")
    if saved is not None and (not isinstance(saved, Mapping) or dict(saved) != observed):
        raise ControlOutcomeUnknown("authenticated drain differs from the retained journal")
    return observed


def _assert_pre_stop_barrier(
    original: Mapping[str, object],
    fresh: Mapping[str, object],
    expected_plan: Mapping[str, object],
) -> None:
    fresh_plan = _plan(fresh)
    if fresh_plan.get("plan_sha256") != expected_plan.get("plan_sha256"):
        raise ControlOutcomeUnknown("cancelled activation plan changed at the immediate pre-stop barrier")
    for key in ("receipt_raw", "active_raw", "helper_id", "process_raw", "current_raw", "result_raw"):
        if fresh.get(key) != original.get(key):
            raise ControlOutcomeUnknown(
                "activation, helper, process receipt, or current pointer changed before stop"
            )


def _issue_backend_stop(
    args: argparse.Namespace,
    control: BuildControl,
    proof: Mapping[str, object],
    journal: dict[str, Any],
    journal_raw: bytes,
) -> tuple[dict[str, Any], bytes]:
    if journal.get("state") != "prepared":
        raise _fail("backend stop can only be issued from a fresh prepared journal")
    issued = dict(
        journal,
        state="stop-issued",
        stop_response="pending",
        stop_issued_at=time.time(),
    )
    journal_raw = _publish_cas(
        control, _journal_path(args.activation_attempt), issued, expected_raw=journal_raw,
    )
    # No further observation is inserted between the durable stop-issued
    # generation and this one exact Docker stop. Any response loss leaves a
    # state that can only be inspected, never stopped again.
    try:
        command = docker_capture(
            "stop", "--time", "60", str(proof["backend_container"]),
            timeout=90, allow_failure=True,
        )
    except Exception as error:
        raise ControlOutcomeUnknown(
            "backend stop response was lost; the durable stop-issued journal prevents replay"
        ) from error
    if command.returncode != 0:
        raise ControlOutcomeUnknown(
            "managed Docker stop returned nonzero; the stop-issued journal prevents replay"
        )
    confirmed = dict(
        issued,
        state="stop-command-confirmed",
        docker_stop_command_return_code=0,
        stop_response="confirmed",
    )
    journal_raw = _publish_cas(
        control, _journal_path(args.activation_attempt), confirmed, expected_raw=journal_raw,
    )
    return confirmed, journal_raw


def preview(args: argparse.Namespace) -> dict[str, object]:
    proof = _build_proof(args)
    reviewed_plan = _plan(proof)
    return reviewed_plan


def _apply(args: argparse.Namespace) -> dict[str, object]:
    expected = getattr(args, "expected_plan_sha256", None)
    if not isinstance(expected, str) or SHA256_RE.fullmatch(expected) is None:
        raise _fail("apply requires --expected-plan-sha256 with the reviewed plan digest")
    selected, identity, control = _selected_context(args)
    journal_rel = _journal_path(args.activation_attempt)
    journal, journal_raw = _read_journal(control, journal_rel)
    if journal is None:
        proof = _build_proof(args)
        reviewed_plan = _plan(proof)
        if expected != reviewed_plan["plan_sha256"]:
            raise _fail("reviewed plan SHA-256 does not match fresh cancelled-activation evidence")
        initial = _initial_journal(args, proof, reviewed_plan, control)
        journal_raw = _publish_cas(control, journal_rel, initial, expected_raw=None)
        journal = initial
        barrier_proof = _build_proof(args)
        _assert_pre_stop_barrier(proof, barrier_proof, reviewed_plan)
        journal, journal_raw = _issue_backend_stop(
            args, control, barrier_proof, journal, journal_raw,
        )
    else:
        saved_plan = _plan_from_journal(journal)
        if expected != saved_plan["plan_sha256"]:
            raise _fail("expected plan digest differs from the retained stop journal")
        proof = _proof_from_journal(args, selected, identity, control, journal)
        _validate_journal_pins(args, journal, proof, saved_plan)
        target = saved_plan["target"]
        actual = _inspect_exact_backend(target)
        state = actual.get("State")
        if (not isinstance(state, Mapping)
                or state.get("StartedAt") != target.get("backend_started_at")
                or actual.get("Image") != target.get("image_id")
                or actual.get("Id") != target.get("backend_container")):
            raise _fail("journaled backend incarnation changed before stop recovery")
        if journal.get("state") == "prepared":
            if state.get("Running") is not True:
                raise ControlOutcomeUnknown(
                    "backend is no longer running under a prepared journal; no stop was issued"
                )
            fresh_proof = _build_proof(args)
            _assert_pre_stop_barrier(proof, fresh_proof, saved_plan)
            journal, journal_raw = _issue_backend_stop(
                args, control, fresh_proof, journal, journal_raw or b"",
            )
            proof = fresh_proof
        else:
            if state.get("Running") is True:
                raise ControlOutcomeUnknown(
                    "backend remains running after a durable stop-issued intent; stop will not be replayed"
                )
            if state.get("Running") is not False:
                raise ControlOutcomeUnknown("journaled backend running state is not definitive")
            _verify_frontend_unchanged(proof, require_running=True)
            if journal.get("docker_stop_command_return_code") == 0:
                if journal.get("stop_response") != "confirmed":
                    raise _fail("stop response journal fields disagree")
            elif journal.get("stop_response") != "pending":
                raise _fail("stop response state is invalid")
            journal_raw = journal_raw or b""

    if journal.get("state") == "drain-confirmed":
        drain = _verify_saved_drain(proof, journal)
    else:
        actual = _validate_stopped_incarnation(proof, allow_running=False)
        raw, receipt = _read_terminal_process_receipt(actual, control)
        drain = _validate_drain(
            actual, raw, receipt, proof=proof, ready_owner=proof["ready_owner"],
        )
        _verify_frontend_unchanged(proof, require_running=True)
        journal = dict(
            journal,
            state="drain-confirmed",
            drain=drain,
            drain_confirmed_at=time.time(),
        )
        journal_raw = _publish_cas(control, journal_rel, journal, expected_raw=journal_raw)

    if not isinstance(journal.get("drain"), Mapping) or dict(journal["drain"]) != drain:
        raise ControlOutcomeUnknown("authenticated backend drain differs from journal")
    pins = _resume_pins_from_journal(control, args, proof, journal)
    return _publish_recovery_and_activation_terminal(
        args, proof, journal, journal_raw or b"", pins, control,
    )


def run(args: argparse.Namespace) -> dict[str, object]:
    """Return a read-only plan, or apply/resume with an exact reviewed digest."""
    if getattr(args, "apply", False):
        return _apply(args)
    return preview(args)
