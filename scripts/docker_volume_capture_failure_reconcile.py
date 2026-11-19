"""Retain one exact stopped backend incarnation that failed source capture.

This recovery sidecar does not amend the older native stop journal. It records
the newer, capture-only Docker incarnation plus a read-only snapshot proving
that the accepted store still contains only cancelled, never-claimed tasks.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
from pathlib import Path
from typing import Mapping

import fullmag_storage as storage
from docker_build_control import (
    BuildControl,
    BuildControlError,
    canonical,
    docker_capture,
    require_host,
    toolchain_configuration,
)
from docker_compose_identity import compose_project_identity, source_labels


SCHEMA = "fullmag.docker-capture-failure-sidecar.v1"
PHASE = "capture-failure-reconcile"
MAX_LOG_BYTES = 4 * 1024 * 1024
MAX_RECORD_BYTES = 8 * 1024 * 1024
MAX_PROBE_BYTES = 2 * 1024 * 1024
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
UUID32 = re.compile(r"[0-9a-f]{32}\Z")
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z")
TIMESTAMP = re.compile(rb"^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z)\s")


_STORE_PROBE = r'''import datetime, fcntl, hashlib, json, os, pathlib, re, stat, time

MAX_FILE=1024*1024
MAX_LEDGER=16*1024*1024
MAX_ENTRIES=8192
MAX_RUNS=4096
MAX_TASKS=16384
ID=re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z")
SHA=re.compile(r"[0-9a-f]{64}\Z")
TASK_KEYS={"task_id","input_fingerprint","lifecycle","readiness","observation","attempt_id","ownership_epoch","resolved_input_fingerprint","artifact_ids","resource_id","coordinator_watermark","coordinator_genesis"}

def fail(message):
    raise RuntimeError(message)

def check_directory(path, label):
    path=pathlib.Path(path)
    st=os.lstat(path)
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
        fail(label+" is not a real directory")

def read_regular(path, label, limit=MAX_FILE):
    path=pathlib.Path(path)
    fd=os.open(path, os.O_RDONLY|getattr(os,"O_NOFOLLOW",0))
    try:
        st=os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size<0 or st.st_size>limit:
            fail(label+" is not a bounded regular file")
        data=bytearray()
        while len(data)<=limit:
            chunk=os.read(fd,min(65536,limit+1-len(data)))
            if not chunk:
                break
            data.extend(chunk)
        if len(data)!=st.st_size or len(data)>limit:
            fail(label+" changed or exceeded its bound")
        return bytes(data)
    finally:
        os.close(fd)

def read_json(path,label,limit=MAX_FILE):
    raw=read_regular(path,label,limit)
    try:
        value=json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError,json.JSONDecodeError) as error:
        raise RuntimeError(label+" is invalid JSON") from error
    if not isinstance(value,dict):
        fail(label+" is not an object")
    return raw,value

def shared_lock(path,label,deadline):
    path=pathlib.Path(path)
    fd=os.open(path,os.O_RDONLY|getattr(os,"O_NOFOLLOW",0))
    try:
        st=os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            fail(label+" is not a regular file")
        while True:
            try:
                fcntl.flock(fd,fcntl.LOCK_SH|fcntl.LOCK_NB)
                return fd
            except BlockingIOError:
                remaining=deadline-time.monotonic()
                if remaining<=0:
                    fail("timed out acquiring shared "+label+" at "+str(path)+" within 5s")
                time.sleep(min(0.025,remaining))
    except BaseException:
        os.close(fd)
        raise

def validate_catalog(run_id, raw, catalog):
    if set(catalog)!={"schema_version","run_id","revision","updated_at","tasks"}:
        fail("run catalog has an unsupported field set")
    if catalog.get("schema_version")!="run_catalog.v1" or catalog.get("run_id")!=run_id:
        fail("run catalog schema or directory identity differs")
    if type(catalog.get("revision")) is not int or catalog["revision"]<=0:
        fail("run catalog revision is invalid")
    updated=catalog.get("updated_at")
    if not isinstance(updated,str) or not updated:
        fail("run catalog update time is missing")
    # Chrono preserves nanoseconds; older Python images only accept 3 or 6
    # fraction digits in fromisoformat. Validate the UTC calendar separately
    # and retain the exact original timestamp and catalog bytes as evidence.
    updated_match=re.fullmatch(
        r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?(?:Z|\+00:00)",updated)
    if updated_match is None:
        fail("run catalog update time is not supported UTC RFC3339")
    try:
        datetime.datetime.strptime(updated_match.group(1),"%Y-%m-%dT%H:%M:%S")
    except ValueError as error:
        raise RuntimeError("run catalog update time is invalid") from error
    tasks=catalog.get("tasks")
    if not isinstance(tasks,list) or not tasks or len(tasks)>MAX_TASKS:
        fail("run catalog task inventory is empty or unbounded")
    seen=set()
    for task in tasks:
        if not isinstance(task,dict) or set(task)-TASK_KEYS or not {"task_id","input_fingerprint","lifecycle"}<=set(task):
            fail("run catalog task shape differs from FmsTaskCatalogEntry")
        task_id=task.get("task_id")
        if not isinstance(task_id,str) or ID.fullmatch(task_id) is None or task_id in seen:
            fail("run catalog task identity is invalid or repeated")
        seen.add(task_id)
        if not isinstance(task.get("input_fingerprint"),str) or SHA.fullmatch(task["input_fingerprint"]) is None:
            fail("run catalog task fingerprint is invalid")
        if task.get("lifecycle")!="cancelled":
            fail("retained accepted store contains a task that is not cancelled")
        if any(task.get(key) is not None for key in (
            "attempt_id","ownership_epoch","resource_id","coordinator_watermark","coordinator_genesis"
        )):
            fail("cancelled task has attempt, resource, epoch, or coordinator ownership")
        if task.get("resolved_input_fingerprint") is not None:
            fail("cancelled task has a resolved worker input fingerprint")
        if task.get("artifact_ids", []) != []:
            fail("cancelled task has worker artifacts")
        readiness=task.get("readiness", {"state":"ready"})
        if (not isinstance(readiness,dict)
                or (readiness.get("state")=="ready" and set(readiness)!={"state"})
                or (readiness.get("state")=="blocked" and
                    (set(readiness)!={"state","reason"} or not isinstance(readiness.get("reason"),str)
                     or not readiness["reason"].strip()))
                or readiness.get("state") not in {"ready","blocked"}):
            fail("run catalog readiness shape is invalid")
        observation=task.get("observation")
        if observation is not None and observation not in {"live","stale","disconnected","reconciling"}:
            fail("run catalog observation state is invalid")
    return {"run_id":run_id,"revision":catalog["revision"],"updated_at":updated,
            "catalog_sha256":hashlib.sha256(raw).hexdigest(),"catalog_bytes":len(raw),
            "task_ids":sorted(seen),"task_count":len(tasks)}

def scan_store():
    if os.environ.get("FULLMAG_RUNS_ROOT", "/state/runs/docker-all") != "/state/runs/docker-all":
        fail("selected accepted runs root override differs from the canonical mount")
    if os.environ.get("FULLMAG_HOST_LEDGER_ROOT", "/host-ledger/ledger") != "/host-ledger/ledger":
        fail("host ledger root override differs from the canonical mount")
    store=pathlib.Path("/state/runs/docker-all/session-store")
    ledger=pathlib.Path("/host-ledger/ledger")
    check_directory(pathlib.Path("/state/runs"),"runs root")
    check_directory(pathlib.Path("/state/runs/docker-all"),"selected runs root")
    check_directory(store,"accepted session store")
    check_directory(ledger,"host ledger root")
    locks=[]
    lock_deadline=time.monotonic()+5.0
    try:
        locks.append(shared_lock(ledger/"WRITER.lock","host ledger writer lock",lock_deadline))
        locks.append(shared_lock(store/"WRITER.lock","accepted store writer lock",lock_deadline))
        runs=store/"runs"
        check_directory(runs,"accepted run catalog root")
        catalogs=[]
        leases=[]
        entries=0
        for run in os.scandir(runs):
            if run.is_symlink() or not run.is_dir(follow_symlinks=False) or ID.fullmatch(run.name) is None:
                fail("accepted store run entry is invalid")
            if len(catalogs)>=MAX_RUNS:
                fail("accepted run inventory exceeds its bound")
            _,catalog=read_json(pathlib.Path(run.path)/"run_catalog.json","accepted run catalog")
            raw=read_regular(pathlib.Path(run.path)/"run_catalog.json","accepted run catalog")
            catalogs.append(validate_catalog(run.name,raw,catalog))
            for directory_name in ("resource_leases","preparation_resource_leases"):
                lease_root=pathlib.Path(run.path)/directory_name
                if not os.path.lexists(lease_root):
                    continue
                check_directory(lease_root,"accepted lease root")
                for resource in os.scandir(lease_root):
                    if resource.is_symlink() or not resource.is_dir(follow_symlinks=False) or ID.fullmatch(resource.name) is None:
                        fail("accepted lease resource entry is invalid")
                    for entry in os.scandir(resource.path):
                        entries+=1
                        if entries>MAX_ENTRIES or entry.is_symlink() or not entry.is_file(follow_symlinks=False) or not entry.name.endswith(".json"):
                            fail("accepted lease inventory is invalid or unbounded")
                        lease_raw,lease=read_json(entry.path,"accepted resource lease",256*1024)
                        if lease.get("state")!="released":
                            fail("accepted store has an active or unknown resource lease")
                        leases.append({"path":"runs/"+run.name+"/"+directory_name+"/"+resource.name+"/"+entry.name,
                                       "sha256":hashlib.sha256(lease_raw).hexdigest(),"state":"released"})
        if not catalogs:
            fail("accepted store has no run catalogs")
        ledger_raw,ledger_doc=read_json(ledger/"HOST_RESOURCE_LEDGER.json","host resource ledger",MAX_LEDGER)
        if ledger_doc.get("schema_version") not in {
            "host_resource_ledger.v1","host_resource_ledger.v2",
            "host_resource_ledger.v3","host_resource_ledger.v4",
        }:
            fail("host resource ledger schema is unsupported")
        ledger_reservations=ledger_doc.get("reservations")
        if not isinstance(ledger_reservations,list) or len(ledger_reservations)>MAX_ENTRIES:
            fail("host resource ledger reservation inventory is invalid")
        policy=ledger_doc.get("policy")
        if (not isinstance(policy,dict) or not isinstance(policy.get("host_id"),str)
                or ID.fullmatch(policy["host_id"]) is None):
            fail("host resource ledger has no validated host policy identity")
        check_directory(ledger/"proofs","host release proof root")
        reservations=[]
        seen_reservations=set()
        for row in ledger_reservations:
            if not isinstance(row,dict) or row.get("state")!="released":
                fail("host ledger has an active or unknown reservation")
            identity=row.get("identity")
            required_identity={"store_id","run_id","task_id","resource_id","owner","lease_token"}
            if not isinstance(identity,dict) or set(identity)!=required_identity:
                fail("host reservation identity has an unsupported shape")
            if any(not isinstance(identity.get(key),str) or not identity[key]
                   for key in ("store_id","run_id","task_id","resource_id","lease_token")):
                fail("host reservation identity contains an invalid string")
            owner=identity.get("owner")
            if not isinstance(owner,dict):
                fail("host reservation identity owner is invalid")
            if owner.get("kind")=="solver":
                if (set(owner)!={"kind","attempt_id","ownership_epoch"}
                        or not isinstance(owner.get("attempt_id"),str) or ID.fullmatch(owner["attempt_id"]) is None
                        or type(owner.get("ownership_epoch")) is not int or owner["ownership_epoch"]<=0):
                    fail("solver reservation owner identity is invalid")
            elif owner.get("kind")=="preparation":
                if (set(owner)!={"kind","preparation_attempt_id"}
                        or not isinstance(owner.get("preparation_attempt_id"),str)
                        or ID.fullmatch(owner["preparation_attempt_id"]) is None):
                    fail("preparation reservation owner identity is invalid")
            else:
                fail("host reservation owner kind is unsupported")
            identity_key=json.dumps(identity,sort_keys=True,separators=(",",":"))
            if identity_key in seen_reservations:
                fail("host reservation identity is duplicated")
            seen_reservations.add(identity_key)
            request_sha=row.get("request_sha256")
            proof_sha=row.get("release_proof_sha256")
            if not isinstance(request_sha,str) or SHA.fullmatch(request_sha) is None:
                fail("host reservation request digest is invalid")
            if not isinstance(proof_sha,str) or SHA.fullmatch(proof_sha) is None:
                fail("released host reservation has no proof digest")
            proof_raw,proof=read_json(ledger/"proofs"/(proof_sha+".json"),"host reservation release proof",64*1024)
            if (hashlib.sha256(proof_raw).hexdigest()!=proof_sha
                    or proof.get("schema_version") not in {"host_resource_release_proof.v1","host_resource_release_proof.v2"}
                    or proof.get("host_id")!=policy["host_id"]
                    or proof.get("store_id")!=identity["store_id"]
                    or proof.get("request_sha256")!=request_sha):
                fail("host reservation release proof does not match its immutable reservation")
            reservations.append({"identity":identity,"state":"released",
                                 "request_sha256":request_sha,"release_proof_sha256":proof_sha})
        reservations.sort(key=lambda item:json.dumps(item["identity"],sort_keys=True,separators=(",",":")))
        return {"schema":"fullmag.docker-capture-failure-store-probe.v1",
                "store_path":"/state/runs/docker-all/session-store",
                "catalogs":sorted(catalogs,key=lambda item:item["run_id"]),
                "lease_records":sorted(leases,key=lambda item:item["path"]),
                "lease_record_count":len(leases),
                "host_ledger":{"path":"/host-ledger/ledger/HOST_RESOURCE_LEDGER.json",
                               "sha256":hashlib.sha256(ledger_raw).hexdigest(),
                               "reservation_count":len(ledger_reservations),
                               "reservations":reservations,
                               "reservation_scope":"all ledger reservations; every row must be released"}}
    finally:
        for fd in reversed(locks):
            try:
                fcntl.flock(fd,fcntl.LOCK_UN)
            finally:
                os.close(fd)

print(json.dumps(scan_store(),sort_keys=True,separators=(",",":")))
'''


def _fail(message: str) -> None:
    raise BuildControlError(message)


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _store_safety_projection(probe: Mapping[str, object]) -> dict[str, object]:
    """Keep safety-relevant store facts stable while retaining raw ledger hashes separately."""
    if probe.get("schema") != "fullmag.docker-capture-failure-store-probe.v1":
        _fail("Capture-only store probe schema differs")
    catalogs = probe.get("catalogs")
    leases = probe.get("lease_records")
    ledger = probe.get("host_ledger")
    if not isinstance(catalogs, list) or not isinstance(leases, list) or not isinstance(ledger, Mapping):
        _fail("Capture-only store probe inventory is malformed")
    if (not isinstance(ledger.get("sha256"), str) or SHA256.fullmatch(ledger["sha256"]) is None
            or ledger.get("reservation_scope") != "all ledger reservations; every row must be released"):
        _fail("Capture-only host-ledger raw digest or scope is invalid")
    reservations = ledger.get("reservations")
    if not isinstance(reservations, list) or type(ledger.get("reservation_count")) is not int:
        _fail("Capture-only host reservation inventory is malformed")
    if ledger["reservation_count"] != len(reservations):
        _fail("Capture-only host reservation count differs from its safety inventory")
    seen = set()
    normalized_reservations = []
    for row in reservations:
        if not isinstance(row, Mapping) or row.get("state") != "released":
            _fail("Capture-only host ledger has an active or unknown reservation")
        identity = row.get("identity")
        if not isinstance(identity, Mapping) or set(identity) != {
            "store_id", "run_id", "task_id", "resource_id", "owner", "lease_token"
        }:
            _fail("Capture-only host reservation identity is malformed")
        if any(not isinstance(identity.get(key), str) or not identity[key]
               for key in ("store_id", "run_id", "task_id", "resource_id", "lease_token")):
            _fail("Capture-only host reservation identity contains invalid strings")
        owner = identity.get("owner")
        if not isinstance(owner, Mapping):
            _fail("Capture-only host reservation owner is malformed")
        if owner.get("kind") == "solver":
            if (set(owner) != {"kind", "attempt_id", "ownership_epoch"}
                    or not isinstance(owner.get("attempt_id"), str)
                    or ID.fullmatch(owner["attempt_id"]) is None
                    or type(owner.get("ownership_epoch")) is not int
                    or owner["ownership_epoch"] <= 0):
                _fail("Capture-only solver owner identity is malformed")
        elif owner.get("kind") == "preparation":
            if (set(owner) != {"kind", "preparation_attempt_id"}
                    or not isinstance(owner.get("preparation_attempt_id"), str)
                    or ID.fullmatch(owner["preparation_attempt_id"]) is None):
                _fail("Capture-only preparation owner identity is malformed")
        else:
            _fail("Capture-only host reservation owner kind is unsupported")
        identity_key = canonical(dict(identity))
        if identity_key in seen:
            _fail("Capture-only host reservation identity is duplicated")
        seen.add(identity_key)
        request_sha = row.get("request_sha256")
        proof_sha = row.get("release_proof_sha256")
        if (not isinstance(request_sha, str) or SHA256.fullmatch(request_sha) is None
                or not isinstance(proof_sha, str) or SHA256.fullmatch(proof_sha) is None):
            _fail("Capture-only host reservation request or release proof hash is invalid")
        normalized_reservations.append({
            "identity": dict(identity), "state": "released",
            "request_sha256": request_sha, "release_proof_sha256": proof_sha,
        })
    normalized_reservations.sort(key=lambda row: canonical(row["identity"]))
    return {
        "schema": probe["schema"],
        "store_path": probe.get("store_path"),
        "catalogs": catalogs,
        "lease_records": leases,
        "lease_record_count": probe.get("lease_record_count"),
        "host_ledger": {
            "path": ledger.get("path"),
            "reservation_count": ledger["reservation_count"],
            "reservations": normalized_reservations,
            "reservation_scope": ledger["reservation_scope"],
        },
    }


def _host_ledger_raw_sha(probe: Mapping[str, object]) -> str:
    ledger = probe.get("host_ledger")
    if not isinstance(ledger, Mapping) or not isinstance(ledger.get("sha256"), str):
        _fail("Capture-only host-ledger raw digest is absent")
    digest = ledger["sha256"]
    if SHA256.fullmatch(digest) is None:
        _fail("Capture-only host-ledger raw digest is invalid")
    return digest


def _read_record(control, relative: str, label: str) -> tuple[bytes, dict[str, object]]:
    from docker_volume_stop_unadmitted import _control_bytes

    raw = _control_bytes(control, relative)
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError(label + " is invalid JSON") from error
    if not isinstance(value, dict) or raw != canonical(value) + b"\n":
        raise BuildControlError(label + " is not a canonical control-volume record")
    return raw, value


def _attempt_records(control, previous: Mapping[str, object]):
    attempt = previous.get("attempt")
    if not isinstance(attempt, str) or UUID32.fullmatch(attempt) is None:
        _fail("Capture-only recovery requires an exact failed development attempt")
    root = "development/attempts/" + attempt
    terminal_raw, terminal = _read_record(control, root + "/terminal.json", "failed development terminal")
    current_raw, current = _read_record(control, "development/current.json", "current development record")
    if terminal != dict(previous) or current_raw != terminal_raw or current != terminal:
        _fail("Capture-only recovery attempt is no longer the exact current terminal")
    if (terminal.get("state") != "failed-confirmed"
            or terminal.get("compose_project") != control.project
            or terminal.get("control_volume") != control.volume):
        _fail("Capture-only recovery requires this group's failed-confirmed attempt")
    return attempt, root, terminal_raw


def _resume_predecessor(
    control,
    previous: Mapping[str, object],
    compose: Mapping[str, object],
    resume_attempt: str,
    observed_started_at: str,
) -> dict[str, object]:
    """Pin the exact earlier managed resume, without attributing this restart to it."""
    if UUID32.fullmatch(resume_attempt) is None:
        _fail("Capture-only observation requires an exact historical resume attempt")
    development_attempt = previous.get("attempt")
    if not isinstance(development_attempt, str) or UUID32.fullmatch(development_attempt) is None:
        _fail("Historical resume has no exact development-attempt parent")
    resume_root = "resume/attempts/" + resume_attempt
    terminal_raw, terminal = _read_record(
        control, resume_root + "/terminal.json", "historical resume terminal"
    )
    current_raw, current = _read_record(control, "resume/current.json", "current resume record")
    compose_digest = _sha(canonical(compose))
    inputs = terminal.get("inputs")
    started_at = terminal.get("backend_started_at")
    if (
        current_raw != terminal_raw or current != terminal
        or terminal.get("schema") != "fullmag.docker-build-operation.v1"
        or terminal.get("phase") != "resume"
        or terminal.get("state") != "failed-confirmed"
        or terminal.get("attempt") != resume_attempt
        or terminal.get("compose_project") != control.project
        or terminal.get("control_volume") != control.volume
        or not isinstance(inputs, Mapping)
        or inputs.get("attempt") != development_attempt
        or inputs.get("config_sha256") != compose_digest
        or not isinstance(started_at, str)
        or _timestamp_ns(started_at) >= _timestamp_ns(observed_started_at)
    ):
        _fail("Historical resume is not the exact earlier failed operation for this development attempt")
    log_raw, log_record = _read_record(
        control, resume_root + "/backend-failure-log.json", "historical resume failure log"
    )
    log = log_record.get("log")
    if (
        ("started_at" in log_record and log_record.get("started_at") != started_at)
        or not isinstance(log, str)
        or "phase=capture state=failed" not in log
        or "current live source capture failed" not in log
    ):
        _fail("Historical resume failure log is not bound to its recorded earlier backend incarnation")
    error = terminal.get("error")
    if (not isinstance(error, str) or "Backend exited during build" not in error
            or "phase=capture state=failed" not in error):
        _fail("Historical resume terminal does not record its earlier capture-only failure")
    return {
        "attempt": resume_attempt,
        "terminal_sha256": _sha(terminal_raw),
        "failure_log_sha256": _sha(log_raw),
        "backend_started_at": started_at,
        "development_attempt": development_attempt,
        "development_config_sha256": compose_digest,
    }


def _native_pins(control, previous: Mapping[str, object], backend_id: str, image_id: str):
    from docker_volume_stop_unadmitted import _json, _control_bytes
    from docker_volume_stop_failed import (
        _validate_native_after_ready_failure_probe,
        _validate_native_failure_probe,
    )

    inputs = previous.get("inputs")
    metadata = inputs.get("native_failed_restart") if isinstance(inputs, Mapping) else None
    if (not isinstance(metadata, Mapping)
            or metadata.get("schema") != "fullmag.docker-native-failed-stop-recreate.v1"
            or not isinstance(metadata.get("container_id"), str)
            or SHA256.fullmatch(metadata["container_id"]) is None
            or metadata.get("image_id") != image_id):
        _fail("Failed attempt does not retain the original native-stop metadata")
    # This metadata belongs to the earlier development incarnation. It remains
    # pinned by the development terminal, but it is not the identity of the
    # later observed backend restart.
    journal_path = "verification/stop-failed-" + backend_id + ".json"
    journal_raw = _control_bytes(control, journal_path)
    journal = _json(journal_raw, "original native stop journal")
    terminal_path = "runtime-control/runtime-service/process-tree.json"
    terminal_raw = _control_bytes(control, terminal_path)
    terminal = _json(terminal_raw, "original native terminal process receipt")
    owner_path = "runtime-control/runtime-services/OWNER.json"
    owner_raw = _control_bytes(control, owner_path)
    owner = _json(owner_raw, "original native terminal owner")
    if (
        journal.get("schema") != "fullmag.stop-failed-admission.v1"
        or journal.get("state") != "stopped-confirmed"
        or journal.get("container_id") != backend_id
        or journal.get("image_id") != image_id
        or not isinstance(journal.get("container_state"), Mapping)
        or journal.get("container_state", {}).get("id") != backend_id
        or journal.get("container_state", {}).get("image") != image_id
        or terminal != journal.get("terminal_process_receipt")
        or terminal.get("schema") != "fullmag.docker-process-tree.v1"
        or terminal.get("state") != "shutdown_unknown"
        or terminal.get("runtime_pid") is not None
        or owner != journal.get("terminal_failed_owner")
    ):
        _fail("Original native-stop proof or byte hashes changed")
    failure = journal.get("failure_receipt")
    probe = journal.get("native_failure_probe")
    if not isinstance(failure, Mapping) or not isinstance(probe, Mapping):
        _fail("Original native-stop proof is incomplete")
    process_sha = failure.get("sha256")
    if not isinstance(process_sha, str) or SHA256.fullmatch(process_sha) is None:
        _fail("Original native process receipt digest is invalid")
    if journal.get("failure_kind") == "native-after-ready-failure":
        checked = _validate_native_after_ready_failure_probe(probe, process_sha)
    else:
        checked = _validate_native_failure_probe(
            probe, process_sha,
            api_start_failure=journal.get("failure_mode") == "api-start-failure",
        )
    if checked["probe"].get("failed_owner_sha256") != _sha(owner_raw):
        _fail("Current native failure probe differs from its terminal owner")
    from docker_volume_dev import _read_runtime_config_digest
    runtime_config_sha256 = _read_runtime_config_digest(control)
    if (journal.get("previous_config_sha256") is not None
            and journal.get("previous_config_sha256") != runtime_config_sha256):
        _fail("Current runtime config differs from the original native-stop journal")
    return {
        "journal_path": journal_path, "journal_sha256": _sha(journal_raw),
        "terminal_process_receipt_sha256": _sha(terminal_raw),
        "terminal_failed_owner_sha256": _sha(owner_raw),
        "failure_receipt_sha256": process_sha,
        "failure_kind": journal["failure_kind"],
        "old_container_state": dict(journal["container_state"]),
        "runtime_config_sha256": runtime_config_sha256,
        "previous_native_restart": dict(metadata),
    }


def _container_state(document: Mapping[str, object], *, expected_exit: int = 2) -> dict[str, object]:
    if type(expected_exit) is not int or expected_exit not in {1, 2}:
        _fail("Backend stopped-state validation supports only the exact pre-API exits")
    state = document.get("State")
    if not isinstance(state, Mapping):
        _fail("Backend Docker state is missing")
    host = document.get("HostConfig")
    if not isinstance(host, Mapping):
        _fail("Backend Docker HostConfig is missing")
    pid_mode = host.get("PidMode")
    if pid_mode not in {None, ""}:
        _fail("Capture-only recovery requires the backend's private PID namespace")
    if (document.get("Id") is None or document.get("Image") is None
            or state.get("Running") is not False or state.get("Status") != "exited"
            or type(state.get("Pid")) is not int or state.get("Pid") != 0
            or type(state.get("ExitCode")) is not int or state.get("ExitCode") != expected_exit
            or state.get("OOMKilled") is not False
            or not isinstance(state.get("StartedAt"), str) or not state.get("StartedAt")
            or not isinstance(state.get("FinishedAt"), str) or not state.get("FinishedAt")):
        _fail("Backend is not the exact exited pre-API failure incarnation")
    return {
        "id": document["Id"], "image": document["Image"],
        "started_at": state["StartedAt"], "finished_at": state["FinishedAt"],
        "exit_code": state["ExitCode"], "pid": 0, "status": "exited",
        "pid_mode": "private",
    }


def _current_backend(
    control,
    previous,
    backend_id,
    image_id,
    *,
    expected_compose_sha=None,
    expected_started_at=None,
    expected_finished_at=None,
):
    from docker_volume_activation_reconcile import _inspect_stopped_backend
    from docker_volume_dev import _validate_retained_service
    from docker_backend_volume_cache import validate_container

    document_raw, compose = _read_record(
        control, "development/attempts/" + previous["attempt"] + "/compose.json",
        "failed attempt Compose document",
    )
    compose_sha = _sha(document_raw)
    if expected_compose_sha is not None and compose_sha != expected_compose_sha:
        _fail("Failed attempt Compose bytes changed after the sidecar was published")
    if compose.get("name") != control.project:
        _fail("Failed attempt Compose project differs")
    if control.namespace:
        if compose.get("x-fullmag-control-namespace") != control.namespace:
            _fail("Failed attempt Compose control namespace differs")
    elif "x-fullmag-control-namespace" in compose:
        _fail("Failed attempt Compose carries a foreign control namespace")
    inputs = previous.get("inputs")
    if (not isinstance(inputs, Mapping) or inputs.get("image_id") != image_id
            or inputs.get("source_root") != str(Path(inputs.get("source_root", "")).resolve())):
        _fail("Failed attempt source or image identity is invalid")
    if previous.get("backend_container") is not None and previous.get("backend_container") != backend_id:
        _fail("Observed backend differs from the optional recorded development container ID")
    selected = Path(inputs["source_root"]).resolve(strict=True)
    layout = storage.resolve_layout(selected, "docker-all-gpu")
    identity = compose_project_identity(layout)
    if identity != control.identity:
        _fail("Failed attempt resolver identity differs from the managed control group")
    state_root_value = previous.get("state_root")
    if not isinstance(state_root_value, str):
        _fail("Failed attempt has no resolver-bound state root")
    state_root = storage.validate_path(
        Path(state_root_value), Path(layout["runtime_root"]), "failed attempt state root"
    ).resolve(strict=True)
    backend = compose.get("services", {}).get("backend")
    if not isinstance(backend, Mapping):
        _fail("Failed attempt Compose has no backend service")
    state_mount = next((mount for mount in backend.get("volumes", [])
                        if isinstance(mount, Mapping) and mount.get("target") == "/state"), None)
    environment = backend.get("environment")
    if (not isinstance(state_mount, Mapping) or state_mount.get("type") != "bind"
            or Path(state_mount.get("source", "")).resolve(strict=True) != state_root
            or not isinstance(environment, Mapping)
            or environment.get("FULLMAG_PROJECT_STORAGE_ROOT", "/state") != "/state"
            or environment.get("FULLMAG_RUNS_ROOT", "/state/runs/docker-all") != "/state/runs/docker-all"
            or environment.get("FULLMAG_HOST_LEDGER_ROOT") != "/host-ledger/ledger"):
        _fail("Failed attempt store/ledger mounts do not match the resolver and runtime paths")
    actual = _inspect_stopped_backend(control, backend_id, image_id)
    state = _container_state(actual)
    if (expected_started_at is not None and state["started_at"] != expected_started_at
            or expected_finished_at is not None and state["finished_at"] != expected_finished_at):
        _fail("Current backend incarnation timestamps differ from the explicit observation request")
    if actual.get("HostConfig", {}).get("ReadonlyRootfs") is not True:
        _fail("Stopped backend root filesystem is not read-only")
    network_mode = actual.get("HostConfig", {}).get("NetworkMode")
    if network_mode in {"host", "none"}:
        _fail("Stopped backend does not retain its private Compose network")
    image_documents = json.loads(docker_capture("image", "inspect", image_id, timeout=60).stdout)
    if len(image_documents) != 1 or image_documents[0].get("Id") != image_id:
        _fail("Stopped backend image is not the exact local immutable image")
    image_config = image_documents[0].get("Config")
    if not isinstance(image_config, Mapping):
        _fail("Stopped backend image has no inspectable configuration")
    _validate_retained_service(compose, actual, "backend", image_config)
    cache_raw, cache = _read_record(
        control, "development/attempts/" + previous["attempt"] + "/backend-cache.json",
        "failed attempt backend cache receipt",
    )
    validate_container(actual, cache)
    return actual, state, compose, compose_sha, cache_raw, selected, layout


def _mount_arg(actual: Mapping[str, object], target: str) -> str:
    mounts = actual.get("Mounts")
    if not isinstance(mounts, list):
        _fail("Stopped backend mount inventory is missing")
    matches = [mount for mount in mounts if isinstance(mount, Mapping) and mount.get("Destination") == target]
    if len(matches) != 1 or matches[0].get("RW") is not True:
        _fail("Stopped backend does not have one exact writable source mount at " + target)
    mount = matches[0]
    if mount.get("Type") == "bind":
        source = mount.get("Source")
        if not isinstance(source, str) or not source or "," in source:
            _fail("Stopped backend bind source cannot be safely mounted read-only")
        return "type=bind,src=" + source + ",dst=" + target + ",readonly"
    if mount.get("Type") == "volume":
        name = mount.get("Name")
        if not isinstance(name, str) or re.fullmatch(r"[A-Za-z0-9_.-]+", name) is None:
            _fail("Stopped backend named volume identity is invalid")
        return "type=volume,src=" + name + ",dst=" + target + ",readonly,volume-nocopy"
    _fail("Stopped backend state/ledger mount type is unsupported")


def _store_probe(control, actual, image_id, operation_id):
    command = [
        "run", "--rm", "--pull", "never", "--name", "fullmag-capture-proof-" + operation_id,
        "--runtime", "runc", "--network", "none", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges:true", "--pids-limit", "24", "--memory", "96m",
        "--cpus", "0.25", "--user", "65532:65532",
        "--env", "FULLMAG_RUNS_ROOT=/state/runs/docker-all",
        "--env", "FULLMAG_HOST_LEDGER_ROOT=/host-ledger/ledger",
        "--mount", _mount_arg(actual, "/state"),
        "--mount", _mount_arg(actual, "/host-ledger"),
        "--label", "com.docker.compose.project=" + control.project,
        "--label", "com.docker.compose.service=capture-failure-probe",
    ]
    for key, value in source_labels(control.identity).items():
        command.extend(["--label", key + "=" + value])
    command.extend(["--entrypoint", "/usr/local/bin/python3", image_id, "-B", "-c", _STORE_PROBE])
    result = docker_capture(*command, timeout=120)
    if result.returncode:
        _fail("Read-only cancelled-store probe failed: " + result.stderr.decode("utf-8", "replace")[-2048:])
    if len(result.stdout) > MAX_PROBE_BYTES:
        _fail("Read-only cancelled-store probe exceeded its output bound")
    try:
        probe = json.loads(result.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError("Read-only cancelled-store probe returned invalid JSON") from error
    if not isinstance(probe, dict) or probe.get("schema") != "fullmag.docker-capture-failure-store-probe.v1":
        _fail("Read-only cancelled-store probe schema differs")
    return probe


def _timestamp_ns(value: str) -> int:
    match = re.fullmatch(r"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z", value)
    if match is None:
        _fail("Docker incarnation timestamp is not RFC3339 UTC")
    import calendar
    from datetime import datetime, timezone

    seconds = calendar.timegm(datetime.strptime(match.group(1), "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc).utctimetuple())
    fraction = int((match.group(2) or "").ljust(9, "0"))
    return seconds * 1_000_000_000 + fraction


def _capture_logs(backend_id: str, state: Mapping[str, object]) -> dict[str, bytes]:
    result = docker_capture(
        "logs", "--timestamps", "--since", state["started_at"], backend_id, timeout=120
    )
    if result.returncode:
        _fail("Cannot archive exact current backend logs: " + result.stderr.decode("utf-8", "replace")[-1024:])
    streams = {"stdout": bytes(result.stdout), "stderr": bytes(result.stderr)}
    return validate_capture_log_streams(streams, state)


def _capture_native_init_failure_logs(
    backend_id: str, state: Mapping[str, object]
) -> dict[str, bytes]:
    result = docker_capture(
        "logs", "--timestamps", "--since", state["started_at"], backend_id, timeout=120
    )
    if result.returncode:
        _fail("Cannot archive exact current backend logs: " + result.stderr.decode("utf-8", "replace")[-1024:])
    streams = {"stdout": bytes(result.stdout), "stderr": bytes(result.stderr)}
    return validate_native_init_failure_log_streams(streams, state)


def validate_timestamped_log_streams(
    streams: Mapping[str, bytes], state: Mapping[str, object], *, maximum: int = MAX_LOG_BYTES
) -> dict[str, bytes]:
    """Validate exact stdout/stderr bytes against one Docker incarnation."""
    if set(streams) != {"stdout", "stderr"} or any(not isinstance(value, bytes) for value in streams.values()):
        _fail("Capture-only log archive has an invalid stream set")
    total_bytes = len(streams["stdout"]) + len(streams["stderr"])
    if not total_bytes or total_bytes > maximum:
        _fail("Current backend logs are empty or exceed the retention bound")
    started_ns = _timestamp_ns(str(state["started_at"]))
    finished_ns = _timestamp_ns(str(state["finished_at"]))
    if finished_ns < started_ns:
        _fail("Docker incarnation finish time precedes its start time")
    for stream in streams.values():
        for line in stream.splitlines():
            if not line:
                continue
            match = TIMESTAMP.match(line)
            if match is None:
                _fail("Timestamped Docker logs contain an unbound line")
            timestamp = _timestamp_ns(match.group(1).decode("ascii"))
            if timestamp < started_ns or timestamp > finished_ns:
                _fail("Docker log timestamp falls outside the exact stopped incarnation")
    return dict(streams)


def validate_capture_log_streams(streams: Mapping[str, bytes], state: Mapping[str, object]) -> dict[str, bytes]:
    """Validate the legacy capture-only failure without changing its evidence rules."""
    streams = validate_timestamped_log_streams(streams, state, maximum=MAX_LOG_BYTES)
    text = (streams["stdout"] + streams["stderr"]).decode("utf-8", "replace")
    if (text.count("phase=capture state=start") != 1
            or text.count("phase=capture state=failed") != 1
            or "phase=capture state=complete" in text
            or "phase=start state=handoff" in text
            or "phase=build state=start" in text
            or "current live source capture failed" not in text):
        _fail("Current backend logs do not prove one capture-only failure before build handoff")
    forbidden = (
        r"phase=(?:build|compile|make|package|gate|api|runtime|native)\b",
        r"\bmake(?:\[\d+\])?\s+(?:all|install|check|success)",
        r"\bpackage (?:ready|published|validated|installed)\b",
        r"\bAPI (?:ready|started|listening)\b",
        r"\bnative runtime\b",
    )
    if any(re.search(pattern, text, re.IGNORECASE) for pattern in forbidden):
        _fail("Current backend logs show work beyond the capture-only failure")
    return streams


def validate_native_init_failure_log_streams(
    streams: Mapping[str, bytes], state: Mapping[str, object]
) -> dict[str, bytes]:
    """Require the one observed host-policy initialization traceback before API handoff."""
    streams = validate_timestamped_log_streams(streams, state, maximum=MAX_LOG_BYTES)
    combined = (streams["stdout"] + streams["stderr"]).decode("utf-8", "replace")
    if "[fullmag-backend] Starting API and runtime service" in combined:
        _fail("Native host initialization failure was not before API handoff")

    # A Python traceback is written as a single stream. Strip only the
    # timestamp prefix already validated above, keeping frame ordering exact.
    traceback_text = None
    for stream in (streams["stderr"], streams["stdout"]):
        lines = []
        for line in stream.splitlines():
            if not line:
                continue
            match = TIMESTAMP.match(line)
            if match is not None:
                lines.append(line[match.end():].decode("utf-8", "replace"))
        traceback_positions = [
            index for index, line in enumerate(lines)
            if line.strip() == "Traceback (most recent call last):"
        ]
        last_traceback = max(traceback_positions, default=-1)
        if last_traceback < 0:
            continue
        candidates = lines[last_traceback + 1:]
        patterns = (
            re.compile(r'File "/opt/fullmag/entrypoint\.py", line [0-9]+, in serve'),
            re.compile(r'File "/opt/fullmag/runtime_service\.py", line [0-9]+, in ensure_configuration'),
            re.compile(r'File "/opt/fullmag/runtime_service\.py", line [0-9]+, in initialize_host_configuration'),
        )
        cursor = 0
        ordered = True
        for pattern in patterns:
            found = next((index for index in range(cursor, len(candidates))
                          if pattern.search(candidates[index])), None)
            if found is None:
                ordered = False
                break
            cursor = found + 1
        final_error = next(
            (index for index in range(cursor, len(candidates))
             if "RuntimeServiceError: native Docker host profile initialization failed"
             in candidates[index]),
            None,
        )
        final_error_absolute = (last_traceback + 1 + final_error) if final_error is not None else None
        marker_error = "host resource ledger initialization marker differs from configured policy"
        if (ordered and final_error_absolute is not None
                and marker_error in lines[final_error_absolute]):
            traceback_text = "\n".join(lines)
            break
    if (traceback_text is None
            or "RuntimeServiceError: native Docker host profile initialization failed"
            not in traceback_text):
        _fail("Backend logs do not prove the exact native host-policy pre-API initialization failure")
    return streams


def _resume_failure_log(control, resume_attempt: str, expected_started_at: str):
    raw, record = _read_record(
        control, "resume/attempts/" + resume_attempt + "/backend-failure-log.json",
        "historical resume backend failure log",
    )
    log = record.get("log")
    if (("started_at" in record and record.get("started_at") != expected_started_at)
            or not isinstance(log, str) or "phase=capture state=failed" not in log
            or "current live source capture failed" not in log
            ):
        _fail("Historical resume log does not retain its exact earlier capture-failure outcome")
    return raw


def _read_native_again(control, previous, backend_id, image_id, expected):
    current = _native_pins(control, previous, backend_id, image_id)
    if current != expected:
        _fail("Original native proof bytes changed during capture-failure reconciliation")
    return current


def _collect(
    control,
    previous,
    backend_id,
    image_id,
    resume_attempt,
    operation_id,
    *,
    expected_started_at,
    expected_finished_at,
    expected_compose_sha=None,
):
    attempt, root, terminal_raw = _attempt_records(control, previous)
    _, compose = _read_record(
        control, root + "/compose.json", "failed development Compose document"
    )
    resume = _resume_predecessor(
        control, previous, compose, resume_attempt, expected_started_at
    )
    native = _native_pins(control, previous, backend_id, image_id)
    actual, state, compose, compose_sha, cache_raw, selected, layout = _current_backend(
        control, previous, backend_id, image_id,
        expected_compose_sha=expected_compose_sha,
        expected_started_at=expected_started_at,
        expected_finished_at=expected_finished_at,
    )
    logs_raw = _capture_logs(backend_id, state)
    failed_log_raw = _resume_failure_log(
        control, resume_attempt, resume["backend_started_at"]
    )
    probe = _store_probe(control, actual, image_id, operation_id)
    return {
        "attempt": attempt, "attempt_root": root, "terminal_raw": terminal_raw,
        "resume": resume, "native": native, "actual": actual, "state": state,
        "compose": compose, "compose_sha256": compose_sha, "cache_raw": cache_raw,
        "selected": selected, "layout": layout, "logs_raw": logs_raw,
        "failed_log_raw": failed_log_raw, "store_probe": probe,
    }


def _sidecar_path(backend_id: str, started_at: str) -> str:
    if re.fullmatch(r"[0-9a-f]{64}", backend_id) is None:
        _fail("Capture-failure sidecar requires the exact full backend ID")
    started_sha = _sha(started_at.encode("utf-8"))
    return "verification/capture-failure-" + backend_id + "-" + started_sha + ".json"


def _publish_create_only(control, relative: str, value: Mapping[str, object]) -> bytes:
    raw = canonical(value) + b"\n"
    if len(raw) > MAX_RECORD_BYTES:
        _fail("Capture-failure sidecar exceeds the managed control record bound")
    path = control.path(relative)
    parent = str(Path(path).parent).replace("\\", "/")
    script = (
        "umask 027; "
        f"mkdir -p '{parent}'; test \"$(readlink -f '{parent}')\" = '{parent}'; "
        f"test ! -L '{path}'; test ! -e '{path}'; "
        f"tmp=$(mktemp '{parent}/.capture-failure.XXXXXXXX'); "
        "trap 'rm -f -- \"$tmp\"' EXIT; cat > \"$tmp\"; sync \"$tmp\"; "
        f"ln -T -- \"$tmp\" '{path}'; rm -- \"$tmp\"; sync '{parent}'"
    )
    from docker_build_control import bounded_capture

    result = bounded_capture(control.helper_args(script), data=raw, timeout=90)
    if result.returncode:
        raise BuildControlError("Create-only capture sidecar publication failed: " + result.stderr.decode("utf-8", "replace")[-1024:])
    from docker_volume_stop_unadmitted import _control_bytes

    readback = _control_bytes(control, relative)
    if readback != raw:
        _fail("Create-only capture sidecar readback differs")
    return readback


def create_capture_failure_sidecar(
    control,
    selected: Path,
    attempt: str,
    resume_attempt: str,
    backend_id: str,
    started_at: str,
    finished_at: str,
) -> dict[str, object]:
    """Observe one exact stopped capture-only restart; its launch origin stays unknown."""
    if (UUID32.fullmatch(attempt) is None or UUID32.fullmatch(resume_attempt) is None
            or re.fullmatch(r"[0-9a-f]{64}", backend_id) is None):
        _fail("Capture-failure observation requires exact development, resume, and backend IDs")
    _timestamp_ns(started_at)
    _timestamp_ns(finished_at)
    if _timestamp_ns(finished_at) < _timestamp_ns(started_at):
        _fail("Observed backend finish time precedes its exact start time")
    previous_root = "development/attempts/" + attempt
    _, previous = _read_record(control, previous_root + "/terminal.json", "failed development terminal")
    _attempt_records(control, previous)
    if not isinstance(previous.get("inputs"), Mapping) or previous["inputs"].get("source_root") != str(selected):
        _fail("Selected source differs from the exact failed development attempt")
    image_id = previous["inputs"].get("image_id")
    if not isinstance(image_id, str) or re.fullmatch(r"sha256:[0-9a-f]{64}", image_id) is None:
        _fail("Failed development attempt has no immutable backend image ID")
    operation_inputs = {
        "development_attempt": attempt,
        "historical_resume_attempt": resume_attempt,
        "container_id": backend_id,
        "image_id": image_id,
        "backend_started_at": started_at,
        "backend_finished_at": finished_at,
        "origin": "observed-capture-only-restart",
        "launch_origin": "unknown",
        "source_root": str(selected),
    }
    with control.operation(PHASE, operation_inputs) as operation:
        operation_id = operation["receipt"]["attempt"]
        first = _collect(
            control, previous, backend_id, image_id, resume_attempt, operation_id,
            expected_started_at=started_at, expected_finished_at=finished_at,
        )
        second = _collect(
            control, previous, backend_id, image_id, resume_attempt, operation_id,
            expected_started_at=started_at, expected_finished_at=finished_at,
            expected_compose_sha=first["compose_sha256"],
        )
        if (first["state"] != second["state"]
                or first["native"] != second["native"]
                or first["resume"] != second["resume"]
                or first["logs_raw"] != second["logs_raw"]
                or first["failed_log_raw"] != second["failed_log_raw"]
                or _store_safety_projection(first["store_probe"])
                    != _store_safety_projection(second["store_probe"])
                or first["terminal_raw"] != second["terminal_raw"]
                or first["cache_raw"] != second["cache_raw"]):
            _fail("Capture-failure evidence changed during the managed observation")
        started_at = second["state"]["started_at"]
        relative = _sidecar_path(backend_id, started_at)
        store_probe = second["store_probe"]
        store_projection = _store_safety_projection(store_probe)
        store_sha = _sha(canonical(store_projection))
        ledger_raw_shas = [
            _host_ledger_raw_sha(first["store_probe"]),
            _host_ledger_raw_sha(second["store_probe"]),
        ]
        operation["receipt"].update(
            development_attempt=attempt,
            historical_resume_attempt=resume_attempt,
            backend_container=backend_id,
            backend_image_id=image_id,
            backend_started_at=started_at,
            backend_finished_at=finished_at,
            origin="observed-capture-only-restart",
            launch_origin="unknown",
            source_root=str(selected),
            compose_sha256=second["compose_sha256"],
            native_stop_journal_sha256=second["native"]["journal_sha256"],
            store_probe_sha256=store_sha,
            host_ledger_raw_sha256_observations=ledger_raw_shas,
            capture_failure_sidecar_path=relative,
        )
        sidecar = {
            "schema": SCHEMA,
            "state": "capture-failure-stopped-confirmed",
            "origin": "observed-capture-only-restart",
            "launch_origin": "unknown",
            "compose_project": control.project,
            "control_volume": control.volume,
            "control_namespace": control.namespace,
            "namespace_registry_sha256": control.namespace_registry_sha256,
            "operation_phase": PHASE,
            "operation_attempt": operation_id,
            "development_attempt": attempt,
            "development_terminal_sha256": _sha(second["terminal_raw"]),
            "historical_resume_attempt": resume_attempt,
            "historical_resume": second["resume"],
            "historical_resume_failure_log_sha256": _sha(second["failed_log_raw"]),
            "source_root": str(selected),
            "source_identity": dict(control.identity),
            "compose_sha256": second["compose_sha256"],
            "backend": second["state"],
            "native_stop": second["native"],
            "docker_logs": {
                "stdout_sha256": _sha(second["logs_raw"]["stdout"]),
                "stdout_bytes": len(second["logs_raw"]["stdout"]),
                "stdout_base64": base64.b64encode(second["logs_raw"]["stdout"]).decode("ascii"),
                "stderr_sha256": _sha(second["logs_raw"]["stderr"]),
                "stderr_bytes": len(second["logs_raw"]["stderr"]),
                "stderr_base64": base64.b64encode(second["logs_raw"]["stderr"]).decode("ascii"),
            },
            "store_probe": store_probe,
            "store_safety_projection": store_projection,
            "host_ledger_raw_sha256_observations": ledger_raw_shas,
            "store_probe_sha256": store_sha,
        }
        sidecar_raw = _publish_create_only(control, relative, sidecar)
        operation["receipt"]["capture_failure_sidecar_sha256"] = _sha(sidecar_raw)
        operation["receipt"]["state"] = "succeeded"
    operation_raw, operation_terminal = _read_record(
        control, PHASE + "/attempts/" + operation_id + "/terminal.json",
        "capture-failure reconciliation operation terminal",
    )
    if (operation_terminal.get("state") != "succeeded"
            or operation_terminal.get("phase") != PHASE
            or operation_terminal.get("origin") != "observed-capture-only-restart"
            or operation_terminal.get("launch_origin") != "unknown"
            or operation_terminal.get("capture_failure_sidecar_path") != relative
            or operation_terminal.get("capture_failure_sidecar_sha256") != _sha(sidecar_raw)):
        _fail("Capture-failure sidecar operation did not reach a bound succeeded terminal")
    return {
        "sidecar_path": relative,
        "sidecar_sha256": _sha(sidecar_raw),
        "operation_attempt": operation_id,
        "operation_terminal_sha256": _sha(operation_raw),
        "origin": "observed-capture-only-restart",
        "launch_origin": "unknown",
        "development_attempt": attempt,
        "historical_resume_attempt": resume_attempt,
        "backend_container": backend_id,
        "backend_started_at": started_at,
        "backend_finished_at": finished_at,
    }


def validate_capture_failure_sidecar(
    control,
    previous: Mapping[str, object],
    *,
    backend_id: str,
    image_id: str,
) -> dict[str, object]:
    """Revalidate the exact sidecar and current stopped incarnation under the caller's lease."""
    attempt, _, terminal_raw = _attempt_records(control, previous)
    inputs = previous.get("inputs")
    if not isinstance(inputs, Mapping):
        _fail("Current failed attempt has no retained inputs")
    selected = Path(inputs.get("source_root", "")).resolve(strict=True)
    image_id_from_attempt = inputs.get("image_id")
    if image_id_from_attempt != image_id:
        _fail("Current failed attempt backend image differs")
    first_actual, first_state, compose, compose_sha, cache_raw, _, _ = _current_backend(
        control, previous, backend_id, image_id
    )
    relative = _sidecar_path(backend_id, str(first_state["started_at"]))
    sidecar_raw, sidecar = _read_record(control, relative, "capture-failure incarnation sidecar")
    resume_attempt = sidecar.get("historical_resume_attempt")
    if not isinstance(resume_attempt, str) or UUID32.fullmatch(resume_attempt) is None:
        _fail("Capture-failure sidecar has no exact historical resume predecessor")
    resume = _resume_predecessor(
        control, previous, compose, resume_attempt, str(first_state["started_at"])
    )
    operation_id = sidecar.get("operation_attempt")
    if not isinstance(operation_id, str) or UUID32.fullmatch(operation_id) is None:
        _fail("Capture-failure sidecar has no exact managed operation identity")
    operation_raw, operation = _read_record(
        control, PHASE + "/attempts/" + operation_id + "/terminal.json",
        "capture-failure sidecar operation terminal",
    )
    logs = sidecar.get("docker_logs")
    if (not isinstance(logs, Mapping)
            or not isinstance(logs.get("stdout_base64"), str)
            or not isinstance(logs.get("stderr_base64"), str)):
        _fail("Capture-failure sidecar has no archived timestamped Docker logs")
    try:
        archived_logs = {
            "stdout": base64.b64decode(logs["stdout_base64"], validate=True),
            "stderr": base64.b64decode(logs["stderr_base64"], validate=True),
        }
    except (ValueError, TypeError) as error:
        raise BuildControlError("Capture-failure sidecar log archive is invalid base64") from error
    if (len(archived_logs["stdout"]) != logs.get("stdout_bytes")
            or len(archived_logs["stderr"]) != logs.get("stderr_bytes")
            or _sha(archived_logs["stdout"]) != logs.get("stdout_sha256")
            or _sha(archived_logs["stderr"]) != logs.get("stderr_sha256")
            or _capture_logs(backend_id, first_state) != archived_logs):
        _fail("Archived Docker logs differ from a fresh observation of this stopped incarnation")
    current_native = _native_pins(control, previous, backend_id, image_id)
    fresh_probe = _store_probe(control, first_actual, image_id, operation_id)
    fresh_projection = _store_safety_projection(fresh_probe)
    probe_sha = _sha(canonical(fresh_projection))
    sidecar_probe = sidecar.get("store_probe")
    sidecar_projection = sidecar.get("store_safety_projection")
    raw_observations = sidecar.get("host_ledger_raw_sha256_observations")
    if (not isinstance(sidecar_probe, Mapping)
            or not isinstance(sidecar_projection, Mapping)
            or not isinstance(raw_observations, list)
            or len(raw_observations) != 2
            or any(not isinstance(digest, str) or SHA256.fullmatch(digest) is None
                   for digest in raw_observations)
            or _store_safety_projection(sidecar_probe) != dict(sidecar_projection)
            or _host_ledger_raw_sha(sidecar_probe) != raw_observations[-1]):
        _fail("Capture-failure sidecar store observations are malformed")
    failed_log_raw = _resume_failure_log(control, resume_attempt, resume["backend_started_at"])
    if (
        sidecar.get("schema") != SCHEMA
        or sidecar.get("state") != "capture-failure-stopped-confirmed"
        or sidecar.get("origin") != "observed-capture-only-restart"
        or sidecar.get("launch_origin") != "unknown"
        or sidecar.get("compose_project") != control.project
        or sidecar.get("control_volume") != control.volume
        or sidecar.get("control_namespace") != control.namespace
        or sidecar.get("namespace_registry_sha256") != control.namespace_registry_sha256
        or sidecar.get("operation_phase") != PHASE
        or sidecar.get("development_attempt") != attempt
        or sidecar.get("development_terminal_sha256") != _sha(terminal_raw)
        or sidecar.get("historical_resume_attempt") != resume_attempt
        or sidecar.get("historical_resume") != resume
        or sidecar.get("historical_resume_failure_log_sha256") != _sha(failed_log_raw)
        or sidecar.get("source_root") != str(selected)
        or sidecar.get("source_identity") != dict(control.identity)
        or sidecar.get("compose_sha256") != compose_sha
        or sidecar.get("backend") != first_state
        or sidecar.get("native_stop") != current_native
        or dict(sidecar_projection) != fresh_projection
        or sidecar.get("store_probe_sha256") != probe_sha
        or operation.get("schema") != "fullmag.docker-build-operation.v1"
        or operation.get("phase") != PHASE
        or operation.get("state") != "succeeded"
        or operation.get("attempt") != operation_id
        or operation.get("compose_project") != control.project
        or operation.get("control_volume") != control.volume
        or operation.get("inputs") != {
            "development_attempt": attempt,
            "historical_resume_attempt": resume_attempt,
            "container_id": backend_id,
            "image_id": image_id,
            "backend_started_at": first_state["started_at"],
            "backend_finished_at": first_state["finished_at"],
            "origin": "observed-capture-only-restart",
            "launch_origin": "unknown",
            "source_root": str(selected),
        }
        or operation.get("origin") != "observed-capture-only-restart"
        or operation.get("launch_origin") != "unknown"
        or operation.get("backend_started_at") != first_state["started_at"]
        or operation.get("backend_finished_at") != first_state["finished_at"]
        or operation.get("capture_failure_sidecar_path") != relative
        or operation.get("capture_failure_sidecar_sha256") != _sha(sidecar_raw)
        or operation.get("compose_sha256") != compose_sha
        or operation.get("store_probe_sha256") != probe_sha
        or operation.get("host_ledger_raw_sha256_observations") != raw_observations
        or operation.get("native_stop_journal_sha256") != current_native.get("journal_sha256")
        or len(operation_raw) > MAX_RECORD_BYTES
        or len(sidecar_raw) > MAX_RECORD_BYTES
        or len(cache_raw) > MAX_RECORD_BYTES
    ):
        _fail("Capture-failure sidecar does not match the exact current native, Compose, or store evidence")
    second_actual, second_state, second_compose, second_compose_sha, second_cache_raw, _, _ = _current_backend(
        control, previous, backend_id, image_id,
        expected_compose_sha=compose_sha,
        expected_started_at=first_state["started_at"],
        expected_finished_at=first_state["finished_at"],
    )
    second_logs = _capture_logs(backend_id, second_state)
    second_native = _native_pins(control, previous, backend_id, image_id)
    second_resume = _resume_predecessor(
        control, previous, second_compose, resume_attempt, str(second_state["started_at"])
    )
    second_failed_log = _resume_failure_log(control, resume_attempt, second_resume["backend_started_at"])
    second_probe = _store_probe(control, second_actual, image_id, operation_id)
    _, _, second_terminal_raw = _attempt_records(control, previous)
    if (second_state != first_state or second_compose_sha != compose_sha
            or second_cache_raw != cache_raw or _container_state(second_actual) != first_state
            or second_logs != archived_logs or second_native != current_native
            or second_resume != resume or second_failed_log != failed_log_raw
            or _store_safety_projection(second_probe) != fresh_projection
            or second_terminal_raw != terminal_raw):
        _fail("Stopped backend incarnation changed during sidecar revalidation")
    return {
        "path": relative,
        "sha256": _sha(sidecar_raw),
        "origin": "observed-capture-only-restart",
        "launch_origin": "unknown",
        "backend_started_at": first_state["started_at"],
        "backend_finished_at": first_state["finished_at"],
        "historical_resume_attempt": resume_attempt,
        "operation_attempt": operation_id,
        "operation_terminal_sha256": _sha(operation_raw),
        "store_probe_sha256": probe_sha,
        # Return only the immutable archive observations to the recreation
        # context. Fresh raw hashes were retained in local probes; unrelated
        # ledger telemetry may change again before that context is rechecked.
        "host_ledger_raw_sha256_observations": list(raw_observations),
    }


def _make_control(source_root: Path):
    selected = source_root.resolve(strict=True)
    layout = storage.resolve_layout(selected, "docker-all-gpu")
    identity = compose_project_identity(layout)
    configured = toolchain_configuration(selected, identity)
    helper = configured["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"]
    control = BuildControl(identity, helper)
    control.prepare()
    return selected, control


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--attempt", required=True, help="exact failed development attempt")
    parser.add_argument("--resume-attempt", required=True, help="earlier managed resume, retained only as a predecessor pin")
    parser.add_argument("--container-id", required=True)
    parser.add_argument("--started-at", required=True, help="exact StartedAt of the observed stopped restart")
    parser.add_argument("--finished-at", required=True, help="exact FinishedAt of the observed stopped restart")
    args = parser.parse_args()
    require_host()
    selected, control = _make_control(args.source_root)
    result = create_capture_failure_sidecar(
        control, selected, args.attempt, args.resume_attempt, args.container_id,
        args.started_at, args.finished_at,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
