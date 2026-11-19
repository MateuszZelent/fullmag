"""Preview, then explicitly publish one first pre-ACK retry certificate.

No historical record is replaced. Preview uses temporary read-only Docker
helpers and publishes no durable evidence. --apply additionally requires the
exact preview digest and a managed lease.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path, PurePosixPath
import re
import sys

import fullmag_storage as storage
from docker_build_control import MAX_DOCUMENT_BYTES, BuildControl, BuildControlError, bounded_capture, canonical, docker_capture, require_host, toolchain_configuration
from docker_compose_identity import compose_project_identity
from docker_volume_accepted_reattach import MAX_CONTROL_RECORD_BYTES, _bundle_from_records, _control_bytes, _decode_json


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _service():
    path = Path(__file__).resolve().parents[1] / "docker/all-in-one/runtime_service.py"
    spec = importlib.util.spec_from_file_location("pre_ack_runtime_service", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _record(control, relative, label):
    maximum = 8 * 1024 * 1024 if relative.endswith("/preflight-log.json") else 512 * 1024
    raw = _control_bytes(control, relative, maximum=maximum)
    if raw is None:
        raise BuildControlError(label + " is missing")
    return raw, _decode_json(raw, label)


def _publish_raw(control, relative, raw, *, helper_name=None, maximum=MAX_CONTROL_RECORD_BYTES):
    from docker_build_control import bounded_capture
    if (type(maximum) is not int or not 0 < maximum <= MAX_DOCUMENT_BYTES
            or not isinstance(raw, bytes) or len(raw) > maximum):
        raise BuildControlError("Create-only raw archive exceeds its bounded record size")
    path = control.path(relative)
    parent = str(PurePosixPath(path).parent)
    script = (f"umask 027; mkdir -p '{parent}'; test \"$(readlink -f '{parent}')\" = '{parent}'; "
              f"test ! -e '{path}'; test ! -L '{path}'; tmp=$(mktemp '{parent}/.pre-ack.XXXXXXXX'); "
              "trap 'rm -f -- \"$tmp\"' EXIT; cat > \"$tmp\"; sync \"$tmp\"; "
              f"ln -T -- \"$tmp\" '{path}'; rm -- \"$tmp\"; sync '{parent}'")
    result = bounded_capture(control.helper_args(script, name=helper_name), data=raw, timeout=90)
    if result.returncode or _control_bytes(control, relative, maximum=maximum) != raw:
        raise BuildControlError("Create-only pre-ACK raw archive was not confirmed")


def _released_snapshot(control, actual):
    from docker_volume_linux_supervision_stop import readonly_mount
    code = r'''import fcntl,hashlib,json,os,pathlib,re,stat,time
root=pathlib.Path('/state/runs/docker-all/session-store'); ledger=pathlib.Path('/host-ledger/ledger')
locks=[]
def read(p,limit=16777216):
 fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  st=os.fstat(fd)
  if not stat.S_ISREG(st.st_mode) or st.st_size>limit: raise RuntimeError('unbounded/nonregular observation')
  data=bytearray()
  while len(data)<=limit:
   chunk=os.read(fd,min(65536,limit+1-len(data)))
   if not chunk: break
   data.extend(chunk)
  if len(data)!=st.st_size or len(data)>limit: raise RuntimeError('observation changed')
  return bytes(data)
 finally: os.close(fd)
try:
 deadline=time.monotonic()+5.0
 for p in [ledger/'WRITER.lock',root/'WRITER.lock']:
  fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW); locks.append(fd)
  if not stat.S_ISREG(os.fstat(fd).st_mode): raise RuntimeError('writer lock is not a regular file')
  while True:
   try:
    fcntl.flock(fd,fcntl.LOCK_SH|fcntl.LOCK_NB); break
   except BlockingIOError:
    remaining=deadline-time.monotonic()
    if remaining<=0: raise RuntimeError('timed out acquiring shared observation locks within 5s')
    time.sleep(min(0.025,remaining))
 doc=json.loads(read(ledger/'HOST_RESOURCE_LEDGER.json')); rows=doc['reservations']
 if len(rows)>8192 or any(r['state']!='released' for r in rows): raise RuntimeError('host reservation not released')
 refs=[]
 for row in rows:
  digest=row['release_proof_sha256']
  if not isinstance(digest,str) or not re.fullmatch('[0-9a-f]{64}',digest): raise RuntimeError('invalid proof digest')
  raw=read(ledger/'proofs'/(digest+'.json'),65536)
  if hashlib.sha256(raw).hexdigest()!=digest: raise RuntimeError('release proof digest differs')
  proof=json.loads(raw)
  if (proof.get('schema_version') not in ['host_resource_release_proof.v1','host_resource_release_proof.v2']
      or proof.get('host_id')!=doc['policy']['host_id'] or proof.get('store_id')!=row['identity']['store_id']
      or proof.get('request_sha256')!=row['request_sha256']): raise RuntimeError('release proof identity differs')
  refs.append([row['identity'],row['request_sha256'],digest])
 leases=[]; count=0; runs=root/'runs'
 run_stat=os.lstat(runs)
 if not stat.S_ISDIR(run_stat.st_mode) or stat.S_ISLNK(run_stat.st_mode): raise RuntimeError('runs root is not a real directory')
 for run in os.scandir(runs):
  count+=1
  if count>8192 or run.is_symlink() or not run.is_dir(follow_symlinks=False): raise RuntimeError('invalid or unbounded run inventory')
  for directory in ('resource_leases','preparation_resource_leases'):
   lease_root=pathlib.Path(run.path)/directory
   try: lease_stat=os.lstat(lease_root)
   except FileNotFoundError: continue
   if not stat.S_ISDIR(lease_stat.st_mode) or stat.S_ISLNK(lease_stat.st_mode): raise RuntimeError('lease root is not a real directory')
   for resource in os.scandir(lease_root):
    count+=1
    if count>8192 or resource.is_symlink() or not resource.is_dir(follow_symlinks=False): raise RuntimeError('invalid or unbounded resource inventory')
    for entry in os.scandir(resource.path):
     count+=1
     if count>8192 or entry.is_symlink() or not entry.is_file(follow_symlinks=False) or not entry.name.endswith('.json'): raise RuntimeError('invalid or unbounded lease entry')
     raw=read(entry.path,262144); lease=json.loads(raw)
     if lease['state']!='released': raise RuntimeError('local lease not released')
     leases.append([str(pathlib.Path(entry.path).relative_to(root)),hashlib.sha256(raw).hexdigest()])
 print(json.dumps({'schema':'fullmag.pre-ack-released-observation.v1','reservations':sorted(refs,key=lambda r:json.dumps(r[0],sort_keys=True)),'leases':sorted(leases),'active_count':0},sort_keys=True,separators=(',',':')))
finally:
 for fd in reversed(locks): os.close(fd)
'''
    result = docker_capture("run", "--rm", "--pull", "never", "--network", "none", "--runtime", "runc",
                            "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
                            "--user", "65532:65532", "--memory", "96m", "--pids-limit", "24",
                            "--label", "com.docker.compose.project=" + control.project,
                            "--label", "com.docker.compose.service=pre-ack-readonly-probe",
                            "--mount", readonly_mount(actual, "/state"), "--mount", readonly_mount(actual, "/host-ledger"),
                            "--entrypoint", "/usr/local/bin/python3", actual["Image"], "-B", "-c", code, timeout=90)
    if result.returncode or len(result.stdout)>1024*1024:
        raise BuildControlError("Fresh read-only released-state observation failed: " + result.stderr.decode(errors="replace")[-1024:])
    return json.loads(result.stdout)


def _collect(control, selected, args, operation_id):
    service = _service()
    pre_raw, previous = _record(control, "development/attempts/" + args.preflight_attempt + "/terminal.json", "preflight attempt")
    if _control_bytes(control, "development/current.json") != pre_raw:
        raise BuildControlError("Preflight attempt is not the exact current development terminal")
    inputs = previous.get("inputs", {})
    if inputs.get("source_root") != str(selected):
        raise BuildControlError("Preflight source differs from selected checkout")
    layout = storage.resolve_layout(selected, "docker-all-gpu")
    state = storage.validate_path(Path(previous["state_root"]), Path(layout["runtime_root"]), "retained pre-ACK state")
    bundle = _bundle_from_records(control, store_root=state / "runs/docker-all/session-store")
    request, proof = bundle["request"], bundle["proof"]
    parent = str(PurePosixPath(request["proof_path"]).parent)
    relative = parent + "/pre-ack-retry.json"
    if _control_bytes(control, "runtime-control/" + relative, optional=True) is not None:
        raise BuildControlError("First pre-ACK retry certificate already exists; no second retry is authorized")
    # This helper only inspects immutable control records. No native CLI/owner.
    directory = control.path("runtime-control/" + parent)
    scan = bounded_capture(control.helper_args(
        "test -d '" + directory + "'; find '" + directory + "' -mindepth 1 -maxdepth 1 -printf '%f\\n'"
    ), data=b"", timeout=90)
    if scan.returncode:
        raise BuildControlError("Cannot inventory original proof directory")
    names = scan.stdout.decode().splitlines()
    allowed = {"request.json", "proof.json", "terminal-owner.json", "terminal-process.json"}
    if len(names) > 64 or any(name not in allowed for name in names):
        raise BuildControlError("Original request has consumed or uncertain ACK evidence")
    api_raw, api_attempt = _record(control, "development/attempts/" + args.api_attempt + "/terminal.json", "API attempt")
    api_container = service._pre_ack_attempt_container(
        api_attempt, args.api_attempt, control.project, api_attempt["inputs"]["image_id"])
    if service._pre_ack_attempt_container(
            previous, args.preflight_attempt, control.project, inputs["image_id"]) != args.container_id:
        raise BuildControlError("Preflight attempt container differs from its explicit incarnation")
    if args.api_attempt == args.preflight_attempt or api_container == args.container_id:
        raise BuildControlError("Pre-ACK retry requires distinct attempts and containers")
    from docker_volume_activation_reconcile import _probe_helper_absence, _inspect_stopped_backend
    if _probe_helper_absence(api_container) is None:
        raise BuildControlError("Stopped API container namespace still exists")
    journal_raw, journal = _record(control, "verification/stop-failed-" + api_container + ".json", "API stop journal")
    from docker_volume_stop_failed import _validate_native_failure_probe
    failure = journal.get("failure_receipt", {})
    _validate_native_failure_probe(journal.get("native_failure_probe", {}), failure.get("sha256"), api_start_failure=True)
    actual = _inspect_stopped_backend(control, args.container_id, inputs.get("image_id"))
    compose_raw, compose = _record(control, "development/attempts/" + args.preflight_attempt + "/compose.json", "preflight Compose")
    from docker_volume_dev import _validate_retained_service
    image = json.loads(docker_capture("image", "inspect", actual["Image"], timeout=60).stdout)
    _validate_retained_service(compose, actual, "backend", image[0]["Config"])
    observed = actual["State"]
    incarnation = {"id": actual["Id"], "image": actual["Image"], "pid": observed.get("Pid"),
                   "status": observed.get("Status"), "exit_code": observed.get("ExitCode"),
                   "oom_killed": observed.get("OOMKilled"), "started_at": observed.get("StartedAt"),
                   "finished_at": observed.get("FinishedAt")}
    if (actual.get("HostConfig", {}).get("PidMode") not in (None, "", "private")
            or incarnation["started_at"] != args.started_at or incarnation["finished_at"] != args.finished_at):
        raise BuildControlError("Preflight container incarnation differs from explicit observation")
    logs = docker_capture("logs", "--timestamps", "--since", args.started_at, args.container_id, timeout=90)
    if logs.returncode or len(logs.stdout) + len(logs.stderr) > 2 * 1024 * 1024:
        raise BuildControlError("Preflight log observation failed or exceeded its bound")
    text = (logs.stdout + logs.stderr).decode("utf-8", "strict")
    from docker_volume_capture_failure_reconcile import _timestamp_ns
    for line in text.splitlines():
        stamp = line.split(" ", 1)[0]
        if not _timestamp_ns(args.started_at) <= _timestamp_ns(stamp) <= _timestamp_ns(args.finished_at):
            raise BuildControlError("Preflight log line is outside its exact incarnation")
    log_record = {"incarnation": incarnation, "log": text}
    log_raw = canonical(log_record) + b"\n"
    safety = _released_snapshot(control, actual)
    safety_raw = canonical(safety) + b"\n"
    provenance_raw, provenance = _record(control, "backend/runtime-provenance.json", "preflight build provenance")
    if (provenance.get("schema") != "fullmag.docker-all-image.v1" or provenance.get("state") != "succeeded"
            or provenance.get("source_snapshot_sha256") != args.source_snapshot):
        raise BuildControlError("Preflight build provenance differs from explicit source snapshot")
    current = _control_bytes(control, "runtime-control/runtime-service/process-tree.json")
    owner = _control_bytes(control, "runtime-control/runtime-services/OWNER.json")
    if _sha(owner) != proof["terminal_owner_record_sha256"]:
        raise BuildControlError("Original native owner changed")
    record = {
        "schema": service.PRE_ACK_RETRY_SCHEMA, "parent": None, "operation_attempt": operation_id,
        "request_sha256": bundle["request_sha256"], "proof_sha256": bundle["proof_sha256"],
        "run_id": request["run_id"], "project_id": request["project_id"],
        "compose_project": control.project, "control_volume": control.volume,
        "original_process_sha256": proof["terminal_process_record_sha256"],
        "owner_sha256": _sha(owner), "current_process_sha256": _sha(current),
        "api_attempt": args.api_attempt, "api_attempt_sha256": _sha(api_raw),
        "api_container": api_container, "api_image": api_attempt["inputs"]["image_id"],
        "api_incarnation": journal.get("container_state"), "api_stop_sha256": _sha(journal_raw),
        "preflight_attempt": args.preflight_attempt, "preflight_attempt_sha256": _sha(pre_raw),
        "preflight_container": args.container_id, "preflight_image": actual["Image"],
        "preflight_incarnation": incarnation, "preflight_log_sha256": _sha(log_raw),
        "preflight_compose_sha256": _sha(compose_raw), "released_observation_sha256": _sha(safety_raw),
        "native_restart_sha256": _sha(canonical(inputs.get("native_failed_restart"))),
        "preflight_provenance_sha256": _sha(provenance_raw), "preflight_source_snapshot": args.source_snapshot,
    }
    process_relative = "runtime-control/" + parent + "/pre-ack-api-terminal.json"
    log_relative = "pre-ack-retry/attempts/" + operation_id + "/preflight-log.json"
    def read_record(path, label):
        if path == process_relative:
            return current, json.loads(current)
        if path == log_relative:
            return log_raw, log_record
        if path == "pre-ack-retry/attempts/" + operation_id + "/released-observation.json":
            return safety_raw, safety
        if path == "pre-ack-retry/attempts/" + operation_id + "/preflight-provenance.json":
            return provenance_raw, provenance
        return _record(control, path, label)
    service._validate_pre_ack_retry_record(record, canonical(record) + b"\n", request, proof,
                                          bundle["request_sha256"], read_record, require_operation=False)
    return record, relative, process_relative, current, log_relative, log_record, safety, provenance_raw


def retained_pre_ack_context(control, previous, document, backend_id, *, fresh_state=False):
    """Carry only the already-authorized, byte-pinned API predecessor context."""
    pins = previous.get("inputs", {}).get("accepted_reattach")
    if not isinstance(pins, dict):
        return None
    selected = Path(previous["inputs"]["source_root"]).resolve(strict=True)
    layout = storage.resolve_layout(selected, "docker-all-gpu")
    identity = compose_project_identity(layout)
    if identity.get("checkout_kind") != "main-checkout" or identity.get("project_name") != "fullmag-master":
        return None
    _require_main(identity, control)
    relative = str(PurePosixPath(pins.get("proof_relative", "")).parent / "pre-ack-retry.json")
    raw = _control_bytes(control, "runtime-control/" + relative, optional=True)
    if raw is None:
        return None
    if fresh_state:
        raise BuildControlError("Pre-ACK retry must retain the exact original state")
    service = _service()
    record = json.loads(raw)
    if previous.get("attempt") != record.get("preflight_attempt") or backend_id != record.get("preflight_container"):
        raise BuildControlError("First pre-ACK retry cannot authorize another preflight incarnation")
    state = storage.validate_path(Path(previous["state_root"]), Path(layout["runtime_root"]), "pre-ACK retained state")
    bundle = _bundle_from_records(control, store_root=state / "runs/docker-all/session-store")
    service._validate_pre_ack_retry_record(record, raw, bundle["request"], bundle["proof"], bundle["request_sha256"],
                                          lambda path, label: _record(control, path, label))
    from docker_volume_activation_reconcile import _inspect_stopped_backend, _probe_helper_absence
    actual = _inspect_stopped_backend(control, backend_id, record["preflight_image"])
    observed = actual["State"]
    fresh_incarnation = {"id": actual["Id"], "image": actual["Image"], "pid": observed.get("Pid"),
                         "status": observed.get("Status"), "exit_code": observed.get("ExitCode"),
                         "oom_killed": observed.get("OOMKilled"), "started_at": observed.get("StartedAt"),
                         "finished_at": observed.get("FinishedAt")}
    if fresh_incarnation != record["preflight_incarnation"] or _probe_helper_absence(record["api_container"]) is None:
        raise BuildControlError("Pre-ACK retry stopped namespace observations differ")
    if (_sha(_control_bytes(control, "runtime-control/runtime-service/process-tree.json")) != record["current_process_sha256"]
            or _sha(_control_bytes(control, "runtime-control/runtime-services/OWNER.json")) != record["owner_sha256"]):
        raise BuildControlError("Pre-ACK retry current native bytes changed")
    archive, _ = _record(control, "pre-ack-retry/attempts/" + record["operation_attempt"] + "/released-observation.json", "released observation")
    if canonical(_released_snapshot(control, actual)) + b"\n" != archive:
        raise BuildControlError("Pre-ACK retry released-state projection changed")
    from docker_volume_dev import _read_runtime_config_digest
    metadata = previous["inputs"]["native_failed_restart"]
    _, journal = _record(control, "verification/stop-failed-" + record["api_container"] + ".json", "API stop journal")
    failure = journal["failure_receipt"]
    from docker_volume_stop_failed import _validate_native_failure_probe
    _validate_native_failure_probe(journal["native_failure_probe"], failure["sha256"], api_start_failure=True)
    expected = {
        "schema": "fullmag.docker-native-failed-stop-recreate.v1", "failure_kind": "native-start-failure",
        "failure_mode": "api-start-failure", "journal_sha256": record["api_stop_sha256"],
        "container_id": record["api_container"], "image_id": record["api_image"],
        "failure_receipt_sha256": failure["sha256"],
        "terminal_process_receipt_sha256": record["current_process_sha256"],
        "terminal_failed_owner_sha256": record["owner_sha256"],
        "previous_config_sha256": _read_runtime_config_digest(control), "claim_pending": False,
    }
    if metadata != expected or _sha(canonical(metadata)) != record["native_restart_sha256"]:
        raise BuildControlError("Pre-ACK retry cannot delegate changed native restart authority")
    scan_path = control.path("runtime-control/" + str(PurePosixPath(relative).parent))
    scan = bounded_capture(control.helper_args("find '" + scan_path + "' -mindepth 1 -maxdepth 1 -printf '%f\\n'"), data=b"", timeout=90)
    allowed = {"request.json", "proof.json", "terminal-owner.json", "terminal-process.json",
               "pre-ack-retry.json", "pre-ack-api-terminal.json"}
    names = scan.stdout.decode().splitlines()
    if scan.returncode or len(names) > 64 or any(name not in allowed for name in names):
        raise BuildControlError("Pre-ACK retry has consumed or uncertain ACK evidence")
    return {"previous_config_sha256": metadata["previous_config_sha256"], "native_restart_metadata": dict(metadata)}


def _require_main(identity, control=None):
    if (identity.get("checkout_kind") != "main-checkout"
            or identity.get("project_name") != "fullmag-master"
            or (control is not None and control.project != identity["project_name"])):
        raise BuildControlError("First pre-ACK retry is restricted to the registered main checkout/fullmag-master")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--api-attempt", required=True)
    parser.add_argument("--preflight-attempt", required=True)
    parser.add_argument("--container-id", required=True)
    parser.add_argument("--started-at", required=True)
    parser.add_argument("--finished-at", required=True)
    parser.add_argument("--source-snapshot", required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--expected-preview-sha256")
    args = parser.parse_args()
    require_host()
    if any(re.fullmatch(r"[0-9a-f]{32}", value) is None for value in (args.api_attempt, args.preflight_attempt)):
        raise BuildControlError("Exact development attempt UUIDs are required")
    if re.fullmatch(r"[0-9a-f]{64}", args.container_id) is None:
        raise BuildControlError("Exact backend container ID is required")
    if re.fullmatch(r"[0-9a-f]{64}", args.source_snapshot) is None:
        raise BuildControlError("Exact preflight build source snapshot is required")
    selected = args.source_root.resolve(strict=True)
    identity = compose_project_identity(storage.resolve_layout(selected, "docker-all-gpu"))
    _require_main(identity)
    configuration = toolchain_configuration(selected, identity)
    control = BuildControl(identity, configuration["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"])
    preview = _collect(control, selected, args, "0" * 32)
    preview_sha = _sha(canonical(preview[0]))
    if not args.apply:
        print(json.dumps({"mode": "preview", "preview_sha256": preview_sha, "record": preview[0]}, indent=2))
        return
    if args.expected_preview_sha256 != preview_sha:
        raise BuildControlError("Explicit exact preview digest is required before publication")
    with control.operation("pre-ack-retry", {"preview_sha256": preview_sha}) as operation:
        fresh = _collect(control, selected, args, "0" * 32)
        if fresh != preview:
            raise BuildControlError("Pre-ACK retry evidence changed before publication")
        token = operation["receipt"]["attempt"]
        record, relative, process_path, process_raw, _, log_record, safety, provenance_raw = fresh
        record["operation_attempt"] = token
        from docker_volume_capture_failure_reconcile import _publish_create_only
        _publish_create_only(control, operation["root"] + "/preflight-log.json", log_record)
        _publish_create_only(control, operation["root"] + "/released-observation.json", safety)
        _publish_raw(control, operation["root"] + "/preflight-provenance.json", provenance_raw)
        _publish_raw(control, process_path, process_raw)
        # Preserve the original stopped process bytes, including serialization.
        if _control_bytes(control, process_path) != process_raw:
            raise BuildControlError("Archived stopped API terminal bytes differ")
        raw = _publish_create_only(control, "runtime-control/" + relative, record)
        operation["receipt"].update(state="succeeded", retry_record_sha256=_sha(raw), retry_record_path=relative)
    print(json.dumps({"record_path": relative, "record_sha256": _sha(raw), "operation_attempt": token}))


if __name__ == "__main__":
    main()
