"""Preserve one released prelaunch-failed Study run before fresh-state archival.

This authority is intentionally narrower than terminal observation or native
restart evidence. It proves that the first accepted worker failed before the
solver, its consumed Start was released by the host ledger, and all remaining
accepted tasks are still dependency-blocked. It never authorizes restore,
reattach, retry, or a claim that the whole run succeeded.
"""
from __future__ import annotations

import hashlib
import json
import os
import pathlib
import re
import stat
import types

from docker_build_control import BuildControlError, docker_capture

SCHEMA = "fullmag.prelaunch-failure-stop-capture.v1"
PREFLIGHT_SCHEMA = "fullmag.prelaunch-failure-stop-preflight.v1"
QUIESCE_SCHEMA = "fullmag.prelaunch-failure-api-quiescence.v1"
QUIESCE_INTENT_SCHEMA = "fullmag.prelaunch-failure-api-quiescence-intent.v1"
QUIESCE_CAUSE = "Fullmag API exited unexpectedly (-15)"
MAX_BYTES = 8 * 1024 * 1024
MAX_CAPTURE_BYTES = 24 * 1024 * 1024
CONFIG_PATH = "runtime-control/runtime-service/docker-all.json"
PROCESS_PATH = "runtime-control/runtime-service/process-tree.json"
POSTDRAIN_SCHEMA = "fullmag.prelaunch-failure-postdrain-store-check.v1"
SOURCE_BINDING_SCHEMA = "fullmag.prelaunch-failure-source-binding.v1"
SOURCE_FILE_NAMES = {
    "launcher": "docker_dev.py",
    "controller": "docker_volume_dev.py",
    "recovery_helper": "docker_volume_prelaunch_failure_stop.py",
}
MAX_SOURCE_FILE_BYTES = 2 * 1024 * 1024


def require(condition: bool, message: str) -> None:
    if not condition:
        raise BuildControlError("Prelaunch failure stop: " + message)


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def canonical(value: object) -> bytes:
    try:
        return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                          allow_nan=False).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise BuildControlError("Prelaunch failure stop: value is not canonical JSON") from error


def _read_pinned_source(path_value: object, expected_name: str) -> dict:
    require(isinstance(path_value, (str, os.PathLike)), "controller source path is malformed")
    supplied = pathlib.Path(path_value)
    try:
        if supplied.is_symlink():
            raise BuildControlError("Prelaunch failure stop: controller source path is a symlink")
        path = supplied.resolve(strict=True)
        if path.name != expected_name:
            raise BuildControlError("Prelaunch failure stop: controller source filename differs")
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(str(path), flags)
        try:
            before = os.fstat(descriptor)
            require(stat.S_ISREG(before.st_mode) and 0 < before.st_size <= MAX_SOURCE_FILE_BYTES,
                    "controller source is not a bounded regular file")
            chunks = []
            total = 0
            while True:
                chunk = os.read(descriptor, min(65536, MAX_SOURCE_FILE_BYTES + 1 - total))
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
                require(total <= MAX_SOURCE_FILE_BYTES, "controller source exceeds the size bound")
            after = os.fstat(descriptor)
            require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
                    == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
                    and total == after.st_size,
                    "controller source changed while it was pinned")
        finally:
            os.close(descriptor)
    except BuildControlError:
        raise
    except (OSError, RuntimeError, ValueError) as error:
        raise BuildControlError("Prelaunch failure stop: controller source cannot be pinned") from error
    raw = b"".join(chunks)
    return {"name": expected_name, "path": str(path), "size_bytes": len(raw), "sha256": sha(raw)}


def validate_source_binding(value: object) -> dict:
    require(isinstance(value, dict) and set(value) == {"schema", "files"}
            and value.get("schema") == SOURCE_BINDING_SCHEMA
            and isinstance(value.get("files"), list)
            and len(value["files"]) == len(SOURCE_FILE_NAMES),
            "controller source binding is malformed")
    expected_names = list(SOURCE_FILE_NAMES.values())
    seen_paths = set()
    source_directories = set()
    for item, expected_name in zip(value["files"], expected_names):
        require(isinstance(item, dict) and set(item) == {"name", "path", "size_bytes", "sha256"}
                and item.get("name") == expected_name
                and isinstance(item.get("path"), str)
                and pathlib.Path(item["path"]).is_absolute()
                and str(pathlib.Path(item["path"])) == item["path"]
                and pathlib.Path(item["path"]).name == expected_name
                and type(item.get("size_bytes")) is int
                and 0 < item["size_bytes"] <= MAX_SOURCE_FILE_BYTES,
                "controller source binding entry is malformed")
        digest(item.get("sha256"), "controller source file SHA-256")
        require(item["path"] not in seen_paths, "controller source binding paths are duplicated")
        seen_paths.add(item["path"])
        source_directories.add(str(pathlib.Path(item["path"]).parent))
    require(len(source_directories) == 1, "controller source files do not share one scripts directory")
    return value


def capture_source_binding(paths: object) -> dict:
    require(isinstance(paths, dict) and set(paths) == set(SOURCE_FILE_NAMES),
            "controller source paths are incomplete")
    binding = {"schema": SOURCE_BINDING_SCHEMA,
               "files": [_read_pinned_source(paths[name], filename)
                         for name, filename in SOURCE_FILE_NAMES.items()]}
    return validate_source_binding(binding)


def assert_source_binding_current(binding: object) -> dict:
    binding = validate_source_binding(binding)
    paths = {name: item["path"] for name, item in zip(SOURCE_FILE_NAMES, binding["files"])}
    current = capture_source_binding(paths)
    require(current == binding, "pinned controller source changed during prelaunch preservation")
    return binding


def validate_source_binding_chain(operation_inputs: object, intent: object, captured: object) -> dict:
    require(isinstance(operation_inputs, dict) and isinstance(intent, dict) and isinstance(captured, dict),
            "source binding chain is incomplete")
    binding = validate_source_binding(operation_inputs.get("prelaunch_failure_source_binding"))
    require(intent.get("source_binding") == binding and captured.get("source_binding") == binding,
            "operation, durable intent and capture use different controller source")
    return binding


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def decode(raw: bytes | str) -> dict:
    try:
        value = json.loads(raw, object_pairs_hook=_pairs, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        raise BuildControlError("Prelaunch failure stop: malformed bounded JSON") from error
    require(isinstance(value, dict), "bounded JSON document is not an object")
    return value


def digest(value: object, label: str = "SHA-256") -> str:
    require(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None,
            label + " is malformed")
    return value


def portable(value: object, label: str = "identity") -> str:
    require(isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}", value) is not None,
            label + " is malformed")
    return value


def _identity(value: object) -> dict:
    require(isinstance(value, dict), "native owner identity is missing")
    from docker_volume_terminal_observation import owner_identity
    try:
        return owner_identity(value)
    except (TypeError, ValueError, KeyError) as error:
        raise BuildControlError("Prelaunch failure stop: native owner identity is malformed") from error


def validate_options(args, *, recreate_services, restart_idle_service, stop_after_drain,
                     resume_recreation_id=None, refresh_frontend_service=False, retire_only=False):
    capture = getattr(args, "capture_prelaunch_failure", False)
    require(type(capture) is bool, "capture flag must be boolean")
    stop, stop_sha = (getattr(args, key, None) for key in (
        "prelaunch_failure_stop", "prelaunch_failure_stop_sha256"))
    require(bool(stop) == bool(stop_sha), "fresh-state requires paired exact stop pins")

    if capture:
        require(restart_idle_service and stop_after_drain and not recreate_services
                and getattr(args, "quiesce_api", False) is True
                and not any(getattr(args, key, None) for key in (
                    "capture_native_terminal", "capture_terminal_observation", "saved_authoring_checkpoint",
                    "saved_authoring_checkpoint_sha256", "allow_prepared_session", "prelaunch_failure_stop",
                    "prelaunch_failure_stop_sha256", "script", "restart_backend", "pending_activation"))
                and resume_recreation_id is None and not refresh_frontend_service and not retire_only,
                "capture requires stop-only plus API quiescence and cannot combine with other recovery modes")

    if stop:
        require(isinstance(stop, str) and re.fullmatch(r"[0-9a-f]{32}", stop) is not None,
                "stop attempt must be a canonical operation id")
        digest(stop_sha, "stop receipt SHA-256")
        require(recreate_services and getattr(args, "fresh_state", False) is True
                and not restart_idle_service and not stop_after_drain and resume_recreation_id is None
                and not refresh_frontend_service and not retire_only
                and not any(getattr(args, key, None) for key in (
                    "script", "native_terminal_stop", "native_terminal_stop_sha256",
                    "terminal_observation_stop", "terminal_observation_proof",
                    "terminal_observation_proof_sha256", "empty_api_abort_stop",
                    "empty_api_abort_stop_sha256", "recovery_authorization",
                    "completed_recreation_attempt", "completed_recreation_sha256",
                    "drained_successor_proof", "drained_successor_proof_sha256", "lost_state_stop",
                    "offline_reconciliation", "pending_activation", "restart_backend")),
                "prelaunch stop authorizes only exact fresh-state archival")
    return capture, (stop, stop_sha) if stop else None


def snapshot_binding(snapshot: object) -> dict:
    require(isinstance(snapshot, dict), "API snapshot is unavailable")
    status, run = snapshot.get("status", {}), snapshot.get("run", {})
    session, resources, scene = status.get("session", {}), status.get("resources", {}), snapshot.get("scene", {})
    api = snapshot.get("api_instance_id")
    require(isinstance(api, str) and re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", api),
            "API instance identity differs")
    session_id, run_id = portable(session.get("session_id"), "session id"), portable(run.get("run_id"), "run id")
    require(status.get("run", {}).get("run_id") == run_id and run.get("session_id") == session_id
            and run.get("status") == "waiting_for_compute"
            and status.get("solver", {}).get("state") == "waiting_for_compute",
            "public run is not the pinned prelaunch waiting run")
    started = run.get("started_at")
    require(isinstance(started, str) and started.isdigit() and int(started) > 0
            and session.get("session_epoch") == f"{session_id}@{started}", "session epoch differs")
    request_epoch = session.get("request_scope_epoch")
    require(isinstance(request_epoch, str) and request_epoch.startswith(api + ":")
            and request_epoch[len(api) + 1:].isdigit(), "request scope differs")
    require(type(resources.get("scene_revision")) is int and resources["scene_revision"] >= 0
            and type(scene.get("revision")) is int and scene["revision"] == resources["scene_revision"],
            "canonical scene revision differs")
    require(type(resources.get("mesh_revision")) is int and resources["mesh_revision"] >= 0
            and isinstance(resources.get("domain_generation_id"), str)
            and resources["domain_generation_id"], "mesh/domain revision is unavailable")
    queue = snapshot.get("queue", {})
    queue_items = queue.get("items")
    require(queue.get("schema_version") == "compute_queue.v1"
            and isinstance(queue.get("revision"), str)
            and re.fullmatch(r"sha256:[0-9a-f]{64}", queue["revision"]) is not None
            and isinstance(queue_items, list) and len(queue_items) == 2
            and queue.get("next_cursor") is None, "compute queue page is incomplete or paginated")
    queue_tasks = []
    for item in queue_items:
        require(isinstance(item, dict) and item.get("run_id") == run_id
                and item.get("state") == "accepted" and item.get("attempt_id") is None
                and item.get("ownership_epoch") is None and item.get("resource_id") is None
                and isinstance(item.get("task_id"), str),
                "compute queue contains another run or a claimed task")
        queue_tasks.append(item["task_id"])
    require(len(set(queue_tasks)) == 2, "compute queue has duplicate task identities")
    commands = snapshot.get("commands", {})
    entries = commands.get("commands")
    require(isinstance(entries, list) and type(commands.get("revision")) is int and commands["revision"] >= 0,
            "command ledger is unavailable")
    counts = {key: commands.get(key + "_count") for key in
              ("pending", "accepted", "dispatched", "running", "completed", "rejected", "failed")}
    require(all(type(value) is int and value >= 0 for value in counts.values())
            and all(counts[key] == 0 for key in ("pending", "accepted", "dispatched", "running")),
            "active API commands remain")
    require(entries == [] and all(value == 0 for value in counts.values()),
            "session command ledger is not empty")
    runtime, health = snapshot.get("runtime", {}), snapshot.get("health", {})
    require(runtime.get("schema_version") == "application_service_status.v1"
            and runtime.get("configured") is True and runtime.get("state") == "ready",
            "native runtime owner is not Ready")
    require(health.get("status") == "ok" and health.get("active_session") is True,
            "backend health/session differs")
    return {"schema": PREFLIGHT_SCHEMA, "api_instance_id": api, "session_id": session_id,
            "session_epoch": session["session_epoch"], "request_scope_epoch": request_epoch,
            "run_id": run_id, "public_run": run, "resources": resources,
            "scene_sha256": sha(canonical(scene)), "scene_revision": resources["scene_revision"],
            "queue_sha256": sha(canonical(queue)), "commands_sha256": sha(canonical(commands)),
            "runtime_sha256": sha(canonical(runtime)), "health": {"status": "ok", "active_session": True}}


def _task_id(run_id: str, step_id: str) -> str:
    return "task-" + sha((run_id + "\0" + step_id).encode("utf-8"))


def _transitive_dependencies(steps: list[dict]) -> dict[str, set[str]]:
    by_id = {}
    for step in steps:
        require(isinstance(step, dict), "Study plan step is malformed")
        step_id = portable(step.get("step_id"), "Study step id")
        require(step_id not in by_id, "Study plan contains duplicate step IDs")
        deps = step.get("completion_dependencies")
        require(isinstance(deps, list) and all(isinstance(dep, str) for dep in deps)
                and len(set(deps)) == len(deps), "Study dependency list is malformed")
        by_id[step_id] = step
    direct = {key: set(value["completion_dependencies"]) for key, value in by_id.items()}
    require(all(dep in by_id and dep != step for step, deps in direct.items() for dep in deps),
            "Study plan dependency references an unknown or self step")
    result = {}
    visiting = set()

    def ancestors(step):
        if step in result:
            return result[step]
        require(step not in visiting, "Study plan dependency graph contains a cycle")
        visiting.add(step)
        found = set(direct[step])
        for dependency in tuple(direct[step]):
            found.update(ancestors(dependency))
        visiting.remove(step)
        result[step] = found
        return found

    for step in by_id:
        ancestors(step)
    return result


def _validate_record_inventory(run_id: str, task_ids: list[str], failed_task_id: str,
                               attempt_id: str, epoch: int, resource_id: str,
                               plan_sha256: str, catalog_sha256: str, hashes: object) -> dict:
    require(isinstance(hashes, dict) and hashes, "store record hash inventory is missing")
    require(all(isinstance(path, str) and isinstance(value, str)
                and re.fullmatch(r"[0-9a-f]{64}", value) for path, value in hashes.items()),
            "store record hash inventory is malformed")
    root = "runs/" + run_id
    attempt_root = (f"{root}/worker-attempts/{failed_task_id}/{attempt_id}/epoch-{epoch}")
    inbox_id = sha(canonical([run_id, failed_task_id, attempt_id, epoch]))
    required = {
        f"{root}/run_intent.json", f"{root}/run_catalog.json", f"{root}/start_release.json",
        f"{root}/worker_inbox/{inbox_id}.json",
        f"{attempt_root}/worker_execution_started.v1.json",
        f"{attempt_root}/worker_prelaunch_failed.v1.json",
        f"{root}/preparation_receipt.json",
        f"{root}/accepted_stage_preparation_receipts/{failed_task_id}.json",
        f"{root}/task_admissions/{failed_task_id}/{attempt_id}.json",
    }
    required.update(f"{root}/task_preparation_receipts/{task_id}.json" for task_id in task_ids)
    run_paths = {path for path in hashes if path.startswith(root + "/")}
    exit_paths = {path for path in run_paths if re.fullmatch(
        re.escape(root) + r"/worker_process_exit_receipts/worker-process-exit-[0-9a-f]{64}\.json", path)}
    lease_paths = {path for path in run_paths if re.fullmatch(
        re.escape(root) + r"/resource_leases/[A-Za-z0-9][A-Za-z0-9._-]{0,199}/lease-[0-9a-f]{32}\.json", path)}
    require(len(exit_paths) == len(lease_paths) == 1, "worker exit or local lease path inventory differs")
    required.update(exit_paths | lease_paths)
    journal_root = f"{root}/coordinator_journal"
    command_paths = {path for path in run_paths if path.startswith(journal_root + "/command/")}
    event_paths = {path for path in run_paths if path.startswith(journal_root + "/event/")}
    require(1 <= len(command_paths) <= 32 and all(re.fullmatch(
        re.escape(journal_root) + r"/command/command-[0-9a-f]{32}\.json", path) for path in command_paths),
        "coordinator command journal inventory differs")
    require(1 <= len(event_paths) <= 64 and all(re.fullmatch(
        re.escape(journal_root) + r"/event/(?:[0-9a-f]{32}|event-prepared-[0-9a-f]{64})\.json", path)
        for path in event_paths), "coordinator event journal inventory differs")
    required.update(command_paths | event_paths)
    required.update({"objects/sha256/" + plan_sha256, "objects/sha256/" + catalog_sha256})
    require(set(hashes) == required, "run contains unknown records or lacks required preserved metadata")
    return dict(sorted(hashes.items()))


def _validate_resource_budget(value: object, label: str) -> dict:
    require(isinstance(value, dict) and all(type(value.get(key)) is int and value[key] >= 0
            for key in ("cpu_millis", "memory_bytes", "gpu_memory_bytes", "storage_bytes"))
            and any(value[key] > 0 for key in ("cpu_millis", "memory_bytes", "gpu_memory_bytes", "storage_bytes")),
            label + " is malformed")
    return value


def _validate_host_policy(value: object, label: str) -> dict:
    require(isinstance(value, dict) and value.get("schema_version") == "host_resource_ledger_policy.v3"
            and isinstance(value.get("host_id"), str) and value["host_id"]
            and type(value.get("revision")) is int and value["revision"] > 0
            and type(value.get("owner_epoch")) is int and value["owner_epoch"] > 0
            and digest(value.get("topology_sha256"), "host topology SHA-256"),
            label + " identity/schema is unsupported")
    budget = _validate_resource_budget(value.get("total_budget"), label + " total budget")
    require(budget["cpu_millis"] > 0 and budget["memory_bytes"] > 0
            and budget["gpu_memory_bytes"] == 0
            and isinstance(value.get("allowed_cpu_ids", []), list)
            and all(type(cpu_id) is int and cpu_id >= 0 for cpu_id in value.get("allowed_cpu_ids", []))
            and isinstance(value.get("gpu_vram_bytes_by_uuid", {}), dict)
            and not value.get("gpu_vram_bytes_by_uuid", {}),
            label + " is not the recorded CPU-only policy")
    return value


def _validate_worker_inbox(inbox: object, identity: dict, claim: dict, released_heartbeat: int) -> None:
    require(isinstance(inbox, dict) and set(inbox) == {"payload_sha256", "payload"}
            and inbox.get("payload_sha256") == sha(canonical(inbox.get("payload"))),
            "worker inbox record digest differs")
    payload = inbox.get("payload")
    identity_claim = {key: claim[key] for key in ("run_id", "task_id", "attempt_id", "ownership_epoch")}
    identity_claim["lease_token"] = claim["lease"]["lease_token"]
    require(isinstance(payload, dict) and set(payload) == {"schema_version", "claim", "applied", "pending"}
            and payload.get("schema_version") == "worker_inbox.v1"
            and payload.get("claim") == identity_claim and payload.get("pending") is None
            and isinstance(payload.get("applied"), list),
            "worker inbox checkpoint claim/schema is not the exact flat ClaimIdentity")
    require(set(payload["claim"]) == {"run_id", "task_id", "attempt_id", "ownership_epoch", "lease_token"},
            "worker inbox claim has unknown or missing fields")
    applied = payload["applied"]
    require(2 <= len(applied) <= 128 and all(isinstance(item, dict) for item in applied),
            "worker inbox applied history is outside its bound")
    ids, heartbeats, starts = set(), [], []
    for expected_sequence, envelope in enumerate(applied, 1):
        require(set(envelope) == {"schema_version", "message_id", "sequence", "claim", "command"}
                and envelope.get("schema_version") == "worker_protocol.v3"
                and type(envelope.get("sequence")) is int and envelope.get("sequence") == expected_sequence
                and isinstance(envelope.get("message_id"), str) and envelope["message_id"]
                and envelope["message_id"] not in ids and envelope.get("claim") == identity_claim
                and isinstance(envelope.get("command"), dict),
                "worker inbox command stream is noncanonical or crossed")
        require(set(envelope["claim"]) == {"run_id", "task_id", "attempt_id", "ownership_epoch", "lease_token"},
                "worker envelope claim has unknown or missing fields")
        ids.add(envelope["message_id"])
        command = envelope["command"]
        kind = command.get("kind")
        if expected_sequence == 1:
            resolved = command.get("resolved_input")
            required_resolved = {"schema_version", "run_id", "task_id", "attempt_id", "ownership_epoch",
                                 "specification_fingerprint", "plan_fingerprint", "requested_execution",
                                 "preparation", "inputs"}
            require(set(command) == {"kind", "resolved_input"} and kind == "prepare"
                    and isinstance(resolved, dict) and required_resolved.issubset(resolved)
                    and set(resolved).issubset(required_resolved | {"frozen_stage_context"})
                    and resolved.get("schema_version") in {"resolved_task_input.v2", "resolved_task_input.v3"}
                    and resolved.get("run_id") == identity_claim["run_id"]
                    and resolved.get("task_id") == identity_claim["task_id"]
                    and resolved.get("attempt_id") == identity_claim["attempt_id"]
                    and resolved.get("ownership_epoch") == identity_claim["ownership_epoch"],
                    "worker inbox does not begin with the exact applied Prepare")
        elif kind == "start":
            require(command == {"kind": "start"}, "worker Start command schema differs")
            starts.append(envelope)
        elif kind == "heartbeat":
            require(set(command) == {"kind", "lease_heartbeat_sequence"}, "worker Heartbeat command schema differs")
            sequence = command.get("lease_heartbeat_sequence")
            require(type(sequence) is int and 0 < sequence <= released_heartbeat,
                    "worker inbox heartbeat does not fit the released lease")
            heartbeats.append(sequence)
        else:
            require(False, "worker inbox contains an unexpected Stop/Release/control command")
    require(len(starts) == 1 and starts[0].get("sequence") == identity.get("start_sequence")
            and starts[0].get("message_id") == identity.get("start_message_id")
            and starts[0].get("sequence") == 2
            and all(item.get("sequence", 0) > starts[0]["sequence"] for item in applied[2:])
            and all(left < right for left, right in zip(heartbeats, heartbeats[1:])),
            "worker inbox does not contain exactly the receipt-bound Prepare→Start→Heartbeat history")


def _expected_run_directories(run_id: str, file_paths: set[str]) -> set[str]:
    root = pathlib.PurePosixPath("runs/" + run_id)
    result: set[str] = set()
    for path in file_paths:
        if not path.startswith(str(root) + "/"):
            continue
        for parent in pathlib.PurePosixPath(path).parents:
            if parent == root:
                break
            if str(parent).startswith(str(root) + "/"):
                result.add(str(parent))
    return result


def validate_store_evidence(evidence: object) -> dict:
    """Validate a lock-protected raw evidence snapshot and return secret-free pins."""
    require(isinstance(evidence, dict) and evidence.get("schema") ==
            "fullmag.prelaunch-failure-locked-evidence.v1" and evidence.get("locked") is True
            and evidence.get("lock_order") == ["host-ledger", "session-store"],
            "locked ledger/store evidence is missing")
    run_id = portable(evidence.get("run_id"), "run id")
    store_id = evidence.get("store_id")
    require(isinstance(store_id, str) and re.fullmatch(r"sha256:[0-9a-f]{64}", store_id),
            "Linux-native session store identity differs")
    intent, catalog = evidence.get("run_intent"), evidence.get("run_catalog")
    release, plan = evidence.get("start_release"), evidence.get("study_plan")
    require(isinstance(intent, dict) and intent.get("schema_version") == "run_intent.v1"
            and intent.get("run_id") == run_id, "RunIntent identity differs")
    spec = intent.get("specification")
    require(isinstance(spec, dict) and spec.get("run_id") == run_id
            and intent.get("payload_sha256") == sha(canonical(spec)), "accepted run specification pin differs")
    project_id = portable(spec.get("snapshot", {}).get("project_id"), "accepted project id")
    study_ref, catalog_ref = intent.get("study_object_ref"), intent.get("study_catalog_object_ref")
    study_spec, catalog_spec = spec.get("study", {}), spec.get("study_catalog_sha256")
    study_sha, catalog_sha = (digest(study_ref, "Study plan CAS reference"),
                              digest(catalog_ref, "Study catalog CAS reference"))
    require(study_spec.get("plan_sha256") == study_sha and catalog_spec == catalog_sha
            and evidence.get("study_plan_raw_sha256") == study_sha
            and evidence.get("study_catalog_raw_sha256") == catalog_sha
            and evidence.get("study_catalog_present") is True,
            "accepted immutable Study plan/catalog CAS differs")
    require(isinstance(plan, dict) and plan.get("schema_version") == "study_plan.v3"
            and isinstance(plan.get("steps"), list) and len(plan["steps"]) >= 2,
            "accepted Study plan is unavailable")
    release_sha = digest(evidence.get("start_release_raw_sha256"), "Start release record SHA-256")
    require(isinstance(release, dict)
            and release.get("schema_version") == "accepted_run_start_release.v1"
            and release.get("run_id") == run_id and release.get("specification_sha256") == intent["payload_sha256"]
            and release_sha == evidence.get("start_release_raw_sha256"), "shared accepted Start release differs")
    require(isinstance(catalog, dict) and catalog.get("schema_version") == "run_catalog.v1"
            and catalog.get("run_id") == run_id and type(catalog.get("revision")) is int
            and catalog["revision"] > 0 and isinstance(catalog.get("tasks"), list),
            "run catalog identity differs")
    steps = plan["steps"]
    ancestors = _transitive_dependencies(steps)
    step_ids = [step["step_id"] for step in steps]
    require(all(step.get("enabled") is True and step.get("kind", {}).get("kind") == "primitive"
                and step["kind"].get("stage_kind") == "relax" for step in steps),
            "Study plan is outside the bounded primitive-relax recovery scope")
    tasks = catalog["tasks"]
    by_task = {task.get("task_id"): task for task in tasks if isinstance(task, dict)}
    require(len(by_task) == len(tasks) == len(steps), "run catalog task count/identity differs from accepted Study")
    by_step = {}
    for step_id in step_ids:
        task_key = _task_id(run_id, step_id)
        task = by_task.get(task_key)
        require(isinstance(task, dict) and digest(task.get("input_fingerprint"), "task input fingerprint"),
                "canonical Study task ID or input fingerprint differs")
        by_step[step_id] = task
    failed = [step for step in step_ids if by_step[step].get("lifecycle") == "failed"]
    require(len(failed) == 1, "there is not exactly one failed Study task")
    failed_step = failed[0]
    failed_task = by_step[failed_step]
    attempt_id = portable(failed_task.get("attempt_id"), "failed task attempt id")
    epoch = failed_task.get("ownership_epoch")
    resource = portable(failed_task.get("resource_id"), "failed task resource id")
    require(type(epoch) is int and epoch > 0 and failed_task.get("readiness", {}).get("state") == "ready"
            and failed_task.get("observation") in {None, "disconnected"}
            and failed_task.get("artifact_ids") == [], "failed task catalog ownership differs")
    blocked_steps = [step for step in step_ids if step != failed_step]
    require(bool(blocked_steps) and all(by_step[step].get("lifecycle") == "accepted"
            and by_step[step].get("readiness", {}).get("state") == "blocked"
            and failed_step in ancestors[step] for step in blocked_steps),
            "remaining accepted tasks are not blocked by the failed Study dependency")
    for step in blocked_steps:
        task = by_step[step]
        require(task.get("attempt_id") is None and task.get("ownership_epoch") is None
                and task.get("resolved_input_fingerprint") is None and task.get("observation") is None
                and task.get("resource_id") is None and task.get("artifact_ids") == []
                and task.get("coordinator_watermark") is None and task.get("coordinator_genesis") is None,
                "a dependency-blocked task has been claimed or produced output")
    require(evidence.get("other_task_attempts_absent") is True
            and evidence.get("preparation_leases") == [] and evidence.get("artifact_catalog") is None
            and evidence.get("no_live_sidecars") is True and evidence.get("other_runs_terminal") is True,
            "store contains another attempt, preparation, artifact, sidecar, or active run")
    leases = evidence.get("leases")
    exits = evidence.get("worker_exit_receipts")
    attempts = evidence.get("attempts")
    require(isinstance(leases, list) and len(leases) == 1 and isinstance(exits, list) and len(exits) == 1
            and isinstance(attempts, dict), "failed task release/attempt inventory is incomplete")
    lease, exit_receipt = leases[0], exits[0]
    portable(lease.get("resource_id"), "failed task resource id")
    portable(lease.get("lease_token"), "failed task lease token")
    require(lease.get("schema_version") == "resource_lease.v1" and lease.get("state") == "released"
            and lease.get("run_id") == run_id and lease.get("task_id") == failed_task["task_id"]
            and lease.get("attempt_id") == attempt_id and lease.get("ownership_epoch") == epoch
            and lease.get("resource_id") == resource and lease.get("kind") in {"cpu", "gpu", "storage", "meshing"}
            and isinstance(lease.get("lease_token"), str)
            and lease["lease_token"] and type(lease.get("heartbeat_sequence")) is int
            and lease["heartbeat_sequence"] >= 0 and isinstance(lease.get("released_at"), str)
            and all(isinstance(lease.get(key), str) and lease[key]
                    for key in ("acquired_at", "heartbeat_at", "released_at")),
            "failed task local lease is not exactly Released")
    _validate_resource_budget(lease.get("budget"), "failed task lease budget")
    launch_binding = lease.get("host_launch_binding")
    require(isinstance(launch_binding, dict)
            and launch_binding.get("schema_version") == "host_launch_binding.v1"
            and isinstance(launch_binding.get("ledger_root"), str)
            and launch_binding["ledger_root"].startswith("/")
            and ".." not in pathlib.PurePosixPath(launch_binding["ledger_root"]).parts,
            "failed task lease host launch binding differs")
    _validate_host_policy(launch_binding.get("policy"), "lease-bound host policy")
    require(exit_receipt.get("schema_version") == "worker_process_exit_receipt.v1"
            and exit_receipt.get("run_id") == run_id and exit_receipt.get("task_id") == failed_task["task_id"]
            and exit_receipt.get("attempt_id") == attempt_id and exit_receipt.get("ownership_epoch") == epoch
            and exit_receipt.get("resource_id") == resource and exit_receipt.get("lease_token") == lease["lease_token"]
            and exit_receipt.get("lease_heartbeat_sequence") == lease.get("heartbeat_sequence")
            and exit_receipt.get("status_success") is False and type(exit_receipt.get("exit_code")) is int
            and exit_receipt["exit_code"] != 0 and exit_receipt.get("timed_out") is False
            and exit_receipt.get("stop_requested") is False and type(exit_receipt.get("process_id")) is int
            and exit_receipt["process_id"] > 0 and isinstance(exit_receipt.get("receipt_id"), str)
            and exit_receipt["receipt_id"] and isinstance(exit_receipt.get("failure_reason"), str)
            and exit_receipt["failure_reason"].strip() and len(exit_receipt["failure_reason"]) <= 4096
            and isinstance(exit_receipt.get("observed_at"), str),
            "worker process exit is not a natural failed exit")
    if exit_receipt.get("process_start_token") is not None:
        require(isinstance(exit_receipt.get("process_start_token"), str)
                and exit_receipt["process_start_token"].strip()
                and len(exit_receipt["process_start_token"]) <= 256,
                "worker exit process start token is malformed")
    record_hashes = evidence.get("record_sha256")
    require(isinstance(record_hashes, dict)
            and f"runs/{run_id}/resource_leases/{resource}/{lease['lease_token']}.json" in record_hashes,
            "local lease file path differs from its immutable resource/token identity")
    require(isinstance(record_hashes, dict) and any(
        path.endswith("/worker_process_exit_receipts/" + exit_receipt["receipt_id"] + ".json")
        for path in record_hashes if isinstance(path, str)),
        "worker exit receipt path differs from its immutable receipt id")
    attempt = attempts.get(failed_task["task_id"])
    files = attempt.get("files") if isinstance(attempt, dict) else None
    started, prelaunch = files.get("worker_execution_started.v1.json"), files.get("worker_prelaunch_failed.v1.json")
    identity = started.get("identity") if isinstance(started, dict) else None
    claim = identity.get("claim") if isinstance(identity, dict) else None
    claim_lease = claim.get("lease") if isinstance(claim, dict) else None
    require(isinstance(identity, dict) and identity.get("schema_version") == "fullmag.accepted_worker_execution.v1"
            and isinstance(claim, dict) and claim.get("run_id") == run_id
            and claim.get("task_id") == failed_task["task_id"] and claim.get("attempt_id") == attempt_id
            and claim.get("ownership_epoch") == epoch
            and isinstance(claim_lease, dict) and claim_lease.get("resource_id") == resource
            and claim_lease.get("kind") == lease.get("kind") and claim_lease.get("budget") == lease.get("budget")
            and claim_lease.get("lease_token") == lease["lease_token"]
            and type(claim_lease.get("heartbeat_sequence")) is int and claim_lease["heartbeat_sequence"] >= 0
            and claim_lease["heartbeat_sequence"] <= lease["heartbeat_sequence"]
            and isinstance(identity.get("start_message_id"), str) and identity.get("start_message_id")
            and type(identity.get("start_sequence")) is int and identity["start_sequence"] > 0
            and digest(identity.get("plan_fingerprint"), "worker plan fingerprint"),
            "durable Started receipt does not match the failed claim")
    require(isinstance(prelaunch, dict) and prelaunch.get("identity") == identity
            and isinstance(prelaunch.get("error"), str) and prelaunch["error"].strip(),
            "prelaunch-failed receipt does not match durable Started")
    inbox = attempt.get("worker_inbox")
    _validate_worker_inbox(inbox, identity, claim, lease["heartbeat_sequence"])

    ledger = evidence.get("host_ledger")
    require(isinstance(ledger, dict) and ledger.get("schema_version") == "host_resource_ledger.v4",
            "host resource ledger is unavailable")
    policy = _validate_host_policy(ledger.get("policy"), "host ledger policy")
    host_id = policy["host_id"]
    rows = ledger.get("reservations")
    require(isinstance(rows, list) and all(isinstance(row, dict) for row in rows),
            "host reservation inventory is malformed")
    same_store = [row for row in rows if row.get("identity", {}).get("store_id") == store_id]
    require(all(row.get("state") == "released" for row in same_store),
            "an active or unknown host reservation remains for this store")
    reservation_hashes = sorted(sha(canonical(row)) for row in same_store)
    matching = [row for row in same_store if row.get("identity", {}).get("run_id") == run_id
                and row.get("identity", {}).get("task_id") == failed_task["task_id"]
                and row.get("identity", {}).get("resource_id") == resource
                and row.get("identity", {}).get("lease_token") == lease["lease_token"]]
    require(len(matching) == 1, "failed task has no unique matching host reservation")
    row = matching[0]
    expected_owner = {"kind": "solver", "attempt_id": attempt_id, "ownership_epoch": epoch}
    identity_fields = row.get("identity", {})
    require(identity_fields.get("owner") == expected_owner
            and digest(row.get("request_sha256"), "host reservation request SHA-256")
            and row.get("host_id") == host_id and row.get("policy_revision") == policy["revision"]
            and row.get("host_owner_epoch") == policy["owner_epoch"]
            and row.get("topology_sha256") == policy["topology_sha256"]
            and row.get("preparation_launch_gate") is None
            and row.get("preparation_launch_owner") is None
            and row.get("release_proof_sha256") and row.get("worker_launch_gate", {}).get("state") == "consumed"
            and isinstance(row["worker_launch_gate"].get("token"), str)
            and row["worker_launch_gate"]["token"], "host consumed Start reservation differs")
    proof_digest = digest(row.get("release_proof_sha256"), "host release proof SHA-256")
    proof = ledger.get("release_proofs", {}).get(proof_digest)
    proof_raw_sha = ledger.get("release_proof_raw_sha256", {}).get(proof_digest)
    require(isinstance(proof, dict) and digest(proof_raw_sha, "host release proof file SHA-256") == proof_digest
            and proof.get("schema_version") == "host_resource_release_proof.v1"
            and proof.get("kind") == "worker" and proof.get("host_id") == host_id
            and proof.get("store_id") == store_id and proof.get("request_sha256") == row.get("request_sha256")
            and proof.get("worker_receipt") == exit_receipt
            and proof.get("released_worker_lease") == lease,
            "host release proof does not authenticate the exact worker exit and Released lease")
    require(proof.get("preparation_receipt") is None and proof.get("released_preparation_lease") is None
            and proof.get("unadmitted_task") is None and proof.get("orphan_teardown") is None
            and proof.get("claimed_interruption") is None, "host release proof is not a direct worker release")

    target_paths = _validate_record_inventory(run_id, [by_step[step]["task_id"] for step in step_ids],
        failed_task["task_id"], attempt_id, epoch, resource, study_sha, catalog_sha,
        evidence.get("record_sha256"))
    other_runs = evidence.get("other_run_pins")
    require(isinstance(other_runs, list) and all(isinstance(item, dict)
            and isinstance(item.get("run_id"), str) and digest(item.get("run_intent_sha256"))
            and digest(item.get("run_catalog_sha256")) for item in other_runs),
            "other terminal run pins are malformed")
    return {"schema": "fullmag.prelaunch-failure-store-binding.v1", "run_id": run_id,
            "project_id": project_id,
            "store_id": store_id, "host_id": host_id, "failed_step_id": failed_step,
            "failed_task_id": failed_task["task_id"], "attempt_id": attempt_id, "ownership_epoch": epoch,
            "blocked_task_ids": [by_step[step]["task_id"] for step in blocked_steps],
            "plan_sha256": study_sha, "study_catalog_sha256": catalog_sha,
            "run_intent_sha256": digest(evidence.get("run_intent_raw_sha256")),
            "run_catalog_sha256": digest(evidence.get("run_catalog_raw_sha256")),
            "start_release_sha256": release_sha, "worker_started_sha256": digest(evidence.get("started_raw_sha256")),
            "worker_prelaunch_sha256": digest(evidence.get("prelaunch_raw_sha256")),
            "worker_inbox_sha256": digest(evidence.get("inbox_raw_sha256")),
            "worker_exit_sha256": digest(evidence.get("exit_raw_sha256")),
            "local_lease_sha256": digest(evidence.get("lease_raw_sha256")),
            "host_release_proof_sha256": proof_digest,
            "store_reservation_set_sha256": sha(canonical(reservation_hashes)),
            "plan_dependencies": {step: sorted(ancestors[step]) for step in step_ids},
            "task_input_fingerprints": {by_step[step]["task_id"]: by_step[step]["input_fingerprint"]
                                         for step in step_ids},
            "other_run_pins": sorted(other_runs, key=lambda item: item["run_id"]),
            "record_sha256": target_paths,
            "record_inventory_sha256": sha(canonical(target_paths))}


def snapshot_summary(snapshot: dict) -> dict:
    return snapshot_binding(snapshot)


def _store_binding_hash(binding: dict) -> str:
    return sha(canonical(binding))


def _locked_store_evidence_sha(evidence: dict) -> str:
    require(isinstance(evidence, dict), "locked store evidence is missing")
    stable = {key: value for key, value in evidence.items() if not key.startswith("runtime_")}
    return sha(canonical(stable))


def validate_capture(captured: object) -> dict:
    require(isinstance(captured, dict) and captured.get("schema") == SCHEMA,
            "capture schema differs")
    validate_source_binding(captured.get("source_binding"))
    preflight = captured.get("preflight")
    require(isinstance(preflight, dict) and preflight.get("schema") == PREFLIGHT_SCHEMA,
            "preflight pin is missing")
    api = preflight.get("api_instance_id")
    api_pin = captured.get("api_pin")
    require(isinstance(api_pin, dict) and api_pin.get("pid", 0) > 1
            and isinstance(api_pin.get("start_token"), str) and api_pin["start_token"]
            and type(api_pin.get("ppid")) is int and api_pin["ppid"] > 1
            and api_pin.get("argv") == ["/opt/fullmag/package/bin/fullmag-api"]
            and api_pin.get("exe") == "/opt/fullmag/package/bin/fullmag-api",
            "exact API process incarnation is missing")
    require(captured.get("api_quiescence", {}).get("schema") == QUIESCE_SCHEMA
            and captured["api_quiescence"].get("api_instance_id") == api
            and captured["api_quiescence"].get("api_pin") == api_pin
            and captured["api_quiescence"].get("api_closed") is True
            and captured["api_quiescence"].get("signal") == "SIGTERM"
            and captured["api_quiescence"].get("api_exit_code") == -15
            and captured["api_quiescence"].get("api_diagnostic_only") is False
            and captured["api_quiescence"].get("error") == QUIESCE_CAUSE,
            "API closure does not prove one exact graceful quiescence")
    owner_sha = digest(captured.get("ready_owner_sha256"), "Ready native owner SHA-256")
    binding = captured.get("store_binding")
    require(isinstance(binding, dict) and binding.get("schema") == "fullmag.prelaunch-failure-store-binding.v1"
            and binding.get("run_id") == preflight.get("run_id"), "failed-store authority differs from API run")
    require(captured["api_quiescence"].get("preflight_sha256") == sha(canonical(preflight))
            and captured["api_quiescence"].get("store_binding_sha256") == _store_binding_hash(binding)
            and captured["api_quiescence"].get("locked_evidence_sha256") == captured.get("locked_evidence_sha256")
            and captured["api_quiescence"].get("ready_owner_sha256") == owner_sha,
            "quiescence intent is not pinned to the captured state")
    digest(captured.get("native_config_sha256"), "native config SHA-256")
    digest(captured.get("process_sha256"), "API process receipt SHA-256")
    digest(captured["api_quiescence"].get("failure_process_sha256"), "API failure process receipt SHA-256")
    return captured


def validate_drain(captured: dict, process: dict) -> None:
    captured = validate_capture(captured)
    ready, terminal = process.get("service_owner", {}), process.get("terminal_service_owner", {})
    quiescence = captured["api_quiescence"]
    require(process.get("schema") == "fullmag.docker-process-tree.v1" and process.get("state") == "drained"
            and process.get("accepted_store") == "/state/runs/docker-all/session-store"
            and process.get("api_pid") == quiescence["api_pin"]["pid"]
            and process.get("api_exit_code") == -15 and process.get("api_diagnostic_only") is False
            and process.get("error") == QUIESCE_CAUSE,
            "native process drain does not match the exact API exit")
    require(ready.get("state") == "ready" and terminal.get("state") == "drained"
            and _identity(ready) == _identity(terminal)
            and sha(canonical(_identity(ready))) == captured["ready_owner_sha256"],
            "runtime owner did not complete Ready-to-Drained transition")
    children_ready = {item.get("role"): item.get("status") for item in ready.get("children", [])
                      if isinstance(item, dict)}
    children_terminal = {item.get("role"): item.get("status") for item in terminal.get("children", [])
                         if isinstance(item, dict)}
    require(children_ready.get("compute") == "running" and children_ready.get("preparation") == "running"
            and children_terminal.get("compute") == "exited_success"
            and children_terminal.get("preparation") == "exited_success",
            "worker/preparation schedulers or pools did not drain successfully")


def fresh_pin(args, *, recreate_services):
    stop, stop_sha = getattr(args, "prelaunch_failure_stop", None), getattr(args, "prelaunch_failure_stop_sha256", None)
    require(bool(stop) == bool(stop_sha), "fresh-state stop receipt requires both attempt and SHA-256")
    if not stop:
        return None
    require(recreate_services and getattr(args, "fresh_state", False) is True and getattr(args, "script", None) is None
            and not any(getattr(args, key, None) for key in (
                "native_terminal_stop", "native_terminal_stop_sha256", "terminal_observation_stop",
                "terminal_observation_proof", "terminal_observation_proof_sha256",
                "empty_api_abort_stop", "empty_api_abort_stop_sha256", "recovery_authorization",
                "offline_reconciliation", "pending_activation", "restart_backend",
                "completed_recreation_attempt", "completed_recreation_sha256", "drained_successor_proof",
                "drained_successor_proof_sha256", "lost_state_stop", "saved_authoring_checkpoint",
                "saved_authoring_checkpoint_sha256", "prepared_quarantine_sha256")),
            "prelaunch failure pin is supported only by fresh-state recreation")
    require(isinstance(stop, str) and re.fullmatch(r"[0-9a-f]{32}", stop), "invalid prelaunch stop attempt")
    require(stop != getattr(args, "attempt", None), "prelaunch stop and retained start attempts must be distinct")
    digest(stop_sha, "prelaunch stop receipt SHA-256")
    return stop, stop_sha


def validate_fresh(control, *, stop_attempt, stop_sha256, source_root, attempt, config_sha256,
                   actual, store_root):
    """Validate only exact offline archival; never confer old-store restore authority."""
    from docker_volume_accepted_reattach import _control_bytes
    require(isinstance(stop_attempt, str) and re.fullmatch(r"[0-9a-f]{32}", stop_attempt),
            "invalid stop attempt")
    digest(stop_sha256, "stop receipt SHA-256")
    root = "iteration/attempts/" + stop_attempt + "/"
    read = lambda relative: _control_bytes(control, relative, maximum=MAX_CAPTURE_BYTES)
    raw = read(root + "terminal.json")
    terminal = decode(raw)
    require(sha(raw) == stop_sha256 and read(root + "receipt.json") == raw
            and terminal.get("schema") == "fullmag.docker-build-operation.v1"
            and terminal.get("attempt") == stop_attempt and terminal.get("phase") == "iteration"
            and terminal.get("state") == "succeeded" and terminal.get("idle_backend_stopped") is True
            and terminal.get("compose_project") == control.project and terminal.get("control_volume") == control.volume
            and terminal.get("control_namespace", "") == getattr(control, "namespace", "")
            and terminal.get("namespace_registry_sha256") == getattr(control, "namespace_registry_sha256", None)
            and terminal.get("config_sha256") == config_sha256
            and terminal.get("inputs", {}).get("source_root") == source_root
            and terminal.get("inputs", {}).get("attempt") == attempt
            and terminal.get("inputs", {}).get("capture_prelaunch_failure") is True
            and terminal.get("inputs", {}).get("quiesce_api") is True,
            "stop operation belongs to another group/config or mode")
    intent_raw = read(root + "prelaunch-failure-quiescence-intent.json")
    intent = decode(intent_raw)
    require(sha(intent_raw) == terminal.get("api_quiescence_intent_sha256")
            and intent.get("schema") == QUIESCE_INTENT_SCHEMA,
            "durable quiescence intent is not pinned by the stop receipt")
    capture_raw = read(root + "prelaunch-failure-stop.json")
    captured = validate_capture(decode(capture_raw))
    source_binding = validate_source_binding_chain(terminal.get("inputs", {}), intent, captured)
    assert_source_binding_current(source_binding)
    require(sha(capture_raw) == terminal.get("prelaunch_failure_capture_sha256"),
            "prelaunch-failure capture is not pinned by the operation receipt")
    require(captured["preflight"].get("run_id") == captured["store_binding"].get("run_id"),
            "captured public run/store identity differs")
    require(sha(read(CONFIG_PATH)) == captured.get("native_config_sha256"), "native config changed after stop")
    drain = decode(read(root + "backend-drain.json"))
    process = drain.get("process_receipt", {})
    validate_drain(captured, process)
    require(drain.get("schema") == "fullmag.docker-idle-restart-drain.v1"
            and drain.get("backend_container_id") == terminal.get("backend_container")
            and drain.get("process_receipt_sha256") == sha(canonical(process) + b"\n")
            and decode(read(PROCESS_PATH)) == process,
            "current native process drain differs from the stop receipt")
    postdrain_raw = read(root + "prelaunch-failure-postdrain-lock.json")
    postdrain = decode(postdrain_raw)
    require(sha(postdrain_raw) == terminal.get("prelaunch_failure_postdrain_sha256")
            and postdrain.get("schema") == POSTDRAIN_SCHEMA
            and postdrain.get("run_id") == captured["store_binding"].get("run_id")
            and postdrain.get("store_id") == captured["store_binding"].get("store_id")
            and postdrain.get("store_binding_sha256") == _store_binding_hash(captured["store_binding"])
            and postdrain.get("locked_evidence_sha256") == captured.get("locked_evidence_sha256"),
            "post-drain locked record/release proof differs from the captured failed run")
    current_postdrain = verify_stopped_locked(
        actual["backend"].get("Id"), actual["backend"].get("Image"),
        captured["store_binding"]["run_id"], captured["store_binding"]["store_id"],
        captured["store_binding"],
    )
    require(current_postdrain == postdrain,
            "post-drain locked failed-run/host-release records changed after capture")
    stopped_raw = read(root + "idle-stop-containers.json")
    stopped = decode(stopped_raw)
    require(sha(stopped_raw) == terminal.get("idle_stop_containers_sha256")
            and set(stopped) == set(actual) == {"backend", "frontend"}, "stopped service set differs")
    for name, old in stopped.items():
        now = actual[name]
        require(old.get("Id") == terminal.get(name + "_container")
                and all(old.get(key) == now.get(key) for key in ("Id", "Image", "Config", "HostConfig", "Mounts"))
                and old.get("State", {}).get("StartedAt") == now.get("State", {}).get("StartedAt")
                and old.get("State", {}).get("Running") is False and now.get("State", {}).get("Running") is False,
                "service incarnation changed after the stop")
    require(stopped["backend"].get("State", {}).get("ExitCode") == 1
            and stopped["backend"].get("State", {}).get("OOMKilled") is False,
            "prelaunch quiesced backend exit differs from authenticated API SIGTERM")
    return {"schema": "fullmag.prelaunch-failure-stop-fresh-state.v1", "stop_attempt": stop_attempt,
            "stop_sha256": stop_sha256, "capture_sha256": sha(capture_raw),
            "source_binding_sha256": sha(canonical(source_binding)),
            "store_binding_sha256": _store_binding_hash(captured["store_binding"])}


# Fixed image-owned transport; inputs never become shell source. It reads only
# canonical store/ledger records under existing no-follow writer locks.
LOCKED_PROBE = r'''import base64,errno,fcntl,hashlib,json,os,pathlib,re,signal,socket,stat,sys,time,urllib.request
sys.path.insert(0,"/opt/fullmag")
import runtime_service as service
mode=sys.argv[1] if len(sys.argv)>1 else ""
if mode=="offline":
 class OfflinePaths: pass
 paths=OfflinePaths(); paths.state=pathlib.Path("/state"); paths.store=pathlib.Path("/state/runs/docker-all/session-store")
else:
 import entrypoint
 # Match the image entrypoint's explicit CPU ABI setup in this probe process only.
 # It appends the fixed image-owned CUDA compatibility directory without changing
 # the container configuration or enabling GPU access.
 entrypoint._configure_device_access()
 paths=service.canonical_paths()
MAX=8*1024*1024; MAX_FILES=4096; MAX_TOTAL=64*1024*1024
def unique(pairs):
 out={}
 for k,v in pairs:
  if k in out: raise RuntimeError("duplicate JSON key")
  out[k]=v
 return out
def canon(v): return json.dumps(v,sort_keys=True,separators=(",",":"),ensure_ascii=False,allow_nan=False).encode()
def sha(b): return hashlib.sha256(b).hexdigest()
def get(path,instance):
 headers={"Host":"localhost","Accept":"application/json"}
 if instance: headers["x-fullmag-api-instance"]=instance
 with urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:8081"+path,headers=headers),timeout=8) as r:
  ids=r.headers.get_all("x-fullmag-api-instance") or []
  if r.status!=200 or len(ids)!=1 or instance and ids[0]!=instance: raise RuntimeError("API identity changed")
  raw=r.read(MAX+1)
  if len(raw)>MAX: raise RuntimeError("API document exceeds bound")
 return json.loads(raw,object_pairs_hook=unique),ids[0]
def snapshot():
 instance=None; result={}
 for key,path in (("health","/v2/platform/health"),("status","/v2/sessions/current/status"),
  ("run","/v2/sessions/current/simulation/runs/current"),("scene","/v2/sessions/current/model/scene"),
  ("queue","/v2/platform/compute/queue"),("commands","/v2/sessions/current/simulation/commands"),
  ("runtime","/v2/platform/runtime-service")):
  result[key],instance=get(path,instance)
 result["api_instance_id"]=instance; return result
def api_binding(value):
 status,run=value["status"],value["run"]; session=status["session"]; resources=status["resources"]
 return {"schema":"fullmag.prelaunch-failure-stop-preflight.v1","api_instance_id":value["api_instance_id"],
  "session_id":session["session_id"],"session_epoch":session["session_epoch"],
  "request_scope_epoch":session["request_scope_epoch"],"run_id":run["run_id"],"public_run":run,
  "resources":resources,"scene_sha256":sha(canon(value["scene"])),"scene_revision":resources["scene_revision"],
  "queue_sha256":sha(canon(value["queue"])),"commands_sha256":sha(canon(value["commands"])),
  "runtime_sha256":sha(canon(value["runtime"])),"health":{"status":value["health"]["status"],
  "active_session":value["health"]["active_session"]}}
def open_child(parent,name,directory=False):
 flags=os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC|(getattr(os,"O_DIRECTORY",0) if directory else 0)
 fd=os.open(name,flags,dir_fd=parent)
 st=os.fstat(fd)
 if directory and not stat.S_ISDIR(st.st_mode) or not directory and not stat.S_ISREG(st.st_mode):
  os.close(fd); raise RuntimeError("record path has wrong file type")
 if not directory and (st.st_nlink!=1 or st.st_size>MAX): os.close(fd); raise RuntimeError("record is linked or over bound")
 return fd
def open_dir_at(rootfd,relative):
 current=os.dup(rootfd)
 try:
  for name in pathlib.PurePosixPath(relative).parts:
   if name in ("",".",".."): raise RuntimeError("unsafe directory path")
   child=open_child(current,name,True); os.close(current); current=child
  return os.dup(current)
 finally: os.close(current)
def open_absolute_dir(path):
 absolute=pathlib.Path(path)
 if not absolute.is_absolute(): raise RuntimeError("directory path is not absolute")
 current=os.open("/",os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC)
 try:
  for name in absolute.parts[1:]:
   child=open_child(current,name,True); os.close(current); current=child
  return os.dup(current)
 finally: os.close(current)
def read_at(rootfd,relative):
 parts=pathlib.PurePosixPath(relative).parts
 if not parts or pathlib.PurePosixPath(relative).is_absolute() or any(x in ("",".","..") for x in parts): raise RuntimeError("unsafe relative path")
 current=os.dup(rootfd)
 try:
  for name in parts[:-1]:
   child=open_child(current,name,True); os.close(current); current=child
  fd=open_child(current,parts[-1])
  try:
   before=os.fstat(fd); chunks=[]; total=0
   while True:
    data=os.read(fd,min(1024*1024,MAX+1-total))
    if not data: break
    chunks.append(data); total+=len(data)
    if total>MAX: raise RuntimeError("record exceeds bound")
   after=os.fstat(fd)
   if (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns) or total!=before.st_size:
    raise RuntimeError("record changed while reading")
   return b"".join(chunks)
  finally: os.close(fd)
 finally: os.close(current)
def obj(rootfd,relative): return json.loads(read_at(rootfd,relative),object_pairs_hook=unique)
def store_id():
 state=paths.state; store=paths.store
 if state.resolve(strict=True)!=state or store.resolve(strict=True)!=store: raise RuntimeError("store roots are linked")
 relative=store.relative_to(state).as_posix()
 host=json.loads(service._bounded_regular(pathlib.Path("/run/fullmag/linux-native-host.json"),"native host identity",MAX),object_pairs_hook=unique)
 owner=json.loads(service._bounded_regular(state/".fullmag-linux-native-owner.json","native store owner",MAX),object_pairs_hook=unique)
 token=host.get("owner_token"); engine=host.get("engine_id")
 if (host!=owner or host.get("schema")!="fullmag.linux-native-host.v1" or host.get("storage_profile")!="linux-native-v1"
  or host.get("role")!="session" or host.get("owner_scope")!="docker-linux" or host.get("restart_verified") is not True
  or not isinstance(token,str) or re.fullmatch("[0-9a-f]{32}",token) is None or not isinstance(engine,str) or not engine):
  raise RuntimeError("Linux-native store owner differs")
 stable={"schema":"fullmag.linux-native-store-identity.v1","engine_id":engine,"owner_token":token,"relative_state_path":relative}
 return "sha256:"+sha(canon(stable))
def process_pin(pid):
 if type(pid) is not int or pid<=1: raise RuntimeError("API PID invalid")
 root=pathlib.Path("/proc")/str(pid); stat_text=(root/"stat").read_text(); fields=stat_text[stat_text.rfind(")")+2:].split()
 with (root/"cmdline").open("rb") as source: argv=source.read(4097)
 binary="/opt/fullmag/package/bin/fullmag-api"
 if argv!=binary.encode()+b"\0" or os.readlink(root/"exe")!=str(pathlib.Path(binary).resolve(strict=True)):
  raise RuntimeError("API process identity differs")
 return {"pid":pid,"start_token":fields[19],"ppid":int(fields[1]),"argv":[binary],"exe":str(pathlib.Path(binary).resolve(strict=True))}
def owner_identity(owner):
 fields=("owner_token","process_start_token","pid","host","target_id","protocol","build_commit","build_snapshot",
  "control_address","compute_pool_generation","preparation_pool_generation","compute_pool_id","preparation_pool_id")
 if any(owner.get(key) is None for key in fields): raise RuntimeError("native owner identity incomplete")
 children=owner.get("children")
 if not isinstance(children,list) or len(children)!=2 or {c.get("role") for c in children}!={"compute","preparation"}: raise RuntimeError("native owner children differ")
 return {**{key:owner[key] for key in fields},"children":sorted((child["role"],child["pid"]) for child in children)}
def native_status():
 owner=service._service_status(paths)
 service._validate_terminal_owner(owner,state="ready",name="prelaunch native Ready status")
 return owner
class WriterLockBusy(Exception): pass
def collect_once(run,runtime_state=None,native_owner=None):
 storefd=open_absolute_dir(paths.store)
 ledger=pathlib.Path("/host-ledger/ledger"); ledgerfd=open_absolute_dir(ledger)
 # Acquire host ledger first, then SessionStore. Never create or truncate either descriptor.
 lfd=open_child(ledgerfd,"WRITER.lock")
 try:
  if os.read(lfd,64)!=b"fullmag.writer.lock.v1\n": raise RuntimeError("host writer lock descriptor differs")
  fcntl.flock(lfd,fcntl.LOCK_EX|fcntl.LOCK_NB)
 except BlockingIOError as exc:
  os.close(lfd); os.close(ledgerfd); os.close(storefd); raise WriterLockBusy() from exc
 except Exception: os.close(lfd); os.close(ledgerfd); os.close(storefd); raise
 sfd=None
 try:
  sfd=open_child(storefd,"WRITER.lock")
  st=os.fstat(sfd)
  if os.read(sfd,64)!=b"fullmag.writer.lock.v1\n": raise RuntimeError("store writer descriptor differs")
  try: fcntl.flock(sfd,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError as exc: raise WriterLockBusy() from exc
  store=storefd; ledger_root=ledgerfd
  runid=run["run_id"]
  for transient in ("temp","recovery"):
   tfd=open_child(store,transient,True)
   try:
    if os.listdir(tfd): raise RuntimeError("pending store transaction/recovery files exist")
   finally: os.close(tfd)
  intent_raw=read_at(store,"runs/"+runid+"/run_intent.json"); intent=json.loads(intent_raw,object_pairs_hook=unique)
  catalog_raw=read_at(store,"runs/"+runid+"/run_catalog.json"); catalog=json.loads(catalog_raw,object_pairs_hook=unique)
  release_raw=read_at(store,"runs/"+runid+"/start_release.json"); release=json.loads(release_raw,object_pairs_hook=unique)
  plan_ref=intent.get("study_object_ref"); catalog_ref=intent.get("study_catalog_object_ref")
  if not isinstance(plan_ref,str) or not re.fullmatch("[0-9a-f]{64}",plan_ref) or not isinstance(catalog_ref,str) or not re.fullmatch("[0-9a-f]{64}",catalog_ref): raise RuntimeError("Study CAS identity missing")
  plan_raw=read_at(store,"objects/sha256/"+plan_ref); study_catalog_raw=read_at(store,"objects/sha256/"+catalog_ref)
  if sha(plan_raw)!=plan_ref or sha(study_catalog_raw)!=catalog_ref: raise RuntimeError("Study CAS object digest differs")
  plan=json.loads(plan_raw,object_pairs_hook=unique); study_catalog=json.loads(study_catalog_raw,object_pairs_hook=unique)
  tasks=catalog.get("tasks"); failed=[t for t in tasks or [] if isinstance(t,dict) and t.get("lifecycle")=="failed"]
  if len(failed)!=1: raise RuntimeError("unique failed task missing")
  task=failed[0]; rid=runid; tid=task.get("task_id"); aid=task.get("attempt_id"); epoch=task.get("ownership_epoch")
  if not all(isinstance(x,str) for x in (tid,aid)): raise RuntimeError("failed task identity missing")
  attempt=f"runs/{rid}/worker-attempts/{tid}/{aid}/epoch-{epoch}"
  started_rel=attempt+"/worker_execution_started.v1.json"; prelaunch_rel=attempt+"/worker_prelaunch_failed.v1.json"
  started_raw=read_at(store,started_rel); prelaunch_raw=read_at(store,prelaunch_rel)
  started=json.loads(started_raw,object_pairs_hook=unique); prelaunch=json.loads(prelaunch_raw,object_pairs_hook=unique)
  claim=started.get("identity",{}).get("claim",{}); lease_token=claim.get("lease",{}).get("lease_token")
  inbox_identity=[rid,tid,aid,epoch]; inbox_id=sha(canon(inbox_identity))
  inbox_rel=f"runs/{rid}/worker_inbox/{inbox_id}.json"; inbox_raw=read_at(store,inbox_rel); inbox=json.loads(inbox_raw,object_pairs_hook=unique)
  inbox_payload=inbox.get("payload",{})
  exit_root="runs/"+rid+"/worker_process_exit_receipts"
  runfd=open_dir_at(store,"runs/"+rid)
  exitfd=os.open("worker_process_exit_receipts",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=runfd)
  try:
   names=sorted(os.listdir(exitfd))
   if len(names)!=1 or not names[0].endswith(".json"): raise RuntimeError("worker exit receipt inventory differs")
   exit_rel=exit_root+"/"+names[0]
  finally: os.close(exitfd); os.close(runfd)
  exit_raw=read_at(store,exit_rel); exit_receipt=json.loads(exit_raw,object_pairs_hook=unique)
  lease_root="runs/"+rid+"/resource_leases"
  runfd=open_dir_at(store,"runs/"+rid)
  leasefd=os.open("resource_leases",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=runfd)
  try:
   resources=sorted(os.listdir(leasefd))
   if len(resources)!=1: raise RuntimeError("resource lease inventory differs")
   rfd=os.open(resources[0],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=leasefd)
   try:
    lease_names=sorted(os.listdir(rfd))
    if len(lease_names)!=1 or not lease_names[0].endswith(".json"): raise RuntimeError("resource lease receipt inventory differs")
    lease_rel=lease_root+"/"+resources[0]+"/"+lease_names[0]
   finally: os.close(rfd)
  finally: os.close(leasefd); os.close(runfd)
  lease_raw=read_at(store,lease_rel); lease=json.loads(lease_raw,object_pairs_hook=unique)
  artifact_raw=None
  try: artifact_raw=read_at(store,"runs/"+rid+"/artifact_catalog.json")
  except FileNotFoundError: pass
  if artifact_raw is not None: raise RuntimeError("artifact catalog exists")
  # Require the only worker-attempt tree to be the one exact Started/prelaunch pair.
  attempt_root="runs/"+rid+"/worker-attempts"
  tfd=open_dir_at(store,attempt_root)
  try:
   task_names=sorted(os.listdir(tfd))
   if task_names!=[tid]: raise RuntimeError("another worker task attempt exists")
   dfd=os.open(tid,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=tfd)
   try:
    attempt_names=sorted(os.listdir(dfd))
    if attempt_names!=[aid]: raise RuntimeError("another worker attempt exists")
    afd=os.open(aid,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=dfd)
    try:
     epoch_names=sorted(os.listdir(afd))
     if epoch_names!=["epoch-"+str(epoch)]: raise RuntimeError("worker ownership epoch differs")
     efd=os.open(epoch_names[0],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=afd)
     try:
      names=sorted(os.listdir(efd))
      if names!=["worker_execution_started.v1.json","worker_prelaunch_failed.v1.json"]: raise RuntimeError("worker attempt contains output or unknown sidecar")
     finally: os.close(efd)
    finally: os.close(afd)
   finally: os.close(dfd)
  finally: os.close(tfd)
  # Preserve bounded run-owned preparation/admission and coordinator journals
  # as opaque metadata. They confer no restore or solver-output authority.
  # Names are narrowly tied to this plan/failed attempt or to journal schemas.
  runroot="runs/"+rid
  metadata_paths=[runroot+"/preparation_receipt.json",
   runroot+"/accepted_stage_preparation_receipts/"+tid+".json",
   runroot+"/task_admissions/"+tid+"/"+aid+".json"]
  task_ids=sorted(t.get("task_id") for t in tasks if isinstance(t,dict))
  if len(task_ids)!=len(set(task_ids)) or any(not isinstance(x,str) or not re.fullmatch("task-[0-9a-f]{64}",x) for x in task_ids):
   raise RuntimeError("run task identities are malformed")
  metadata_paths.extend(runroot+"/task_preparation_receipts/"+task_id+".json" for task_id in task_ids)
  def journal_files(relative,pattern,maximum):
   fd=open_dir_at(store,relative)
   try:
    names=sorted(os.listdir(fd))
    if not names or len(names)>maximum or any(not re.fullmatch(pattern,name) for name in names):
     raise RuntimeError("coordinator journal metadata names differ")
    result=[]
    for name in names:
     st=os.stat(name,dir_fd=fd,follow_symlinks=False)
     if not stat.S_ISREG(st.st_mode) or st.st_nlink!=1 or st.st_size>MAX: raise RuntimeError("journal record is not a bounded regular file")
     result.append(relative+"/"+name)
    return result
   finally: os.close(fd)
  metadata_paths.extend(journal_files(runroot+"/coordinator_journal/command",r"command-[0-9a-f]{32}\.json",32))
  metadata_paths.extend(journal_files(runroot+"/coordinator_journal/event",r"(?:[0-9a-f]{32}|event-prepared-[0-9a-f]{64})\.json",64))
  metadata_hashes={}; metadata_total=0
  for relative in metadata_paths:
   raw=read_at(store,relative)
   metadata_total+=len(raw)
   if metadata_total>MAX_TOTAL: raise RuntimeError("opaque run metadata exceeds aggregate bound")
   metadata=json.loads(raw,object_pairs_hook=unique)
   if not isinstance(metadata,dict): raise RuntimeError("opaque run metadata is not a JSON object")
   metadata_hashes[relative]=sha(raw)
  # Keep only a compact no-follow hash inventory for this run in the receipt.
  record_paths=["runs/"+rid+"/run_intent.json","runs/"+rid+"/run_catalog.json","runs/"+rid+"/start_release.json",
    plan_ref and "objects/sha256/"+plan_ref,catalog_ref and "objects/sha256/"+catalog_ref,
    started_rel,prelaunch_rel,inbox_rel,exit_rel,lease_rel]
  hashes={}; record_total=metadata_total
  for path in record_paths:
   raw=read_at(store,path); record_total+=len(raw)
   if record_total>MAX_TOTAL: raise RuntimeError("failed run record inventory exceeds aggregate bound")
   hashes[path]=sha(raw)
  hashes.update(metadata_hashes)
  ledger_raw=read_at(ledger_root,"HOST_RESOURCE_LEDGER.json"); host_ledger=json.loads(ledger_raw,object_pairs_hook=unique)
  store_identity=store_id(); all_rows=host_ledger.get("reservations")
  if not isinstance(all_rows,list) or len(all_rows)>MAX_FILES: raise RuntimeError("host reservations are unavailable or over bound")
  for candidate in all_rows:
   candidate_store=candidate.get("identity",{}).get("store_id") if isinstance(candidate,dict) else None
   if not isinstance(candidate_store,str) or re.fullmatch("sha256:[0-9a-f]{64}",candidate_store) is None: raise RuntimeError("reservation store identity is unknown")
  rows=[row for row in all_rows if row.get("identity",{}).get("store_id")==store_identity]
  matching=[row for row in rows if isinstance(row,dict)
    and row.get("identity",{}).get("run_id")==rid]
  proof_docs={}; proof_raw_hashes={}
  for row in rows:
   proof_sha=row.get("release_proof_sha256")
   if isinstance(proof_sha,str) and re.fullmatch("[0-9a-f]{64}",proof_sha):
    proof_path="proofs/"+proof_sha+".json"; proof_raw=read_at(ledger_root,proof_path)
    proof_docs[proof_sha]=json.loads(proof_raw,object_pairs_hook=unique); proof_raw_hashes[proof_sha]=sha(proof_raw)
  target={"schema":"fullmag.prelaunch-failure-locked-evidence.v1","locked":True,"lock_order":["host-ledger","session-store"],
   "run_id":rid,"store_id":store_identity,"run_intent":intent,"run_catalog":catalog,"start_release":release,
   "study_plan":plan,"study_plan_raw_sha256":sha(plan_raw),"study_catalog_present":True,"study_catalog_raw_sha256":sha(study_catalog_raw),
   "start_release_raw_sha256":sha(release_raw),"run_intent_raw_sha256":sha(intent_raw),"run_catalog_raw_sha256":sha(catalog_raw),
   "started_raw_sha256":sha(started_raw),"prelaunch_raw_sha256":sha(prelaunch_raw),"inbox_raw_sha256":sha(inbox_raw),
   "exit_raw_sha256":sha(exit_raw),"lease_raw_sha256":sha(lease_raw),"leases":[lease],"preparation_leases":[],
   "worker_exit_receipts":[exit_receipt],"attempts":{tid:{"files":{"worker_execution_started.v1.json":started,
    "worker_prelaunch_failed.v1.json":prelaunch},"worker_inbox":inbox}},"other_task_attempts_absent":True,
   "host_ledger":{"schema_version":host_ledger.get("schema_version"),"policy":host_ledger.get("policy"),
    "reservations":rows,"release_proofs":proof_docs,"release_proof_raw_sha256":proof_raw_hashes},
   "artifact_catalog":None,"other_runs_terminal":True,"no_live_sidecars":True,"record_sha256":hashes}
  # The complete run inventory must contain only records admitted above.
  allowed={path for path in hashes if path.startswith("runs/"+rid+"/")}
  rfd=open_dir_at(store,"runs/"+rid)
  try:
   def walk(fd,prefix):
    output=[]; directories=[]
    for name in sorted(os.listdir(fd)):
     st=os.stat(name,dir_fd=fd,follow_symlinks=False)
     rel=prefix+"/"+name
     if stat.S_ISLNK(st.st_mode) or not (stat.S_ISDIR(st.st_mode) or stat.S_ISREG(st.st_mode)): raise RuntimeError("run contains linked/special entry")
     if stat.S_ISDIR(st.st_mode):
      directories.append(rel)
      cfd=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
      try:
       child_files,child_dirs=walk(cfd,rel); output.extend(child_files); directories.extend(child_dirs)
      finally: os.close(cfd)
     else: output.append(rel)
    return output,directories
   actual_list,actual_dirs=walk(rfd,"runs/"+rid); actual_files=set(actual_list)
  finally: os.close(rfd)
  if len(actual_list)>MAX_FILES or len(actual_dirs)>MAX_FILES: raise RuntimeError("run inventory exceeds entry bound")
  expected_dirs=set()
  run_root=pathlib.PurePosixPath("runs/"+rid)
  for path in allowed:
   if not path.startswith(str(run_root)+"/"): continue
   for parent in pathlib.PurePosixPath(path).parents:
    if parent==run_root: break
    if str(parent).startswith(str(run_root)+"/"): expected_dirs.add(str(parent))
  if actual_files!=allowed or set(actual_dirs)!=expected_dirs: raise RuntimeError("run contains unknown files/directories/sidecars")
  # Every other persisted run must be terminal; never inspect or modify its outputs.
  runfd=open_child(store,"runs",True)
  try:
   names=sorted(os.listdir(runfd))
   if len(names)>256: raise RuntimeError("run inventory exceeds bound")
   others=[]
   for name in names:
    if name==rid: continue
    fd=open_child(runfd,name,True)
    try:
     other=json.loads(read_at(fd,"run_catalog.json"),object_pairs_hook=unique)
     other_intent=json.loads(read_at(fd,"run_intent.json"),object_pairs_hook=unique)
     if other.get("run_id")!=name or other_intent.get("run_id")!=name or not isinstance(other.get("tasks"),list) or not other["tasks"] or any(t.get("lifecycle") not in ("succeeded","failed","cancelled","interrupted") for t in other["tasks"]):
      raise RuntimeError("another persisted run is active or unknown")
     others.append({"run_id":name,"run_intent_sha256":sha(read_at(fd,"run_intent.json")),
       "run_catalog_sha256":sha(read_at(fd,"run_catalog.json"))})
    finally: os.close(fd)
  finally: os.close(runfd)
  target["other_run_pins"]=others
  if runtime_state is not None:
   owner_path=service.runtime_services_root(paths)/"OWNER.json"
   owner_raw=service._bounded_regular(owner_path,"prelaunch Ready OWNER.json",256*1024)
   owner=json.loads(owner_raw,object_pairs_hook=unique)
   service._validate_terminal_owner(owner,state="ready",name="prelaunch Ready OWNER.json")
   if native_owner is None or service._owner_fingerprint(native_owner)!=service._owner_fingerprint(owner):
    raise RuntimeError("native Ready status differs from OWNER.json")
   process_raw=service._bounded_regular(service.process_receipt_path(paths),"prelaunch process receipt",MAX)
   process=json.loads(process_raw,object_pairs_hook=unique)
   if (process.get("schema")!="fullmag.docker-process-tree.v1" or process.get("state")!=runtime_state
    or service._owner_fingerprint(process.get("service_owner",{}))!=service._owner_fingerprint(owner)):
    raise RuntimeError("runtime OWNER/process receipt is not the exact pinned phase")
   config_raw=service._bounded_regular(paths.config,"runtime service config",65536)
   target["runtime_ready_owner"]=owner
   target["runtime_owner_sha256"]=sha(canon(owner_identity(owner)))
   target["runtime_process_sha256"]=sha(process_raw)
   target["runtime_native_config_sha256"]=sha(config_raw)
   if runtime_state=="ready":
    api=process_pin(process.get("api_pid"))
    target["runtime_api_pin"]=api
   else:
    if (runtime_state!="failed_outcome_retained" or process.get("api_exit_code")!=-15
     or process.get("api_diagnostic_only") is not False
     or process.get("error")!="Fullmag API exited unexpectedly (-15)"):
     raise RuntimeError("retained API failure receipt differs from exact SIGTERM")
    target["runtime_api_pid"]=process.get("api_pid")
    target["runtime_api_exit_code"]=process.get("api_exit_code")
    target["runtime_api_error"]=process.get("error")
    target["runtime_api_diagnostic_only"]=process.get("api_diagnostic_only")
  return target
 finally:
  if sfd is not None:
   try: fcntl.flock(sfd,fcntl.LOCK_UN)
   finally: os.close(sfd)
  fcntl.flock(lfd,fcntl.LOCK_UN); os.close(lfd); os.close(ledgerfd); os.close(storefd)
def collect(run,runtime_state=None,native_owner=None):
 deadline=time.monotonic()+3.0
 while True:
  try: return collect_once(run,runtime_state,native_owner)
  except WriterLockBusy:
   remaining=deadline-time.monotonic()
   if remaining<=0: raise RuntimeError("bounded writer-lock contention; no unfenced snapshot was used") from None
   time.sleep(min(0.05,remaining))
def store_evidence_sha(value):
 return sha(canon({k:v for k,v in value.items() if not k.startswith("runtime_")}))
def prepare():
 native_before=native_status(); before=snapshot(); evidence=collect(before["run"],"ready",native_before); after=snapshot()
 native_after=native_status(); evidence_after=collect(before["run"],"ready",native_after); final=snapshot()
 native_final=native_status()
 if (api_binding(before)!=api_binding(after) or api_binding(before)!=api_binding(final)
  or store_evidence_sha(evidence)!=store_evidence_sha(evidence_after)
  or service._owner_fingerprint(native_before)!=service._owner_fingerprint(native_after)
  or service._owner_fingerprint(native_before)!=service._owner_fingerprint(native_final)
  or evidence.get("runtime_owner_sha256")!=evidence_after.get("runtime_owner_sha256")
  or evidence.get("runtime_process_sha256")!=evidence_after.get("runtime_process_sha256")
  or evidence.get("runtime_native_config_sha256")!=evidence_after.get("runtime_native_config_sha256")
  or evidence.get("runtime_api_pin")!=evidence_after.get("runtime_api_pin")):
  raise RuntimeError("API/owner/config/store snapshot changed")
 api=evidence_after["runtime_api_pin"]
 if not callable(getattr(os,"pidfd_open",None)) or not callable(getattr(signal,"pidfd_send_signal",None)):
  raise RuntimeError("exact pidfd quiescence is unsupported")
 fd=os.pidfd_open(api["pid"])
 try:
  if process_pin(api["pid"])!=api: raise RuntimeError("API PID/start token changed during pidfd preflight")
 finally: os.close(fd)
 return {"before":before,"after":after,"ready_owner":evidence_after["runtime_ready_owner"],
  "api_pin":evidence_after["runtime_api_pin"],"native_config_sha256":evidence_after["runtime_native_config_sha256"],
  "process_sha256":evidence_after["runtime_process_sha256"],"store_evidence":evidence_after}
def quiesce():
 if len(sys.argv)!=4: raise RuntimeError("quiesce arguments differ")
 raw_intent=base64.b64decode(sys.argv[2],validate=True); intent_sha=sys.argv[3]
 if len(raw_intent)>MAX or sha(raw_intent)!=intent_sha: raise RuntimeError("durable intent size/digest differs")
 intent=json.loads(raw_intent,object_pairs_hook=unique)
 if raw_intent!=canon(intent)+b"\n" or intent.get("schema")!="fullmag.prelaunch-failure-api-quiescence-intent.v1": raise RuntimeError("durable intent schema/canonical bytes differ")
 prepared=intent.get("prepared",{}); expected=prepared.get("preflight",{}); api=prepared.get("api_pin",{})
 before=snapshot()
 if api_binding(before)!=expected: raise RuntimeError("API/session/scene/commands changed before quiescence")
 queue=before.get("queue",{}); items=queue.get("items",[]); binding=prepared.get("store_binding",{})
 if (len(items)!=2 or sorted(item.get("task_id") for item in items)!=sorted(binding.get("blocked_task_ids",[]))
  or any(item.get("run_id")!=expected.get("run_id") or item.get("project_id")!=binding.get("project_id")
   or item.get("state")!="accepted" or item.get("attempt_id") is not None or item.get("ownership_epoch") is not None
   or item.get("resource_id") is not None for item in items)):
  raise RuntimeError("compute queue is not exactly the still-blocked accepted Study tasks")
 native_before=native_status(); evidence=collect(before["run"],"ready",native_before)
 native_after=native_status()
 if (sha(canon(owner_identity(evidence.get("runtime_ready_owner",{}))))!=prepared.get("ready_owner_sha256")
  or service._owner_fingerprint(native_before)!=service._owner_fingerprint(native_after)
  or service._owner_fingerprint(native_after)!=service._owner_fingerprint(evidence.get("runtime_ready_owner",{}))
  or evidence.get("runtime_process_sha256")!=prepared.get("process_sha256")
  or evidence.get("runtime_api_pin")!=api
  or store_evidence_sha(evidence)!=prepared.get("locked_evidence_sha256")
  or evidence.get("runtime_native_config_sha256")!=prepared.get("native_config_sha256")):
  raise RuntimeError("locked store/config pins changed before quiescence")
 if api_binding(snapshot())!=expected: raise RuntimeError("API state changed during final quiescence check")
 fd=os.pidfd_open(api["pid"])
 try:
  if process_pin(api["pid"])!=api: raise RuntimeError("API PID/start token changed before one SIGTERM")
  signal.pidfd_send_signal(fd,signal.SIGTERM,None,0)
 finally: os.close(fd)
 deadline=time.monotonic()+15
 while True:
  gone=not pathlib.Path("/proc").joinpath(str(api["pid"])).exists()
  try:
   with socket.create_connection(("127.0.0.1",8081),timeout=.2): closed=False
  except ConnectionRefusedError: closed=True
  if gone and closed: break
  if time.monotonic()>=deadline: raise RuntimeError("API closure unconfirmed; backend must remain retained")
  time.sleep(.05)
 while True:
  retained_raw=service._bounded_regular(service.process_receipt_path(paths),"retained process receipt",MAX)
  retained=json.loads(retained_raw,object_pairs_hook=unique)
  if retained.get("state")=="failed_outcome_retained":
   if (retained.get("api_pid")!=api["pid"] or retained.get("api_exit_code")!=-15
    or retained.get("api_diagnostic_only") is not False or retained.get("error")!="Fullmag API exited unexpectedly (-15)"):
    raise RuntimeError("API exit was not authenticated as the exact pidfd SIGTERM")
   break
  if time.monotonic()>=deadline: raise RuntimeError("supervisor failed to record exact API exit")
  time.sleep(.05)
 native_retained=native_status(); final_evidence=collect(before["run"],"failed_outcome_retained",native_retained)
 native_retained_after=native_status()
 if (store_evidence_sha(final_evidence)!=prepared.get("locked_evidence_sha256")
  or service._owner_fingerprint(native_retained)!=service._owner_fingerprint(native_retained_after)
  or service._owner_fingerprint(native_retained_after)!=service._owner_fingerprint(final_evidence.get("runtime_ready_owner",{}))
  or final_evidence.get("runtime_owner_sha256")!=prepared.get("ready_owner_sha256")
  or final_evidence.get("runtime_native_config_sha256")!=prepared.get("native_config_sha256")
  or final_evidence.get("runtime_api_pid")!=api["pid"]):
  raise RuntimeError("failed-run ledger/store changed after API closure")
 ready_identity=owner_identity(evidence["runtime_ready_owner"])
 return {"preflight":before,"store_evidence":final_evidence,"api_quiescence":{
        "schema":"fullmag.prelaunch-failure-api-quiescence.v1","api_instance_id":expected.get("api_instance_id"),
  "api_pin":api,"api_closed":True,"signal":"SIGTERM","api_exit_code":-15,"api_diagnostic_only":False,
  "error":"Fullmag API exited unexpectedly (-15)","preflight_sha256":sha(canon(expected)),
  "store_binding_sha256":prepared.get("store_binding_sha256"),
  "locked_evidence_sha256":prepared.get("locked_evidence_sha256"),"ready_owner_sha256":sha(canon(ready_identity)),
  "intent_sha256":intent_sha,"failure_process_sha256":final_evidence["runtime_process_sha256"]}}
if mode=="offline":
 if len(sys.argv)!=4: raise RuntimeError("offline arguments differ")
 evidence=collect({"run_id":sys.argv[2]})
 if evidence.get("store_id")!=sys.argv[3]: raise RuntimeError("offline store identity differs")
 result={"schema":"fullmag.prelaunch-failure-locked-evidence.v1","store_evidence":evidence}
else:
 result=prepare() if mode=="prepare" else quiesce() if mode=="quiesce" else None
if result is None: raise RuntimeError("unknown locked probe mode")
print(json.dumps(result,sort_keys=True))
'''


def _prepare(backend_id: str) -> dict:
    result = docker_capture("exec", backend_id, "python3", "-I", "-B", "-c", LOCKED_PROBE,
                           "prepare", timeout=90)
    require(len(result.stdout) <= MAX_CAPTURE_BYTES, "locked preflight output exceeds bound")
    observed = decode(result.stdout)
    before = snapshot_binding(observed.get("before"))
    after = snapshot_binding(observed.get("after"))
    require(before == after, "API/session/run/scene changed during locked evidence collection")
    binding = validate_store_evidence(observed.get("store_evidence"))
    require(binding.get("run_id") == before.get("run_id"), "store and public API run differ")
    queue_items = observed["before"].get("queue", {}).get("items", [])
    require(sorted(item.get("task_id") for item in queue_items) == sorted(binding["blocked_task_ids"])
            and all(item.get("project_id") == binding["project_id"] for item in queue_items),
            "public queue does not contain exactly the dependency-blocked accepted tasks")
    owner = observed.get("ready_owner")
    process = observed.get("process_sha256")
    api_pin = observed.get("api_pin")
    return {"preflight": before, "store_binding": binding,
            "locked_evidence_sha256": _locked_store_evidence_sha(observed.get("store_evidence")),
            "store_binding_sha256": _store_binding_hash(binding),
            "ready_owner_sha256": sha(canonical(_identity(owner))),
            "native_config_sha256": digest(observed.get("native_config_sha256")),
            "process_sha256": digest(process), "api_pin": api_pin}


def prepare(backend_id: str) -> dict:
    """Capture a bounded no-mutation preflight while both existing writer locks are held."""
    require(isinstance(backend_id, str) and backend_id, "backend container identity is missing")
    return _prepare(backend_id)


def quiesce_api_and_capture(backend_id: str, intent: dict) -> dict:
    require(isinstance(intent, dict) and intent.get("schema") == QUIESCE_INTENT_SCHEMA
            and isinstance(intent.get("prepared"), dict), "durable quiescence intent is malformed")
    source_binding = assert_source_binding_current(intent.get("source_binding"))
    raw_intent = canonical(intent) + b"\n"
    import base64
    encoded = base64.b64encode(raw_intent).decode("ascii")
    # The base64 value is passed as one fixed argv value, never interpolated into code.
    result = docker_capture("exec", backend_id, "python3", "-I", "-B", "-c", LOCKED_PROBE,
                           "quiesce", encoded, sha(raw_intent), timeout=90)
    require(len(result.stdout) <= MAX_CAPTURE_BYTES, "post-quiescence capture exceeds bound")
    observed = decode(result.stdout)
    assert_source_binding_current(source_binding)
    store_binding = validate_store_evidence(observed.get("store_evidence"))
    require(store_binding == intent["prepared"].get("store_binding")
            and _locked_store_evidence_sha(observed.get("store_evidence"))
            == intent["prepared"].get("locked_evidence_sha256"),
            "locked accepted-run evidence changed across API quiescence")
    require(snapshot_binding(observed.get("preflight")) == intent["prepared"].get("preflight"),
            "API/session/run/scene changed before API closure")
    queue_items = observed["preflight"].get("queue", {}).get("items", [])
    require(sorted(item.get("task_id") for item in queue_items)
            == sorted(store_binding["blocked_task_ids"])
            and all(item.get("project_id") == store_binding["project_id"] for item in queue_items),
            "post-quiescence public queue differs from the blocked accepted tasks")
    captured = {"schema": SCHEMA, "source_binding": source_binding,
                "preflight": intent["prepared"]["preflight"],
                "store_binding": store_binding, "ready_owner_sha256": intent["prepared"]["ready_owner_sha256"],
                "native_config_sha256": intent["prepared"]["native_config_sha256"],
                "locked_evidence_sha256": intent["prepared"]["locked_evidence_sha256"],
                "process_sha256": intent["prepared"]["process_sha256"],
                "api_pin": intent["prepared"]["api_pin"], "api_quiescence": observed.get("api_quiescence")}
    return validate_capture(captured)


def verify_stopped_locked(backend_id: str, image_id: str, run_id: str, store_id: str,
                          expected_binding: dict) -> dict:
    """Recheck preserved run and released host reservation under existing locks.

    The exact stopped backend contributes its existing volumes read-only to a
    no-network, read-only, capability-free helper. No API/native executable is
    started and no volume, lock, or record is created or modified.
    """
    require(isinstance(backend_id, str) and re.fullmatch(r"[0-9a-f]{64}", backend_id),
            "backend container identity is malformed")
    require(isinstance(image_id, str) and re.fullmatch(r"sha256:[0-9a-f]{64}", image_id),
            "backend image identity is malformed")
    portable(run_id, "run id")
    require(isinstance(store_id, str) and re.fullmatch(r"sha256:[0-9a-f]{64}", store_id),
            "store identity is malformed")
    require(isinstance(expected_binding, dict) and expected_binding.get("run_id") == run_id
            and expected_binding.get("store_id") == store_id,
            "expected stopped-store binding differs")
    result = docker_capture(
        "run", "--rm", "--pull", "never", "--no-healthcheck", "--network", "none", "--runtime", "runc",
        "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
        "--pids-limit", "16", "--memory", "128m", "--cpus", "0.25", "--user", "65532:65532",
        "--volumes-from", backend_id + ":ro",
        "--entrypoint", "python3", image_id, "-I", "-B", "-c", LOCKED_PROBE,
        "offline", run_id, store_id, timeout=90,
    )
    require(len(result.stdout) <= MAX_CAPTURE_BYTES, "post-drain locked evidence exceeds bound")
    observed = decode(result.stdout)
    require(observed.get("schema") == "fullmag.prelaunch-failure-locked-evidence.v1",
            "post-drain locked evidence schema differs")
    evidence = observed.get("store_evidence")
    binding = validate_store_evidence(evidence)
    require(binding == expected_binding and binding.get("run_id") == run_id and binding.get("store_id") == store_id,
            "failed-run/host-release evidence changed after native drain")
    return {"schema": POSTDRAIN_SCHEMA, "run_id": run_id, "store_id": store_id,
            "store_binding_sha256": _store_binding_hash(binding),
            "locked_evidence_sha256": _locked_store_evidence_sha(evidence),
            "record_inventory_sha256": binding["record_inventory_sha256"],
            "response_sha256": sha(result.stdout)}
