"""Private terminal observation input producer.

Pure proof construction is separate from explicit technical CAS publication.
Rust owns Study loading, canonical terminal fences and memory installation.
No run, Start, admission, lease, native exit or solver action is issued here.
"""
from __future__ import annotations

import hashlib
import json
import re
from typing import Callable, Mapping

PROOF_SCHEMA = "fullmag.development-terminal-observation-proof.v1"
Read = Callable[[str], bytes]


def canonical(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def require(condition: object, message: str) -> None:
    if not condition:
        raise ValueError(message)


def digest(value: object) -> str:
    require(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value),
            "invalid digest")
    return value


def portable(value: object) -> str:
    require(isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,255}", value),
            "invalid portable identity")
    return value


def decode(raw: bytes) -> dict:
    require(isinstance(raw, bytes) and 0 < len(raw) <= 8 * 1024 * 1024,
            "record is not bounded bytes")

    def unique(pairs):
        value = {}
        for key, item in pairs:
            require(key not in value, "duplicate JSON field")
            value[key] = item
        return value

    result = json.loads(raw, object_pairs_hook=unique,
                        parse_constant=lambda _: require(False, "non-finite JSON"))
    require(isinstance(result, dict), "record is not an object")
    return result


def managed(read: Read, relative: str) -> tuple[bytes, dict]:
    raw = read(relative)
    value = decode(raw)
    require(raw == canonical(value) + b"\n", "managed record is not canonical JSON plus LF")
    return raw, value


def owner_identity(owner: Mapping) -> dict:
    fields = ("owner_token", "process_start_token", "pid", "host", "target_id",
              "protocol", "build_commit", "build_snapshot", "control_address",
              "compute_pool_generation", "preparation_pool_generation",
              "compute_pool_id", "preparation_pool_id")
    require(all(owner.get(key) is not None for key in fields), "owner identity is incomplete")
    children = owner.get("children")
    require(isinstance(children, list) and len(children) == 2, "native child set is incomplete")
    require({child.get("role") for child in children} == {"compute", "preparation"},
            "native child roles differ")
    return {**{key: owner[key] for key in fields},
            "children": sorted((child["role"], child["pid"]) for child in children)}


def build_proof(read_control: Read, read_store: Read, *, iteration: str,
                run_id: str, scope: Mapping[str, str], native_config_sha256: str,
                terminal_evidence_sha256: str) -> dict:
    """Pure assembly only; readers must provide bounded, no-symlink bytes.

    Both native pins must come from the canonical native terminal inspection,
    never from this Python catalog parser. Rust revalidates them under its
    host-before-store fence; a config rotation invalidates the launch request.
    """
    digest(native_config_sha256)
    digest(terminal_evidence_sha256)
    require(isinstance(iteration, str) and re.fullmatch("[0-9a-f]{32}", iteration),
            "invalid original iteration")
    portable(run_id)
    require(set(scope) == {"compose_project", "control_volume", "source_root", "image_id"},
            "explicit Docker scope fields differ")
    base = f"iteration/attempts/{iteration}/"
    operation_raw, operation = managed(read_control, base + "terminal.json")
    require(read_control(base + "receipt.json") == operation_raw, "operation is not terminal")
    require(operation.get("schema") == "fullmag.docker-build-operation.v1"
            and operation.get("phase") == "iteration" and operation.get("state") == "succeeded"
            and operation.get("attempt") == iteration, "original iteration did not succeed")
    for key in ("compose_project", "control_volume"):
        require(operation.get(key) == scope[key], "operation belongs to another scope")
    inputs = operation.get("inputs", {})
    require(inputs.get("source_root") == scope["source_root"]
            and inputs.get("image_id") == scope["image_id"], "source/image scope differs")
    config_sha = digest(operation.get("config_sha256"))
    require(inputs.get("config_sha256") == config_sha, "configuration input differs")
    preflight_raw, preflight = managed(read_control, base + "terminal-session-preflight.json")
    require(sha(canonical(preflight)) == operation.get("terminal_session_preflight_sha256"),
            "terminal preflight canonical CAS differs")
    require(preflight.get("schema") == "fullmag.docker-terminal-session-drain-preflight.v1",
            "preflight is not a terminal session observation")
    public_run = preflight.get("run", {})
    require(public_run.get("run_id") == run_id and public_run.get("status") == "failed",
            "preflight is not this Failed run")
    session_id = portable(preflight.get("session_id"))
    require(public_run.get("session_id") == session_id, "public session binding differs")
    started_at = public_run.get("started_at")
    require(isinstance(started_at, str) and started_at.isdigit() and int(started_at) > 0
            and preflight.get("session_epoch") == f"{session_id}@{started_at}",
            "public session timestamp/epoch binding differs")
    queue = preflight.get("compute_queue", {})
    require(queue.get("schema_version") == "compute_queue.v1"
            and queue.get("next_cursor") is None and isinstance(queue.get("items"), list),
            "historical queue is unavailable or paginated")
    held = preflight.get("held_run_intent_sha256", {})
    require(isinstance(held, dict), "held queue pins are invalid")
    queued = set()
    for item in queue["items"]:
        require(isinstance(item, dict) and item.get("state") == "accepted",
                "historical queue had a runnable task")
        held_id = portable(item.get("run_id"))
        queued.add(held_id)
        require(sha(read_store(f"runs/{held_id}/run_intent.json")) == digest(held.get(held_id)),
                "historical held intent changed")
    require(set(held) == queued, "held queue identity set differs")
    runtime = preflight.get("runtime_service", {})
    require(runtime.get("schema_version") == "application_service_status.v1"
            and runtime.get("configured") is True and runtime.get("state") == "ready",
            "historical runtime was not Ready")

    drain_raw, drain = managed(read_control, base + "backend-drain.json")
    require(drain.get("schema") == "fullmag.docker-idle-restart-drain.v1"
            and drain.get("backend_container_id") == operation.get("backend_container"),
            "native drain belongs to another backend")
    process = drain.get("process_receipt", {})
    require(set(process) == {"schema", "state", "api_pid", "api_exit_code", "accepted_store",
                            "bootstrap", "qualification", "service_owner", "terminal_service_owner"},
            "native process receipt is partial or unsupported")
    require(process.get("schema") == "fullmag.docker-process-tree.v1"
            and process.get("state") == "drained"
            and process.get("accepted_store") == "/state/runs/docker-all/session-store"
            and type(process.get("api_exit_code")) is int, "native drain is not confirmed")
    require(sha(canonical(process) + b"\n") == drain.get("process_receipt_sha256"),
            "native process receipt canonical+LF CAS differs")
    ready, terminal = process.get("service_owner", {}), process.get("terminal_service_owner", {})
    require(ready.get("state") == "ready" and terminal.get("state") == "drained"
            and owner_identity(ready) == owner_identity(terminal), "native owner continuity differs")
    require(all(child.get("status") == "running" for child in ready["children"])
            and all(child.get("status") == "exited_success" for child in terminal["children"]),
            "native drain children are not terminal")
    # The token is used only as an internal locator and is never emitted.
    token = portable(ready.get("owner_token"))
    ready_raw = read_control(f"runtime-control/runtime-services/docker-client-{token}.json")
    archived = decode(ready_raw)
    require(archived.get("state") == "ready" and owner_identity(archived) == owner_identity(ready),
            "immutable Ready owner differs")

    relative = f"runs/{run_id}/"
    intent_raw = read_store(relative + "run_intent.json")
    intent = decode(intent_raw)
    require(intent.get("schema_version") == "run_intent.v1" and intent.get("run_id") == run_id,
            "accepted intent identity differs")
    spec = intent.get("specification", {})
    require(spec.get("run_id") == run_id, "specification run differs")
    snapshot, live = spec.get("snapshot", {}), spec.get("parameters", {}).get("live_workspace", {})
    epoch = live.get("session_epoch")
    require(type(epoch) is int and epoch > 0
            and live.get("session_id") == session_id
            and live.get("api_instance_id") == preflight.get("api_instance_id")
            and preflight.get("request_scope_epoch") == f"{live['api_instance_id']}:{epoch}",
            "accepted live identity differs")
    scene_revision = live.get("scene_revision")
    require(type(scene_revision) is int and scene_revision >= 0
            and snapshot.get("definition_revision") == scene_revision,
            "accepted scene revision differs")
    source_id = portable(live.get("request_idempotency_key"))
    source_sha = digest(live.get("startup_source_sha256"))
    command = live.get("command", {})
    require(live.get("command_id") == source_id and command == {
        "kind": "startup_script", "request_id": source_id, "source_sha256": source_sha},
        "immutable startup command binding differs")
    catalog_raw = read_store(relative + "run_catalog.json")
    catalog = decode(catalog_raw)
    tasks = catalog.get("tasks")
    require(catalog.get("schema_version") == "run_catalog.v1" and catalog.get("run_id") == run_id
            and type(catalog.get("revision")) is int and catalog["revision"] > 0
            and isinstance(tasks, list) and tasks, "native catalog is incomplete")
    require(all(task.get("lifecycle") in {"succeeded", "failed", "cancelled", "interrupted"}
                for task in tasks) and any(task.get("lifecycle") == "failed" for task in tasks),
            "native catalog is not terminal Failed")
    release_raw = read_store(relative + "start_release.json")
    release = decode(release_raw)
    require(release.get("schema_version") == "accepted_run_start_release.v1"
            and release.get("run_id") == run_id
            and release.get("specification_sha256") == intent.get("payload_sha256"),
            "native Start release differs")
    return {
        "schema": PROOF_SCHEMA, "original_iteration": iteration,
        "operation_sha256": sha(operation_raw), "preflight_raw_sha256": sha(preflight_raw),
        "drain_sha256": sha(drain_raw), "ready_owner_sha256": sha(ready_raw),
        **scope, "config_sha256": config_sha,
        "run_id": run_id, "project_id": portable(snapshot.get("project_id")),
        "session_id": session_id, "session_epoch": epoch, "scene_revision": scene_revision,
        "definition_sha256": digest(snapshot.get("definition_sha256")),
        "intent_sha256": sha(intent_raw), "specification_sha256": digest(intent.get("payload_sha256")),
        "catalog_sha256": sha(catalog_raw), "catalog_revision": catalog["revision"],
        "native_config_sha256": native_config_sha256,
        "terminal_evidence_sha256": terminal_evidence_sha256,
        "start_release_sha256": sha(release_raw),
        "source_request_id": source_id, "source_sha256": source_sha,
    }


# This context selects observation only. Native admission/recovery stays with
# docker_volume_dev and the native terminal evidence fence.
REQUEST_ENV = "FULLMAG_TERMINAL_OBSERVATION_REQUEST"
REQUEST_SHA_ENV = "FULLMAG_TERMINAL_OBSERVATION_REQUEST_SHA256"
CONTEXT_SCHEMA = "fullmag.terminal-observation-context.v1"


def validate_context(context):
    if context is None:
        return None
    if not isinstance(context, dict) or set(context) != {"environment", "metadata"}:
        raise ValueError("terminal observation context shape differs")
    env, meta = context["environment"], context["metadata"]
    if not isinstance(meta, dict) or set(meta) != {"schema", "proof_sha256", "request_sha256", "stop_attempt", "stop_sha256"}:
        raise ValueError("terminal observation metadata shape differs")
    if meta["schema"] != CONTEXT_SCHEMA:
        raise ValueError("terminal observation metadata schema differs")
    for key in ("proof_sha256", "request_sha256", "stop_sha256"):
        if not isinstance(meta[key], str) or re.fullmatch(r"[0-9a-f]{64}", meta[key]) is None:
            raise ValueError("terminal observation metadata digest differs")
    if re.fullmatch(r"[0-9a-f]{32}", str(meta["stop_attempt"])) is None:
        raise ValueError("terminal observation stop identity differs")
    relative = "terminal-observation/" + meta["proof_sha256"] + "/request.json"
    if env != {REQUEST_ENV: relative, REQUEST_SHA_ENV: meta["request_sha256"]}:
        raise ValueError("terminal observation environment differs")
    return {"environment": dict(env), "metadata": dict(meta)}


def validate_empty_stop(read_control, *, project, volume, source_root, attempt, config_sha256, actual,
                        stop_pin=None):
    if stop_pin is None:
        current_raw = read_control("iteration/current.json")
    else:
        token, expected_sha = stop_pin
        if (re.fullmatch(r"[0-9a-f]{32}", str(token)) is None
                or re.fullmatch(r"[0-9a-f]{64}", str(expected_sha)) is None):
            raise ValueError("terminal observation pinned idle stop is invalid")
        current_raw = read_control("iteration/attempts/" + token + "/terminal.json")
        if hashlib.sha256(current_raw).hexdigest() != expected_sha:
            raise ValueError("terminal observation pinned idle stop CAS changed")
    current = decode(current_raw)
    token = current.get("attempt")
    if re.fullmatch(r"[0-9a-f]{32}", str(token)) is None:
        raise ValueError("terminal observation idle stop identity is invalid")
    root = "iteration/attempts/" + token + "/"
    if (read_control(root + "terminal.json") != current_raw
            or read_control(root + "receipt.json") != current_raw):
        raise ValueError("terminal observation idle stop archive differs")
    if (current.get("schema") != "fullmag.docker-build-operation.v1"
            or current.get("phase") != "iteration"
            or current.get("state") != "succeeded"
            or current.get("idle_backend_stopped") is not True
            or current.get("compose_project") != project
            or current.get("control_volume") != volume
            or current.get("inputs", {}).get("source_root") != source_root
            or current.get("inputs", {}).get("attempt") != attempt
            or current.get("config_sha256") != config_sha256):
        raise ValueError("terminal observation requires the exact managed empty idle stop")
    health = decode(read_control(root + "idle-preflight.json"))
    if health.get("status") != "ok" or health.get("active_session") is not False:
        raise ValueError("terminal observation idle stop had a nonempty workspace")
    stopped_raw = read_control(root + "idle-stop-containers.json")
    stopped = decode(stopped_raw)
    if (hashlib.sha256(stopped_raw).hexdigest() != current.get("idle_stop_containers_sha256")
            or set(stopped) != {"backend", "frontend"} or set(actual) != set(stopped)):
        raise ValueError("terminal observation stopped services CAS differs")
    for key in stopped:
        old, now = stopped[key], actual[key]
        if (old.get("Id") != now.get("Id") or old.get("Image") != now.get("Image")
                or old.get("Config") != now.get("Config")
                or sorted(old.get("Mounts", []), key=canonical)
                != sorted(now.get("Mounts", []), key=canonical)
                or old.get("State", {}).get("StartedAt") != now.get("State", {}).get("StartedAt")
                or old.get("State", {}).get("Running") is not False
                or now.get("State", {}).get("Running") is not False):
            raise ValueError("terminal observation stopped service incarnation differs")
    drain = decode(read_control(root + "backend-drain.json"))
    process = drain.get("process_receipt", {})
    if (drain.get("schema") != "fullmag.docker-idle-restart-drain.v1"
            or drain.get("backend_container_id") != actual["backend"].get("Id")
            or process.get("state") != "drained"
            or hashlib.sha256(canonical(process) + b"\n").hexdigest() != drain.get("process_receipt_sha256")):
        raise ValueError("terminal observation idle stop native drain differs")
    return token, hashlib.sha256(current_raw).hexdigest()



def revalidate_context(control, context, *, source_root, attempt, config_sha256, actual):
    """Read-only revalidation under the caller's existing recreate lease."""
    from docker_volume_accepted_reattach import _control_bytes
    context = validate_context(context)
    if context is None:
        raise ValueError("terminal observation context is absent")
    read_control = lambda relative: _control_bytes(control, relative, maximum=8 * 1024 * 1024)
    meta = context["metadata"]
    validate_empty_stop(
        read_control, project=control.project, volume=control.volume, source_root=source_root,
        attempt=attempt, config_sha256=config_sha256, actual=actual,
        stop_pin=(meta["stop_attempt"], meta["stop_sha256"]))
    private = "runtime-control/terminal-observation/" + meta["proof_sha256"]
    proof = read_control(private + "/proof.json")
    request = read_control(private + "/request.json")
    if (hashlib.sha256(proof).hexdigest() != meta["proof_sha256"]
            or hashlib.sha256(request).hexdigest() != meta["request_sha256"]):
        raise ValueError("terminal observation private input CAS changed under recreate lease")
    expected = {"schema": "fullmag.terminal-observation-request.v1",
                "proof_path": "terminal-observation/" + meta["proof_sha256"] + "/proof.json",
                "proof_sha256": meta["proof_sha256"]}
    if decode(request) != expected:
        raise ValueError("terminal observation private request changed under recreate lease")


def prepare_context(control, *, proof_relative, proof_sha256, store_root, source_root,
                    attempt, config_sha256, actual):
    from docker_volume_accepted_reattach import _control_bytes, _read_store_regular
    read_control = lambda relative: _control_bytes(control, relative, maximum=8 * 1024 * 1024)
    if (not isinstance(proof_relative, str) or not proof_relative
            or proof_relative.startswith("/") or "\\" in proof_relative
            or any(part in {"", ".", ".."} for part in proof_relative.split("/"))
            or re.fullmatch(r"[0-9a-f]{64}", str(proof_sha256)) is None):
        raise ValueError("terminal observation source proof reference is invalid")
    raw = read_control(proof_relative)
    if hashlib.sha256(raw).hexdigest() != proof_sha256:
        raise ValueError("terminal observation source proof CAS differs")
    proof = decode(raw)
    scope = {key: proof[key] for key in ("compose_project", "control_volume", "source_root", "image_id")}
    if (scope["compose_project"] != control.project or scope["control_volume"] != control.volume
            or scope["source_root"] != source_root):
        raise ValueError("terminal observation source proof belongs to another workspace")
    rebuilt = build_proof(
        read_control,
        lambda relative: _read_store_regular(store_root, relative, "terminal observation retained record", maximum=8 * 1024 * 1024),
        iteration=proof["original_iteration"], run_id=proof["run_id"], scope=scope,
        native_config_sha256=proof["native_config_sha256"],
        terminal_evidence_sha256=proof["terminal_evidence_sha256"])
    if proof != rebuilt:
        raise ValueError("terminal observation proof differs from authoritative original records")
    stop_attempt, stop_sha256 = validate_empty_stop(
        read_control, project=control.project, volume=control.volume, source_root=source_root,
        attempt=attempt, config_sha256=config_sha256, actual=actual)
    private = "terminal-observation/" + proof_sha256
    request = {"schema": "fullmag.terminal-observation-request.v1",
               "proof_path": private + "/proof.json", "proof_sha256": proof_sha256}
    request_raw = canonical(request) + b"\n"
    request_sha = hashlib.sha256(request_raw).hexdigest()
    _publish_private_records(control, [(private + "/proof.json", raw),
                                      (private + "/request.json", request_raw)])
    return validate_context({"environment": {REQUEST_ENV: private + "/request.json", REQUEST_SHA_ENV: request_sha},
                            "metadata": {"schema": CONTEXT_SCHEMA, "proof_sha256": proof_sha256,
                                         "request_sha256": request_sha, "stop_attempt": stop_attempt,
                                         "stop_sha256": stop_sha256}})


def _publish_private_records(control, records):
    # Same managed control helper and operation mutex as other private inputs.
    # No SessionStore or native owner/admission row is written.
    import base64
    from docker_build_control import bounded_capture
    payload = []
    for relative, raw in records:
        payload.append({"path": control.path("runtime-control/" + relative),
                        "sha256": hashlib.sha256(raw).hexdigest(),
                        "base64": base64.b64encode(raw).decode("ascii")})
    script = r'''set -euo pipefail
umask 027
exec 9>/control/operation.lock
flock -n 9 || exit 73
test ! -e /control/active
test ! -L /control/active
publish() {
 path="$1"; expected="$2"; payload="$3"; parent="$(dirname "$path")"
 test ! -L "$parent"; mkdir -p "$parent"
 test "$(readlink -f "$parent")" = "$parent"; test ! -L "$path"
 if test -e "$path"; then
  test -f "$path"; test "$(stat -c %h "$path")" = 1
  test "$(sha256sum "$path" | cut -d' ' -f1)" = "$expected"; return
 fi
 tmp="$(mktemp "$parent/.observation.XXXXXXXX")"
 trap 'rm -f -- "$tmp"' EXIT
 printf '%s' "$payload" | base64 -d > "$tmp"
 test "$(sha256sum "$tmp" | cut -d' ' -f1)" = "$expected"
 sync "$tmp"; mv -T -- "$tmp" "$path"; sync "$parent"
 trap - EXIT
}
'''
    for index, record in enumerate(payload):
        script += 'publish "$OBS_PATH_' + str(index) + '" "$OBS_SHA_' + str(index) + '" "$OBS_DATA_' + str(index) + '"\n'
    script += "printf 'PUBLISHED\\n'\n"
    argv = control.helper_args(script, name="fullmag-control-observation-" + payload[0]["sha256"][:24])
    insertion = argv.index("--entrypoint")
    for index, record in enumerate(payload):
        for field, prefix in (("path", "OBS_PATH_"), ("sha256", "OBS_SHA_"), ("base64", "OBS_DATA_")):
            argv[insertion:insertion] = ["--env", prefix + str(index) + "=" + record[field]]
    result = bounded_capture(argv, data=b"", timeout=180)
    if result.returncode or result.stdout != b"PUBLISHED\n":
        raise ValueError("terminal observation private control publication failed; retained data is unchanged")
