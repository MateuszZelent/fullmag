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
                                                _compute_proof_binding, owner_identity as _owner_identity,
                                                portable as _portable)

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
    quiesce = getattr(args, "quiesce_api", False)
    require(type(quiesce) is bool and (not quiesce or capture), "--quiesce-api requires explicit native capture")
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
    revision = scene.get("revision")
    require(type(revision) is int and revision >= 0 and revision == resources["scene_revision"],
            "canonical scene revision differs")
    if "scene_revision" in scene:
        require(type(scene["scene_revision"]) is int and scene["scene_revision"] == revision,
                "optional scene revision alias differs")
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
            and all(counts[name] == 0 for name in ("pending", "dispatched", "running"))
            and counts["accepted"] in (0, 1),
            "more than one accepted command or another active command remains")
    require(all(isinstance(item, dict) for item in entries), "command ledger entry is malformed")
    command_ids = [item.get("command_id") for item in entries]
    sequences = [item.get("seq") for item in entries]
    require(all(isinstance(command_id, str) and command_id for command_id in command_ids)
            and len(set(command_ids)) == len(entries)
            and all(type(seq) is int and seq > 0 for seq in sequences)
            and len(set(sequences)) == len(entries),
            "command ledger identities or sequences differ")
    accepted_entries = [item for item in entries if item.get("status") == "accepted"]
    require(counts["accepted"] == len(accepted_entries), "accepted command counter differs from the ledger")
    if accepted_entries:
        entry = accepted_entries[0]
        require(entry.get("kind") in {"solve", "run", "relax"},
                "accepted command is outside the supported HTTP Compute scope")
        require(type(entry.get("created_at_unix_ms")) is int and entry["created_at_unix_ms"] > 0
                and entry.get("dispatched_at_unix_ms") is None
                and entry.get("completed_at_unix_ms") is None
                and entry.get("completion_status") is None and entry.get("error") is None,
                "accepted command is not an undispatched live entry")
    for name in ("completed", "rejected", "failed"):
        require(counts[name] == sum(item.get("status") == name for item in entries if isinstance(item, dict)),
                "command counters differ")
    require(sum(counts.values()) == len(entries) and all(
        isinstance(item, dict) and item.get("status") in {"accepted", "completed", "rejected", "failed"}
        and (item.get("status") == "accepted" or (
            type(item.get("completed_at_unix_ms")) is int and item["completed_at_unix_ms"] > 0
            and item.get("completion_status") in {
                "completed": {"succeeded", "completed", "cancelled"},
                "rejected": {"rejected"}, "failed": {"failed"},
            }[item["status"]])) for item in entries),
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


def _accepted_compute_ledger_binding(preflight, run_id, command, compute_binding, receipt):
    ledger = preflight.get("commands", {})
    entries = ledger.get("commands")
    require(isinstance(entries, list), "current command ledger is unavailable")
    accepted = [entry for entry in entries if isinstance(entry, dict) and entry.get("status") == "accepted"]
    require(len(accepted) == 1 and ledger.get("accepted_count") == 1,
            "exactly one current accepted HTTP Compute command is required")
    entry = accepted[0]
    seq = entry.get("seq")
    require(type(seq) is int and seq > 0,
            "accepted command sequence is missing or invalid")
    require(entry.get("command_id") == compute_binding.get("command_id")
            and entry.get("kind") == command.get("kind")
            and entry.get("client_intent_id") == command.get("client_intent_id")
            and entry.get("request_id") == receipt.get("request_id"),
            "current accepted command differs from its immutable Compute receipt")
    requested_target = command.get("target")
    bound_target = {"kind": "run", "run_id": run_id}
    require(isinstance(requested_target, dict)
            and requested_target.get("kind") in {"study", "run", "current_stage", "stage_index", "stage_id"}
            and (requested_target.get("kind") != "run"
                 or requested_target.get("run_id") in (None, run_id))
            and entry.get("target") in (requested_target, bound_target),
            "accepted command target differs from the requested scope or bound run")
    require(type(entry.get("created_at_unix_ms")) is int and entry["created_at_unix_ms"] > 0
            and entry.get("dispatched_at_unix_ms") is None
            and entry.get("completed_at_unix_ms") is None
            and entry.get("completion_status") is None and entry.get("error") is None,
            "accepted command is not an undispatched live entry")
    return {"command_id": entry["command_id"], "kind": entry["kind"], "seq": seq,
            "client_intent_id": entry.get("client_intent_id"), "request_id": entry.get("request_id"),
            "target": entry.get("target")}


def optional_store_reader(store_root):
    """Read one optional durable record using the accepted-store no-follow reader."""
    from docker_volume_accepted_reattach import _read_store_regular
    return lambda relative: _read_store_regular(
        store_root, relative, "native terminal optional accepted record", maximum=MAX_BYTES, optional=True,
    )


def run_binding(read_store, preflight, read_optional_store=None):
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
    command = live.get("command")
    require(isinstance(command, dict), "accepted RunIntent command is missing")
    accepted_count = preflight.get("commands", {}).get("accepted_count")
    source_id = command.get("kind")
    if source_id == "startup_script":
        require(accepted_count == 0, "startup RunIntent cannot carry an accepted HTTP Compute command")
        source_id = portable(live.get("request_idempotency_key"))
        source_sha = digest(live.get("startup_source_sha256"))
        require(live.get("command_id") == source_id and command == {
            "kind": "startup_script", "request_id": source_id, "source_sha256": source_sha},
            "accepted startup binding differs")
        release_raw = read_store(prefix + "start_release.json")
        release = decode(release_raw)
        require(release.get("schema_version") in {"accepted_run_start_release.v1", "accepted_run_start_release.v2"}
                and release.get("run_id") == run and release.get("specification_sha256") == intent.get("payload_sha256"),
                "native Start release differs")
        start_release_sha256 = sha(release_raw)
        # Keep existing v1 startup captures usable after this extension.
        source_binding = {"start_release_sha256": start_release_sha256}
    else:
        require(source_id in {"solve", "run", "relax"}, "RunIntent is not a supported HTTP Compute")
        require(type(command.get("seq")) is int and command["seq"] == 0,
                "direct Compute RunIntent sequence must remain unassigned before API publication")
        require(callable(read_optional_store), "direct Compute requires the no-follow optional record reader")
        release_raw = read_optional_store(prefix + "start_release.json")
        require(release_raw is None, "direct HTTP Compute unexpectedly has a native Start release")
        compute_binding = _checked(lambda _: _compute_proof_binding(intent, live, command), None)
        receipt = live.get("request_receipt", {})
        accepted_command = _accepted_compute_ledger_binding(
            preflight, run, command, compute_binding, receipt,
        )
        source_binding = {"source_kind": "http_compute", "compute": compute_binding,
                          "accepted_command": accepted_command, "start_release_sha256": None}
    tasks = catalog.get("tasks")
    require(catalog.get("schema_version") == "run_catalog.v1" and catalog.get("run_id") == run
            and type(catalog.get("revision")) is int and catalog["revision"] > 0
            and isinstance(tasks, list) and bool(tasks) and all(
                isinstance(task, dict) and task.get("lifecycle") == "succeeded" for task in tasks),
            "native tasks are not all Succeeded")
    return {"run_id": run, "intent_sha256": sha(intent_raw), "catalog_sha256": sha(catalog_raw),
            **source_binding, "specification_sha256": digest(intent.get("payload_sha256"))}


# Fixed read-only transport. No code is imported from the selected/foreign run.
PROBE = r'''import hashlib,json,re,stat,sys,urllib.request
sys.path.insert(0,"/opt/fullmag")
import runtime_service as service
import entrypoint
# Reuse the fixed image-owned ABI configuration before invoking native CLI reads.
entrypoint._configure_device_access()
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
def optional_record_pin(path):
 service._assert_no_links(path.parent,"native terminal optional record parent")
 try: metadata=path.lstat()
 except FileNotFoundError: return None
 if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
  raise RuntimeError("native terminal optional record is not a regular non-link file")
 return hashlib.sha256(service._bounded_regular(path,"native terminal optional record",MAX)).hexdigest()
def run_pins():
 run=before["run"]["run_id"]
 if not isinstance(run,str) or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}",run) is None:
  raise RuntimeError("invalid accepted run identity")
 root=paths.store/"runs"/run
 return {"run_intent.json":hashlib.sha256(service._bounded_regular(root/"run_intent.json","native terminal accepted record",MAX)).hexdigest(),
  "run_catalog.json":hashlib.sha256(service._bounded_regular(root/"run_catalog.json","native terminal accepted record",MAX)).hexdigest(),
  "start_release.json":optional_record_pin(root/"start_release.json")}
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
    binding = run_binding(read_store, before, optional_store_reader(store_root))
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
    if "api_quiescence" in captured:
        validate_quiescence(captured)
        proof = captured["api_quiescence"]
        require(process.get("api_pid") == proof["api_pin"]["pid"]
                and process.get("error") == QUIESCE_CAUSE and process.get("api_diagnostic_only") is False,
                "drain lost the exact API quiescence cause")
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
    require(run_binding(_store_reader(store_root), captured["preflight"], optional_store_reader(store_root))
            == captured.get("run_binding"),
            "stopped accepted run changed after native inspection")
    require(sha(read(CONFIG_PATH)) == captured.get("native_config_sha256"), "native config changed after stop")
    drain = decode(read(root + "backend-drain.json"))
    process = drain.get("process_receipt", {})
    validate_drain(captured, process)
    require(drain.get("schema") == "fullmag.docker-idle-restart-drain.v1"
            and drain.get("backend_container_id") == terminal.get("backend_container")
            and drain.get("process_receipt_sha256") == sha(canonical(process) + b"\n")
            and decode(read(PROCESS_PATH)) == process, "current drained process receipt differs")
    quiesced = terminal.get("inputs", {}).get("quiesce_api", False)
    require(type(quiesced) is bool and quiesced == ("api_quiescence" in captured),
            "stop mode and API quiescence proof differ")
    intent = None
    if quiesced:
        validate_quiescence(captured)
        intent_raw = read(root + "api-quiescence-intent.json")
        intent = decode(intent_raw)
        require(sha(intent_raw) == captured["api_quiescence"]["intent_sha256"]
                == terminal.get("api_quiescence_intent_sha256")
                and intent.get("schema") == QUIESCE_INTENT_SCHEMA,
                "API quiescence intent CAS differs")
        prepared = intent.get("prepared", {})
        require(prepared.get("preflight") == captured["preflight"]
                and prepared.get("run_binding") == captured["run_binding"]
                and prepared.get("native_config_sha256") == captured["native_config_sha256"]
                and prepared.get("api_pin") == captured["api_quiescence"]["api_pin"]
                and canonical(owner_identity(prepared.get("ready_owner", {}))) == canonical(captured["ready_owner"]),
                "API quiescence intent authority differs")
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
    if intent is not None:
        require(set(intent.get("services", {})) == set(stopped), "quiescence service set differs")
        for name, observed in stopped.items():
            before = intent["services"][name]
            require(all(before.get(key) == observed.get(key) for key in ("Id", "Image", "Config", "HostConfig", "Mounts"))
                    and before.get("State", {}).get("StartedAt") == observed.get("State", {}).get("StartedAt")
                    and before.get("State", {}).get("Running") is (name == "backend"),
                    "quiescence intent service incarnation differs")
        require(stopped["backend"].get("State", {}).get("ExitCode") == 1
                and stopped["backend"].get("State", {}).get("OOMKilled") is False,
                "quiesced backend exit differs from the retained API cause")
    return {"schema": "fullmag.native-terminal-stop-fresh-state.v1", "stop_attempt": stop_attempt,
            "stop_sha256": stop_sha256, "capture_sha256": sha(captured_raw)}

QUIESCE_SCHEMA = "fullmag.native-terminal-api-quiescence.v1"
QUIESCE_INTENT_SCHEMA = "fullmag.native-terminal-api-quiescence-intent.v1"
QUIESCE_CAUSE = "Fullmag API exited unexpectedly (-15)"
API_BINARY = "/opt/fullmag/package/bin/fullmag-api"

# Reuse only fixed trusted transport definitions, never any run-owned code.
_QUIESCE_PREFIX = PROBE.split("before=snapshot()", 1)[0]
_QUIESCE_COMMON = r'''
import os,pathlib,signal,socket,stat,time
API_BINARY="/opt/fullmag/package/bin/fullmag-api"
CAUSE="Fullmag API exited unexpectedly (-15)"
def canon(value):
 return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(",",":"),allow_nan=False).encode()
def process_record():
 raw=service._bounded_regular(service.process_receipt_path(paths),"API quiescence process receipt",MAX)
 return raw,json.loads(raw,object_pairs_hook=unique)
def proc_pin(pid):
 if type(pid) is not int or pid<=1: raise RuntimeError("invalid API PID")
 root=pathlib.Path("/proc")/str(pid)
 text=(root/"stat").read_text()
 fields=text[text.rfind(")")+2:].split()
 with (root/"cmdline").open("rb") as source: argv=source.read(4097)
 if len(argv)>4096 or argv!=API_BINARY.encode()+b"\0": raise RuntimeError("API argv differs")
 exe=os.readlink(root/"exe")
 if exe!=str(pathlib.Path(API_BINARY).resolve(strict=True)): raise RuntimeError("API executable differs")
 return {"pid":pid,"start_token":fields[19],"ppid":int(fields[1]),"argv":[API_BINARY],"exe":exe}
def optional_record_pin(path):
 service._assert_no_links(path.parent,"API quiescence optional record parent")
 try: metadata=path.lstat()
 except FileNotFoundError: return None
 if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
  raise RuntimeError("API quiescence optional record is not a regular non-link file")
 return hashlib.sha256(service._bounded_regular(path,"API quiescence optional record",MAX)).hexdigest()
def run_pins_for(run):
 if not isinstance(run,str) or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}",run) is None:
  raise RuntimeError("invalid accepted run identity")
 root=paths.store/"runs"/run
 return {"run_intent.json":hashlib.sha256(service._bounded_regular(root/"run_intent.json","API quiescence accepted record",MAX)).hexdigest(),
  "run_catalog.json":hashlib.sha256(service._bounded_regular(root/"run_catalog.json","API quiescence accepted record",MAX)).hexdigest(),
  "start_release.json":optional_record_pin(root/"start_release.json")}
def api_binding(value):
 status=value["status"]; session=status["session"]; resources=status["resources"]
 return {"schema":"fullmag.native-terminal-stop-preflight.v1","api_instance_id":value["api_instance_id"],
  "session_id":session["session_id"],"session_epoch":session["session_epoch"],
  "request_scope_epoch":session["request_scope_epoch"],"run_id":value["run"]["run_id"],
  "public_run":value["run"],"resources":resources,"scene_sha256":hashlib.sha256(canon(value["scene"])).hexdigest(),
  "scene_revision":resources["scene_revision"],"queue":value["queue"],"commands":value["commands"],
  "runtime":value["runtime"],"health":{"status":value["health"]["status"],"active_session":value["health"]["active_session"]}}
'''
_PIDFD_CLOSE_COMMON = r'''
def pidfd_close_api(api, expected_owner, verify_before_signal, signal_api):
 fd=os.pidfd_open(api["pid"])
 try:
  if proc_pin(api["pid"])!=api: raise RuntimeError("API incarnation changed before quiescence")
  verify_before_signal()
  signal_api(fd,signal.SIGTERM,None,0)
 finally: os.close(fd)
 # No process, owner, worker or scheduler is signalled after this point.
 deadline=time.monotonic()+15
 while True:
  gone=not (pathlib.Path("/proc")/str(api["pid"])).exists()
  try:
   with socket.create_connection(("127.0.0.1",8081),timeout=.2): closed=False
  except ConnectionRefusedError: closed=True
  if gone and closed: break
  if time.monotonic()>=deadline: raise RuntimeError("API closure is unconfirmed; backend retained")
  time.sleep(.05)
 while True:
  retained_raw,retained=process_record()
  if retained.get("state")=="failed_outcome_retained":
   if (retained.get("api_pid")!=api["pid"] or retained.get("api_exit_code")!=-15
       or retained.get("api_diagnostic_only") is not False or retained.get("error")!=CAUSE
       or service._owner_fingerprint(retained.get("service_owner",{}))!=service._owner_fingerprint(expected_owner)):
    raise RuntimeError("API quiescence cause differs; backend retained")
   return retained_raw,retained
  if time.monotonic()>=deadline: raise RuntimeError("API quiescence retention unconfirmed; backend retained")
  time.sleep(.05)
'''
QUIESCE_PREPARE = _QUIESCE_PREFIX + _QUIESCE_COMMON + r'''
before=snapshot()
owner=service._service_status(paths)
service._validate_terminal_owner(owner,state="ready",name="API quiescence Ready owner")
config=config_digest()
process_raw,process=process_record()
if process.get("schema")!="fullmag.docker-process-tree.v1" or process.get("state")!="ready":
 raise RuntimeError("API process receipt is not Ready")
if service._owner_fingerprint(process.get("service_owner",{}))!=service._owner_fingerprint(owner):
 raise RuntimeError("API process owner differs")
api=proc_pin(process.get("api_pid"))
pins=run_pins_for(before["run"]["run_id"])
after=snapshot()
if config!=config_digest() or process_raw!=process_record()[0] or proc_pin(api["pid"])!=api:
 raise RuntimeError("API quiescence preparation changed")
print(json.dumps({"before":before,"after":after,"ready_owner":owner,"native_config_sha256":config,
 "process_sha256":hashlib.sha256(process_raw).hexdigest(),"api_pin":api,"run_pins":pins},sort_keys=True))
'''
QUIESCE_CAPTURE = _QUIESCE_PREFIX + _QUIESCE_COMMON + _PIDFD_CLOSE_COMMON + r'''
raw=sys.stdin.buffer.read(MAX+1)
if len(raw)>MAX: raise RuntimeError("API quiescence intent exceeds bound")
request=json.loads(raw,object_pairs_hook=unique)
intent=request["intent"]
if hashlib.sha256(canon(intent)+b"\n").hexdigest()!=request["intent_sha256"]:
 raise RuntimeError("API quiescence intent digest differs")
if intent.get("schema")!="fullmag.native-terminal-api-quiescence-intent.v1":
 raise RuntimeError("API quiescence intent schema differs")
prepared=intent["prepared"]
preflight=prepared["preflight"]; api=prepared["api_pin"]; run=preflight["run_id"]
owner=service._service_status(paths)
service._validate_terminal_owner(owner,state="ready",name="API quiescence Ready owner")
def verify_before_signal():
 # Revalidate the pinned live API and native owner before the one signal.
 for _ in range(2):
  current=snapshot()
  if (api_binding(current)!=preflight or current["status"]["solver"]["state"]!="running"
      or current["status"].get("run",{}).get("run_id")!=run):
   raise RuntimeError("API/session/scene/resources changed before quiescence")
 current_owner=service._service_status(paths)
 service._validate_terminal_owner(current_owner,state="ready",name="API quiescence Ready owner")
 if service._owner_fingerprint(current_owner)!=service._owner_fingerprint(prepared["ready_owner"]):
  raise RuntimeError("Native owner changed before API quiescence")
 if (config_digest()!=prepared["native_config_sha256"] or run_pins_for(run)!=prepared["run_pins"]
     or hashlib.sha256(process_record()[0]).hexdigest()!=prepared["process_sha256"]
     or proc_pin(api["pid"])!=api):
  raise RuntimeError("Pinned authority changed before API quiescence")
def signal_api_once(fd,signum,info,flags): signal.pidfd_send_signal(fd,signum,info,flags)
retained_raw,retained=pidfd_close_api(api,owner,verify_before_signal,signal_api_once)
if config_digest()!=prepared["native_config_sha256"] or run_pins_for(run)!=prepared["run_pins"]:
 raise RuntimeError("Native pins changed after API closure; backend retained")
evidence=service._run_cli(paths,["runtime","service-inspect-terminal-run","--config",str(paths.config),
 "--config-sha256",prepared["native_config_sha256"],"--run-id",run],timeout=30)
fresh_owner=service._service_status(paths)
service._validate_terminal_owner(fresh_owner,state="ready",name="API quiescence retained owner")
if (service._owner_fingerprint(owner)!=service._owner_fingerprint(fresh_owner)
    or config_digest()!=prepared["native_config_sha256"] or run_pins_for(run)!=prepared["run_pins"]
    or retained_raw!=process_record()[0]):
 raise RuntimeError("Native inspection pins changed after API closure; backend retained")
print(json.dumps({"evidence":evidence,"run_pins":prepared["run_pins"],"retained_process":retained,
 "retained_process_sha256":hashlib.sha256(retained_raw).hexdigest(),"api_closed":True},sort_keys=True))
'''


def quiescence_capture_program(mode_specific_capture_body: str, *, prelude: str | None = None) -> str:
    """Build a capture with the same pinned API/pidfd primitives for a distinct admission mode."""
    require(isinstance(mode_specific_capture_body, str) and mode_specific_capture_body.strip(),
            "mode-specific API quiescence capture body is empty")
    capture_prelude = _QUIESCE_PREFIX + _QUIESCE_COMMON if prelude is None else prelude
    require(isinstance(capture_prelude, str) and capture_prelude.strip(),
            "mode-specific API quiescence prelude is empty")
    return capture_prelude + _PIDFD_CLOSE_COMMON + mode_specific_capture_body


def pidfd_close_primitive_script() -> str:
    """Return the neutral one-API pidfd-close primitive for a fixed capture script."""
    return _PIDFD_CLOSE_COMMON


def _record_pins(binding):
    release_pin = binding.get("start_release_sha256")
    if release_pin is not None:
        digest(release_pin)
    return {"run_intent.json": digest(binding.get("intent_sha256")),
            "run_catalog.json": digest(binding.get("catalog_sha256")),
            "start_release.json": release_pin}


def prepare_api_quiescence(backend_id, store_root):
    """Read-only admission to closing one exact API, not native terminal authority."""
    from docker_build_control import docker_capture
    from docker_volume_terminal_observation import _store_reader
    result = docker_capture("exec", backend_id, "python3", "-I", "-B", "-c", QUIESCE_PREPARE, timeout=180)
    require(len(result.stdout) <= 2 * MAX_BYTES, "quiescence preparation exceeds bound")
    observed = decode(result.stdout)
    preflight = snapshot_binding(observed.get("before"))
    require(preflight == snapshot_binding(observed.get("after")), "API changed during quiescence preparation")
    binding = run_binding(_store_reader(store_root), preflight, optional_store_reader(store_root))
    require(observed.get("run_pins") == _record_pins(binding), "accepted records changed before quiescence intent")
    owner = observed.get("ready_owner", {})
    require(owner.get("state") == "ready", "quiescence owner is not Ready")
    owner_identity(owner)
    api = observed.get("api_pin", {})
    require(type(api.get("pid")) is int and api["pid"] > 1 and isinstance(api.get("start_token"), str)
            and api["start_token"].isdigit() and type(api.get("ppid")) is int and api["ppid"] > 0
            and api.get("argv") == [API_BINARY] and api.get("exe") == API_BINARY, "API process pin differs")
    return {"preflight": preflight, "run_binding": binding, "run_pins": _record_pins(binding),
            "ready_owner": owner, "api_pin": api, "process_sha256": digest(observed.get("process_sha256")),
            "native_config_sha256": digest(observed.get("native_config_sha256"))}


def quiesce_api_and_capture(backend_id, store_root, intent):
    """One pidfd signal after durable intent; failures never respawn the API."""
    from docker_build_control import docker_capture
    from docker_volume_terminal_observation import _store_reader
    intent_sha = sha(canonical(intent) + b"\n")
    request = canonical({"intent": intent, "intent_sha256": intent_sha})
    result = docker_capture("exec", "-i", backend_id, "python3", "-I", "-B", "-c", QUIESCE_CAPTURE,
                            data=request, timeout=210)
    require(len(result.stdout) <= MAX_BYTES, "quiesced capture exceeds bound")
    observed = decode(result.stdout)
    prepared = intent["prepared"]
    require(run_binding(_store_reader(store_root), prepared["preflight"], optional_store_reader(store_root))
            == prepared["run_binding"]
            and observed.get("run_pins") == prepared["run_pins"], "accepted records changed after API quiescence")
    evidence = observed.get("evidence", {})
    terminal_sha = digest(evidence.get("terminal_evidence_sha256"))
    require(evidence == {"schema_version": "runtime_service_terminal_run_evidence.v1",
        "run_id": prepared["preflight"]["run_id"], "terminal_evidence_sha256": terminal_sha,
        "mutations_applied": False, "solve_replayed": False}
        and evidence["mutations_applied"] is False and evidence["solve_replayed"] is False,
        "quiesced native inspection identity or mutation flags differ")
    captured = {"schema": SCHEMA, "preflight": prepared["preflight"], "run_binding": prepared["run_binding"],
        "native_config_sha256": prepared["native_config_sha256"], "terminal_evidence_sha256": terminal_sha,
        "ready_owner": owner_identity(prepared["ready_owner"]), "api_quiescence": {
            "schema": QUIESCE_SCHEMA, "intent_sha256": intent_sha, "api_pin": prepared["api_pin"],
            "api_closed": observed.get("api_closed"), "signal": "SIGTERM",
            "retained_process": observed.get("retained_process"),
            "retained_process_sha256": observed.get("retained_process_sha256")}}
    validate_quiescence(captured)
    return captured


def validate_quiescence(captured):
    proof = captured.get("api_quiescence", {})
    process = proof.get("retained_process", {})
    require(proof.get("schema") == QUIESCE_SCHEMA and proof.get("api_closed") is True
            and proof.get("signal") == "SIGTERM", "explicit API closure is unconfirmed")
    digest(proof.get("intent_sha256"))
    api = proof.get("api_pin", {})
    require(type(api.get("pid")) is int and api["pid"] > 1 and api.get("argv") == [API_BINARY]
            and api.get("exe") == API_BINARY and isinstance(api.get("start_token"), str)
            and api["start_token"].isdigit(), "closed API incarnation differs")
    # runtime_service._atomic_json uses ensure_ascii=True and compact JSON+LF.
    process_raw = (json.dumps(process, sort_keys=True, separators=(",", ":")) + "\n").encode()
    require(sha(process_raw) == proof.get("retained_process_sha256")
            and process.get("schema") == "fullmag.docker-process-tree.v1"
            and process.get("state") == "failed_outcome_retained" and process.get("error") == QUIESCE_CAUSE
            and process.get("api_pid") == api["pid"] and type(process.get("api_exit_code")) is int
            and process["api_exit_code"] == -15 and process.get("api_diagnostic_only") is False
            and process.get("accepted_store") == "/state/runs/docker-all/session-store"
            and process.get("service_owner", {}).get("state") == "ready"
            and canonical(owner_identity(process["service_owner"])) == canonical(captured.get("ready_owner")),
            "API quiescence retained cause or owner differs")
