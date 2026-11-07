"""Explicit offline-preservation authority for a stale public Running run.

This is not terminal observation/restore authority. The public status is kept
verbatim; Rust's existing fenced inspection and the existing graceful drain
are mandatory. Nothing in this module schedules or replays a solve.
"""
from __future__ import annotations

import hashlib
import json
import re

from docker_build_control import BuildControlError
from docker_volume_terminal_observation import (canonical, decode as _decode, digest as _digest,
                                                owner_identity as _owner_identity, portable as _portable)

SCHEMA = "fullmag.native-terminal-stop-capture.v1"
PREFLIGHT_SCHEMA = "fullmag.native-terminal-stop-preflight.v1"
MAX_BYTES = 8 * 1024 * 1024
CONFIG_PATH = "runtime-control/runtime-service/docker-all.json"
PROCESS_PATH = "runtime-control/runtime-service/process-tree.json"


def require(condition, message):
    if not condition:
        raise BuildControlError("Native terminal stop: " + message)


def _checked(provider, value):
    try:
        return provider(value)
    except (ValueError, TypeError, KeyError) as error:
        raise BuildControlError("Native terminal stop: invalid bounded proof field") from error


def decode(value):
    return _checked(_decode, value)


def digest(value):
    return _checked(_digest, value)


def portable(value):
    return _checked(_portable, value)


def owner_identity(value):
    return _checked(_owner_identity, value)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def validate_options(args, *, recreate_services, restart_idle_service, stop_after_drain,
                     resume_recreation_id=None, refresh_frontend_service=False, retire_only=False):
    capture = getattr(args, "capture_native_terminal", False)
    stop, digest_pin = (getattr(args, key, None) for key in (
        "native_terminal_stop", "native_terminal_stop_sha256"))
    require(type(capture) is bool, "capture flag must be boolean")
    require(bool(stop) == bool(digest_pin), "fresh-state requires paired stop receipt pins")
    if capture:
        require(restart_idle_service and stop_after_drain and not recreate_services
                and not any(getattr(args, key, None) for key in (
                    "capture_terminal_observation", "saved_authoring_checkpoint", "saved_authoring_checkpoint_sha256",
                    "allow_prepared_session", "native_terminal_stop", "native_terminal_stop_sha256")),
                "capture requires plain explicit restart-idle --stop-only")
    if stop:
        require(isinstance(stop, str) and re.fullmatch(r"[0-9a-f]{32}", stop), "invalid stop attempt")
        digest(digest_pin)
        require(recreate_services and getattr(args, "fresh_state", False) is True
                and not restart_idle_service and not stop_after_drain
                and resume_recreation_id is None and not refresh_frontend_service and not retire_only
                and not any(getattr(args, key, None) for key in (
                    "script", "terminal_observation_stop", "terminal_observation_proof", "terminal_observation_proof_sha256",
                    "recovery_authorization", "completed_recreation_attempt", "completed_recreation_sha256",
                    "drained_successor_proof", "drained_successor_proof_sha256", "lost_state_stop",
                    "offline_reconciliation", "pending_activation", "restart_backend")),
                "stop receipt authorizes only plain fresh-state archival")
    return capture, (stop, digest_pin) if stop else None


def snapshot_binding(snapshot):
    """Select stable API resources, not heartbeat, telemetry or uptime."""
    require(isinstance(snapshot, dict), "API snapshot is unavailable")
    status, run = snapshot.get("status", {}), snapshot.get("run", {})
    session = status.get("session", {})
    resources = status.get("resources", {})
    scene = snapshot.get("scene", {})
    api = snapshot.get("api_instance_id")
    require(isinstance(api, str) and re.fullmatch(
        r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", api), "API identity differs")
    session_id = portable(session.get("session_id"))
    run_id = portable(run.get("run_id"))
    require(status.get("run", {}).get("run_id") == run_id
            and run.get("session_id") == session_id and run.get("status") == "running"
            and status.get("solver", {}).get("state") == "running", "public run is not stale Running")
    require(isinstance(resources, dict) and type(resources.get("scene_revision")) is int
            and resources["scene_revision"] >= 0, "scene resource identity is missing")
    require(scene.get("scene_revision") == resources["scene_revision"], "scene revision differs")
    epoch = session.get("session_epoch")
    started = run.get("started_at")
    require(isinstance(started, str) and started.isdigit() and int(started) > 0
            and epoch == f"{session_id}@{started}", "public session epoch differs")
    request_epoch = session.get("request_scope_epoch")
    require(isinstance(request_epoch, str) and request_epoch.startswith(api + ":")
            and request_epoch[len(api) + 1:].isdigit(), "request scope differs")
    queue = snapshot.get("queue", {})
    require(queue.get("schema_version") == "compute_queue.v1"
            and queue.get("items") == [] and queue.get("next_cursor") is None,
            "queue is nonempty, unknown or paginated")
    commands = snapshot.get("commands", {})
    entries = commands.get("commands")
    require(isinstance(entries, list) and type(commands.get("revision")) is int
            and commands["revision"] >= 0, "command ledger is unavailable")
    counts = {name: commands.get(name + "_count") for name in (
        "pending", "accepted", "dispatched", "running", "completed", "rejected", "failed")}
    require(all(type(value) is int and value >= 0 for value in counts.values())
            and all(counts[name] == 0 for name in ("pending", "accepted", "dispatched", "running")),
            "active commands remain")
    for name in ("completed", "rejected", "failed"):
        require(counts[name] == sum(item.get("status") == name for item in entries if isinstance(item, dict)),
                "command counters differ")
    require(sum(counts.values()) == len(entries) and all(
        isinstance(item, dict) and item.get("status") in {"completed", "rejected", "failed"}
        and type(item.get("completed_at_unix_ms")) is int and item["completed_at_unix_ms"] > 0
        and item.get("completion_status") in {
            "completed": {"succeeded", "completed", "cancelled"},
            "rejected": {"rejected"}, "failed": {"failed"},
        }[item["status"]] for item in entries),
        "command completion evidence is incomplete")
    runtime = snapshot.get("runtime", {})
    require(runtime.get("schema_version") == "application_service_status.v1"
            and runtime.get("configured") is True and runtime.get("state") == "ready", "runtime is not Ready")
    health = snapshot.get("health", {})
    require(health.get("status") == "ok" and health.get("active_session") is True, "backend health differs")
    return {"schema": PREFLIGHT_SCHEMA, "api_instance_id": api, "session_id": session_id,
            "session_epoch": epoch, "request_scope_epoch": request_epoch, "run_id": run_id,
            "public_run": run, "resources": resources, "scene_sha256": sha(canonical(scene)),
            "scene_revision": resources["scene_revision"], "queue": queue, "commands": commands,
            "runtime": runtime, "health": {"status": "ok", "active_session": True}}


def run_binding(read_store, preflight):
    run = portable(preflight.get("run_id"))
    prefix = "runs/" + run + "/"
    intent_raw = read_store(prefix + "run_intent.json")
    catalog_raw = read_store(prefix + "run_catalog.json")
    intent, catalog = decode(intent_raw), decode(catalog_raw)
    require(intent.get("schema_version") == "run_intent.v1" and intent.get("run_id") == run,
            "RunIntent differs")
    spec = intent.get("specification", {})
    live = spec.get("parameters", {}).get("live_workspace", {})
    snapshot = spec.get("snapshot", {})
    epoch = live.get("session_epoch")
    require(spec.get("run_id") == run and live.get("session_id") == preflight.get("session_id")
            and live.get("api_instance_id") == preflight.get("api_instance_id")
            and type(epoch) is int and epoch > 0
            and preflight.get("request_scope_epoch") == f"{live.get('api_instance_id')}:{epoch}"
            and live.get("scene_revision") == preflight.get("scene_revision")
            and snapshot.get("definition_revision") == preflight.get("scene_revision"),
            "accepted session or scene differs")
    # This mode is deliberately limited to a released startup Study.
    source_id = portable(live.get("request_idempotency_key"))
    source_sha = digest(live.get("startup_source_sha256"))
    require(live.get("command_id") == source_id and live.get("command") == {
        "kind": "startup_script", "request_id": source_id, "source_sha256": source_sha},
        "accepted startup binding differs")
    release_raw = read_store(prefix + "start_release.json")
    release = decode(release_raw)
    require(release.get("schema_version") in {"accepted_run_start_release.v1", "accepted_run_start_release.v2"}
            and release.get("run_id") == run and release.get("specification_sha256") == intent.get("payload_sha256"),
            "native Start release differs")
    tasks = catalog.get("tasks")
    require(catalog.get("schema_version") == "run_catalog.v1" and catalog.get("run_id") == run
            and type(catalog.get("revision")) is int and catalog["revision"] > 0
            and isinstance(tasks, list) and bool(tasks) and all(
                isinstance(task, dict) and task.get("lifecycle") == "succeeded" for task in tasks),
            "native tasks are not all Succeeded")
    return {"run_id": run, "intent_sha256": sha(intent_raw), "catalog_sha256": sha(catalog_raw),
            "start_release_sha256": sha(release_raw), "specification_sha256": digest(intent.get("payload_sha256"))}


# Fixed read-only transport. No code is imported from the selected/foreign run.
PROBE = r'''import hashlib,json,re,sys,urllib.request
sys.path.insert(0,"/opt/fullmag")
import runtime_service as service
paths=service.canonical_paths()
instance=None
MAX=8*1024*1024
def unique(pairs):
 result={}
 for key,value in pairs:
  if key in result: raise RuntimeError("duplicate probe key")
  result[key]=value
 return result
def get(path):
 global instance
 headers={"Host":"localhost","Accept":"application/json"}
 if instance: headers["x-fullmag-api-instance"]=instance
 with urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:8081"+path,headers=headers),timeout=10) as response:
  ids=response.headers.get_all("x-fullmag-api-instance") or []
  if response.status!=200 or len(ids)!=1 or (instance is not None and ids[0]!=instance):
   raise RuntimeError("API identity changed")
  instance=ids[0]
  raw=response.read(MAX+1)
  if len(raw)>MAX: raise RuntimeError("API response exceeds bound")
 return json.loads(raw,object_pairs_hook=unique)
def snapshot():
 result={key:get(path) for key,path in (
  ("health","/v2/platform/health"),("status","/v2/sessions/current/status"),
  ("run","/v2/sessions/current/simulation/runs/current"),("scene","/v2/sessions/current/model/scene"),
  ("queue","/v2/platform/compute/queue"),("commands","/v2/sessions/current/simulation/commands"),
  ("runtime","/v2/platform/runtime-service"))}
 result["api_instance_id"]=instance
 return result
def config_digest():
 return hashlib.sha256(service._bounded_regular(paths.config,"native terminal stop config",65536)).hexdigest()
before=snapshot()
owner=service._service_status(paths)
service._validate_terminal_owner(owner,state="ready",name="native terminal stop owner")
config=config_digest()
def run_pins():
 run=before["run"]["run_id"]
 if not isinstance(run,str) or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}",run) is None:
  raise RuntimeError("invalid accepted run identity")
 return {name:hashlib.sha256(service._bounded_regular(paths.store/"runs"/run/name,"native terminal accepted record",MAX)).hexdigest()
  for name in ("run_intent.json","run_catalog.json","start_release.json")}
pins=run_pins()
evidence=service._run_cli(paths,["runtime","service-inspect-terminal-run","--config",str(paths.config),
 "--config-sha256",config,"--run-id",before["run"]["run_id"]],timeout=30)
after=snapshot()
if pins!=run_pins() or config!=config_digest() or service._owner_fingerprint(owner)!=service._owner_fingerprint(service._service_status(paths)):
 raise RuntimeError("Native owner/config changed")
print(json.dumps({"before":before,"after":after,"ready_owner":owner,"native_config_sha256":config,"evidence":evidence,"run_pins":pins},sort_keys=True))
'''


def capture(backend_id, store_root):
    from docker_build_control import docker_capture
    from docker_volume_terminal_observation import _store_reader
    result = docker_capture("exec", backend_id, "python3", "-I", "-B", "-c", PROBE, timeout=210)
    require(len(result.stdout) <= 2 * MAX_BYTES, "capture exceeds output bound")
    observed = decode(result.stdout)
    before, after = snapshot_binding(observed.get("before")), snapshot_binding(observed.get("after"))
    require(before == after, "API/session/run/scene/resources changed during native inspection")
    read_store = _store_reader(store_root)
    binding = run_binding(read_store, before)
    require(observed.get("run_pins") == {"run_intent.json": binding["intent_sha256"],
            "run_catalog.json": binding["catalog_sha256"], "start_release.json": binding["start_release_sha256"]},
            "accepted records changed around native fenced inspection")
    owner = observed.get("ready_owner", {})
    require(owner.get("state") == "ready", "native owner is not Ready")
    evidence = observed.get("evidence", {})
    terminal_sha = digest(evidence.get("terminal_evidence_sha256"))
    require(evidence == {"schema_version": "runtime_service_terminal_run_evidence.v1",
        "run_id": before["run_id"], "terminal_evidence_sha256": terminal_sha,
        "mutations_applied": False, "solve_replayed": False}
        and evidence["mutations_applied"] is False and evidence["solve_replayed"] is False,
        "native inspection changed state or identifies another run")
    return {"schema": SCHEMA, "preflight": before, "run_binding": binding,
            "native_config_sha256": digest(observed.get("native_config_sha256")),
            "terminal_evidence_sha256": terminal_sha, "ready_owner": owner_identity(owner)}


def validate_drain(captured, process):
    ready, terminal = process.get("service_owner", {}), process.get("terminal_service_owner", {})
    require(process.get("schema") == "fullmag.docker-process-tree.v1" and process.get("state") == "drained"
            and process.get("accepted_store") == "/state/runs/docker-all/session-store"
            and type(process.get("api_exit_code")) is int and process["api_exit_code"] == -15,
            "graceful process drain is unconfirmed")
    require(ready.get("state") == "ready" and terminal.get("state") == "drained"
            and owner_identity(ready) == owner_identity(terminal)
            and canonical(owner_identity(ready)) == canonical(captured.get("ready_owner"))
            and all(child.get("status") == "running" for child in ready.get("children", []))
            and all(child.get("status") == "exited_success" for child in terminal.get("children", [])),
            "native owner/children do not match the successful drain")


def validate_fresh(control, *, stop_attempt, stop_sha256, source_root, attempt, config_sha256, actual, store_root):
    """Authorize only offline fresh-state archival, never retained hydration."""
    from docker_volume_accepted_reattach import _control_bytes
    from docker_volume_terminal_observation import _store_reader
    require(isinstance(stop_attempt, str) and re.fullmatch(r"[0-9a-f]{32}", stop_attempt), "invalid stop attempt")
    digest(stop_sha256)
    root = "iteration/attempts/" + stop_attempt + "/"
    read = lambda relative: _control_bytes(control, relative, maximum=MAX_BYTES)
    raw = read(root + "terminal.json")
    terminal = decode(raw)
    require(sha(raw) == stop_sha256 and read(root + "receipt.json") == raw,
            "stop terminal receipt CAS differs")
    require(terminal.get("schema") == "fullmag.docker-build-operation.v1"
            and terminal.get("attempt") == stop_attempt and terminal.get("phase") == "iteration"
            and terminal.get("state") == "succeeded" and terminal.get("idle_backend_stopped") is True
            and terminal.get("compose_project") == control.project and terminal.get("control_volume") == control.volume
            and terminal.get("control_namespace", "") == getattr(control, "namespace", "")
            and terminal.get("namespace_registry_sha256") == getattr(control, "namespace_registry_sha256", None)
            and terminal.get("config_sha256") == config_sha256
            and terminal.get("inputs", {}).get("source_root") == source_root
            and terminal.get("inputs", {}).get("attempt") == attempt
            and terminal.get("inputs", {}).get("capture_native_terminal") is True
            and terminal.get("inputs", {}).get("config_sha256") == config_sha256,
            "stop operation belongs to another development/config/namespace")
    captured_raw = read(root + "native-terminal-stop.json")
    captured = decode(captured_raw)
    require(sha(captured_raw) == terminal.get("native_terminal_capture_sha256") and captured.get("schema") == SCHEMA,
            "native capture is not pinned by stop terminal")
    require(captured.get("preflight", {}).get("schema") == PREFLIGHT_SCHEMA
            and captured["preflight"].get("public_run", {}).get("status") == "running",
            "literal public Running observation is missing")
    require(run_binding(_store_reader(store_root), captured["preflight"]) == captured.get("run_binding"),
            "stopped accepted run changed after native inspection")
    require(sha(read(CONFIG_PATH)) == captured.get("native_config_sha256"), "native config changed after stop")
    drain = decode(read(root + "backend-drain.json"))
    process = drain.get("process_receipt", {})
    validate_drain(captured, process)
    require(drain.get("schema") == "fullmag.docker-idle-restart-drain.v1"
            and drain.get("backend_container_id") == terminal.get("backend_container")
            and drain.get("process_receipt_sha256") == sha(canonical(process) + b"\n")
            and decode(read(PROCESS_PATH)) == process, "current drained process receipt differs")
    stopped_raw = read(root + "idle-stop-containers.json")
    stopped = decode(stopped_raw)
    require(sha(stopped_raw) == terminal.get("idle_stop_containers_sha256")
            and set(stopped) == set(actual) == {"backend", "frontend"}, "stopped service pins differ")
    for name in stopped:
        old, now = stopped[name], actual[name]
        require(old.get("Id") == terminal.get(name + "_container"), "stop container differs")
        if name == "backend":
            require(old.get("Image") == terminal.get("inputs", {}).get("image_id"), "stop backend image differs")
        require(all(old.get(key) == now.get(key) for key in ("Id", "Image", "Config", "HostConfig", "Mounts"))
                and old.get("State", {}).get("StartedAt") == now.get("State", {}).get("StartedAt")
                and old.get("State", {}).get("Running") is False and now.get("State", {}).get("Running") is False,
                "service incarnation changed after stop")
    return {"schema": "fullmag.native-terminal-stop-fresh-state.v1", "stop_attempt": stop_attempt,
            "stop_sha256": stop_sha256, "capture_sha256": sha(captured_raw)}
