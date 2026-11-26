"""Prepare and publish an explicitly approved recovery successor without running recovery.

Candidate documents are inert. The immutable binding is published last, only
when a native read-only preview and a controlled diagnostic stop agree with
fresh observations under the group's lifecycle lease.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
from pathlib import Path
import uuid

from docker_build_control import BuildControlError, canonical, compose_capture, docker_capture
import docker_volume_container_recovery as recovery
from docker_volume_cancelled_recovery import _verify_absent_pair

CANDIDATE_SCHEMA = "fullmag.pending-recovery-candidate.v1"
BINDING_SCHEMA = "fullmag.pending-recovery-successor.v1"
STOP_SCHEMA = "fullmag.pending-recovery-diagnostic-stop.v1"
PREVIEW_SCHEMA = "runtime_service_container_recovery_preview.v1"


def _require(condition, message):
    if not condition:
        raise BuildControlError("Pending recovery successor: " + message)


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _ref(path, raw):
    return {"path": path, "sha256": _sha(raw)}


def _raw(control, pin):
    _require(isinstance(pin, dict) and set(pin) == {"path", "sha256"}, "invalid record pin")
    path = recovery._relative_control_path(pin["path"])
    recovery._require_sha(pin["sha256"], "record digest")
    raw = recovery._control_bytes(control, path)
    _require(raw is not None and _sha(raw) == pin["sha256"], "record changed: " + path)
    return raw


def _read(control, pin):
    return recovery._parse_json(_raw(control, pin), pin["path"])


def _save(control, path, value):
    digest, raw = recovery._write_record(control, path, value)
    _require(recovery._control_bytes(control, path) == raw, "record readback differs")
    return {"path": path, "sha256": digest}


def _auth_ref(document):
    env = document["services"]["backend"]["environment"]
    path = env.get(recovery.AUTHORIZATION_ENV)
    _require(isinstance(path, str) and path.startswith(recovery.CONTROL_ROOT + "/"), "ancestor authorization missing")
    return {"path": path[len(recovery.CONTROL_ROOT) + 1:], "sha256": env.get(recovery.AUTHORIZATION_SHA_ENV)}


def _native_ref(auth, stem):
    path = auth[stem + "_path"]
    _require(path.startswith(recovery.CONTROL_ROOT + "/"), "native path escapes control")
    return {"path": path[len(recovery.CONTROL_ROOT) + 1:], "sha256": auth[stem + "_sha256"]}


def _no_completion(control, request_sha):
    path = "runtime-control/runtime-services/container-recovery/" + request_sha + "/receipt.json"
    _require(recovery._control_bytes(control, path, optional=True) is None,
             "native recovery receipt already exists; successor cannot replace an attempted mutation")


def _ancestor(control, previous, document):
    pin = _auth_ref(document)
    auth = recovery.validate_runtime_authorization(_read(control, pin))
    _require(auth["compose_project"] == control.project and auth["source_root"] == previous["inputs"]["source_root"],
             "ancestor belongs to another group or checkout")
    request_pin, attestation_pin, manifest_pin = (_native_ref(auth, stem) for stem in ("native_request", "attestation", "manifest"))
    request = recovery.validate_request(_read(control, request_pin))
    _require(request["schema_version"] == recovery.ATTEMPT_HISTORY_REQUEST_SCHEMA, "ancestor is not v5")
    recovery.validate_attestation(_read(control, attestation_pin), request, request_pin["sha256"])
    manifest = _read(control, manifest_pin)
    _validate_ancestor_manifest(manifest, request, auth, control.project)
    _require(request["docker_manifest_sha256"] == manifest_pin["sha256"], "ancestor manifest digest differs from request")
    _require([item["container_id"] for item in request["containers"]] == [auth["backend_container_id"], auth["frontend_container_id"]],
             "ancestor container identities differ")
    for key in ("request_id", "owner_sha256", "config_sha256", "launch_sha256"):
        _require(auth[key] == request[key], "ancestor authorization/request differ: " + key)
    expected = _context(pin, auth)
    _require(previous.get("container_recovery") == expected["recovery_metadata"]
             and previous.get("container_recovery_environment") == sorted(expected["recovery_environment"]),
             "ancestor is not selected by the development receipt")
    _no_completion(control, request_pin["sha256"])
    return {"authorization": pin, "request": request_pin, "attestation": attestation_pin, "manifest": manifest_pin}, auth, request



def _validate_ancestor_manifest(manifest, request, auth, project):
    _require(manifest.get("schema") == "fullmag.docker-container-recovery-manifest.v1"
             and manifest.get("request_id") == auth["request_id"]
             and manifest.get("compose_project") == project
             and manifest.get("source_root") == auth["source_root"]
             and manifest.get("docker_engine_id_sha256") == request["docker_engine_id_sha256"], "ancestor manifest identity differs")
    entries = manifest.get("containers")
    pins = {pin["service"]: pin for pin in request["containers"]}
    _require(isinstance(entries, list) and len(entries) == 2 and set(pins) == {"backend", "frontend"}, "ancestor service inventory differs")
    seen = set()
    for entry in entries:
        service = entry.get("service")
        _require(service in pins and service not in seen and entry.get("pin") == pins[service], "ancestor manifest container pin differs")
        seen.add(service)
        observed = entry.get("inspect", {})
        pin = pins[service]
        _require(observed.get("Id") == pin["container_id"] and observed.get("Image") == pin["image_id"]
                 and _sha(recovery._canonical(observed.get("Config"))) == pin["config_sha256"], "ancestor manifest inspection differs")
        _require(observed.get("State", {}).get("Running") is False
                 and observed.get("State", {}).get("Pid") == 0, "ancestor namespace was not stopped")
        if service == "backend":
            recovery._validate_owner_host(request["expected_owner"], observed)
    _require(manifest.get("prior_ready_owner_proof_sha256") == request["prior_ready_owner_proof_sha256"]
             and manifest.get("stop_journal_sha256") == auth["prior_stop_journal_sha256"], "ancestor stop provenance differs")


def _executor(control, pin, containers, *, request_schema=recovery.PENDING_INBOX_REQUEST_SCHEMA):
    executor = _read(control, pin)
    _require(set(executor) == {"schema", "container", "package_receipt", "binary", "capabilities"}
             and executor["schema"] == "fullmag.pending-recovery-executor.v1"
             and executor["container"] == containers["backend"], "executor namespace differs")
    package = _read(control, executor["package_receipt"])
    _require(package.get("schema") == "fullmag.direct-compose.backend-build-receipt.v1"
             and package.get("state") == "succeeded", "executor package was not built successfully")
    binary = executor["binary"]
    _require(isinstance(binary, dict) and set(binary) == {"path", "sha256"}
             and binary["path"] == "/opt/fullmag/package/bin/fullmag-bin", "executor is not the packaged CLI")
    recovery._require_sha(binary["sha256"], "executor binary")
    artifacts = [entry for entry in package.get("artifacts", []) if entry.get("path") == "bin/fullmag-bin"]
    _require(len(artifacts) == 1 and artifacts[0].get("sha256") == binary["sha256"], "executor binary differs from package")
    capabilities = _read(control, executor["capabilities"])
    _require(capabilities.get("schema_version") == "runtime_service_container_recovery_capabilities.v1"
             and set(capabilities) == {"schema_version", "supported_recovery_schemas", "build_identity"}
             and request_schema in capabilities.get("supported_recovery_schemas", []), "executor lacks requested recovery capability")
    identity, source = capabilities.get("build_identity", {}), package.get("source", {})
    _require(identity.get("git_commit") == source.get("resolved_commit")
             and identity.get("source_snapshot_sha256") == source.get("source_snapshot_sha256")
             and isinstance(source.get("resolved_commit"), str) and len(source["resolved_commit"]) == 40,
             "executor capability build differs from package")
    recovery._require_sha(source.get("source_snapshot_sha256"), "executor snapshot")
    return executor, identity


def _context(pin, auth):
    return {
        "recovery_environment": {recovery.AUTHORIZATION_ENV: recovery.CONTROL_ROOT + "/" + pin["path"],
                                 recovery.AUTHORIZATION_SHA_ENV: pin["sha256"]},
        "recovery_metadata": {"schema": "fullmag.container-recovery.v1", "request_id": auth["request_id"],
                              "request_sha256": auth["native_request_sha256"],
                              "attestation_sha256": auth["attestation_sha256"], "manifest_sha256": auth["manifest_sha256"],
                              "authorization_sha256": pin["sha256"], "stop_journal_sha256": auth["prior_stop_journal_sha256"],
                              "removed_container_ids": [auth["backend_container_id"], auth["frontend_container_id"]]},
    }


def _identity(container):
    return {"id": container["Id"], "image_id": container["Image"], "started_at": container["State"]["StartedAt"]}


def _protected(control, request):
    owner, _, owner_sha = recovery._runtime_owner(control)
    _, _, launch_sha = recovery._runtime_launch(control)
    _, _, config_sha = recovery._runtime_config(control)
    process, _, process_sha = recovery._runtime_process_receipt(control, abrupt=True)
    recovery._validate_process_receipt_owner(process, owner)
    for key, value in (("owner", owner_sha), ("launch", launch_sha), ("config", config_sha)):
        _require(value == request[key + "_sha256"], "historical " + key + " changed")
    _require(owner == request["expected_owner"], "historical owner changed")
    _require(recovery._application_pin(control, config_sha) == request["application"], "application changed")
    return {"owner": owner_sha, "launch": launch_sha, "config": config_sha, "process_receipt": process_sha}


def _inspect(identifier):
    rows = json.loads(docker_capture("inspect", identifier, timeout=60).stdout)
    _require(isinstance(rows, list) and len(rows) == 1 and rows[0].get("Id") == identifier, "ambiguous container inspect")
    return rows[0]



def _stable_service_observation(container):
    observation = copy.deepcopy(recovery._stable_container_observation(container))
    # ExecIDs is transient Docker exec/healthcheck bookkeeping, not process
    # quiescence evidence; native preview and the controlled-stop probe own that.
    observation.pop("ExecIDs", None)
    health = observation.get("State", {}).get("Health")
    if isinstance(health, dict):
        # Healthcheck history appends asynchronously; retain status, failure
        # count and every other inspection field as incarnation fences.
        health.pop("Log", None)
    return observation


def _service_ids(document):
    # Same retained Compose discovery used by docker_volume_dev. A failed
    # development receipt may legitimately omit successful-start container IDs.
    identifiers = {}
    for service in ("backend", "frontend"):
        identifier = compose_capture(document, "ps", "--all", "--quiet", service).decode().strip()
        recovery._require_container(identifier, "retained " + service)
        identifiers[service] = identifier
    _require(len(set(identifiers.values())) == 2, "Compose discovery repeats a service ID")
    return identifiers


def _services(control, previous, document, actual, *, removed_container_proof=None):
    import docker_volume_dev as dev
    _require(document.get("name") == control.project and _sha(canonical(document)) == previous.get("config_sha256"),
             "development Compose configuration changed")
    discovered = _service_ids(document) if removed_container_proof is None else None
    for service in ("backend", "frontend"):
        value = actual[service]
        recorded_id = previous.get(service + "_container")
        _require(recorded_id is None or value["Id"] == recorded_id, "development service replaced")
        _require(discovered is None or value["Id"] == discovered[service], "Compose service identity changed")
        _require(value.get("Image") == document["services"][service].get("image")
                 and value.get("Config", {}).get("Labels", {}).get("com.docker.compose.service") == service,
                 "retained service image or role differs")
        recorded_start = previous.get(service + "_started_at")
        _require(recorded_start is None or value.get("State", {}).get("StartedAt") == recorded_start,
                 "recorded service incarnation changed")
        _require(value.get("Config", {}).get("Labels", {}).get("com.docker.compose.project") == control.project,
                 "service belongs to another group")
        if removed_container_proof is None:
            current = _inspect(value["Id"])
            _require(_stable_service_observation(current) == _stable_service_observation(value),
                     "service changed since observation")
        image = json.loads(docker_capture("image", "inspect", value["Image"], timeout=60).stdout)
        _require(len(image) == 1 and image[0].get("Id") == value["Image"], "image identity changed")
        dev._validate_retained_service(document, value, service, image[0]["Config"])
    recovery._assert_no_foreign_storage_consumers(control, actual["backend"], actual["frontend"], document)


def _observe(control, previous, document, actual, pending, *, retained_absent_inboxes=None, removed_container_proof=None):
    ancestor, auth, request = _ancestor(control, previous, document)
    _services(control, previous, document, actual, removed_container_proof=removed_container_proof)
    protected = _protected(control, request)
    engine = recovery._docker_engine_sha()
    _require(engine == request["docker_engine_id_sha256"], "Docker engine changed")
    absence = _verify_absent_pair(request["containers"])
    snapshot = recovery._ledger_and_store_snapshot(
        control, actual["backend"], compose=document,
        retained_terminal_runs=request["retained_terminal_runs"],
        retained_held_manual_runs=request["retained_held_manual_runs"],
        retained_attempt_histories=request["retained_attempt_histories"], retained_pending_inboxes=pending,
        **({"retained_absent_inboxes": retained_absent_inboxes} if retained_absent_inboxes is not None else {}))
    for key in ("store_root_sha256", "ledger_root_sha256", "ledger_snapshot_sha256"):
        _require(snapshot[key] == request[key], "ancestor storage changed: " + key)
    _require(recovery._docker_engine_sha() == engine, "Docker engine changed during observation")
    return {"ancestor": ancestor, "protected_sha256": protected, "storage_proof": snapshot,
            "original_absence": absence, "containers": {service: _identity(actual[service]) for service in ("backend", "frontend")}}, auth, request


def prepare(control, previous, document, actual, pending_inboxes, *, executor_pin, retained_absent_inboxes=None, request_id=None, publish=False):
    """Create inert documents; the runtime authorization is deliberately absent."""
    request_id = request_id or str(uuid.uuid4())
    _require(isinstance(request_id, str) and recovery.REQUEST_ID_RE.fullmatch(request_id), "invalid new UUID")
    schema = (recovery.ABSENT_INBOX_REQUEST_SCHEMA if retained_absent_inboxes is not None
              else recovery.PENDING_INBOX_REQUEST_SCHEMA)
    absent_options = {"retained_absent_inboxes": retained_absent_inboxes} if retained_absent_inboxes is not None else {}
    observation, auth, old_request = _observe(control, previous, document, actual, pending_inboxes, **absent_options)
    _executor(control, executor_pin, observation["containers"], request_schema=schema)
    _require(request_id != old_request["request_id"], "successor must have a new UUID")
    root = recovery.RECOVERY_RELATIVE_ROOT + "/" + request_id
    _require(recovery._control_bytes(control, root + "/authorization.json", optional=True) is None,
             "candidate already has authority")
    manifest = {"schema": "fullmag.pending-recovery-manifest.v1", "request_id": request_id,
                "development_attempt": previous["attempt"], "compose_config_sha256": previous["config_sha256"],
                "observation": observation}
    request = {**copy.deepcopy(old_request), "schema_version": schema,
               **copy.deepcopy(absent_options), "request_id": request_id, "retained_pending_inboxes": copy.deepcopy(pending_inboxes),
               "docker_manifest_sha256": _sha(recovery._canonical(manifest))}
    recovery.validate_request(request)
    request_sha = _sha(recovery._canonical(request))
    device = {"resource_id": request["device_release_resource_id"],
              "mapping_sha256": request["device_release_mapping_sha256"], "mapping_detached": True}
    if request.get("device_release_gpu_uuid") is not None:
        device["gpu_uuid"] = request["device_release_gpu_uuid"]
    attestation = recovery.validate_attestation({
        "schema_version": recovery.ABSENCE_ATTESTATION_SCHEMA, "request_sha256": request_sha,
        "docker_engine_id_sha256": request["docker_engine_id_sha256"],
        "containers": observation["original_absence"], "device_release": device,
        "manifest_sha256": request["docker_manifest_sha256"], "result": "authoritative_namespace_absence",
    }, request, request_sha)
    candidate = {"schema": CANDIDATE_SCHEMA, "development_attempt": previous["attempt"],
                 "compose_config_sha256": previous["config_sha256"], "observation": observation, "executor": executor_pin,
                 **{name: _ref(root + "/" + name + ".json", recovery._canonical(value))
                    for name, value in (("request", request), ("manifest", manifest), ("attestation", attestation))}}
    if publish:
        with control.operation("pending-recovery-candidate", {"attempt": previous["attempt"],
                "config_sha256": previous["config_sha256"], "request_id": request_id}) as operation:
            fresh, _, _ = _observe(control, previous, document, actual, pending_inboxes, **absent_options)
            _executor(control, executor_pin, fresh["containers"], request_schema=schema)
            _require(fresh == observation, "candidate evidence changed under the lifecycle lease")
            for name, value in (("manifest", manifest), ("request", request), ("attestation", attestation)):
                _save(control, root + "/" + name + ".json", value)
            candidate_pin = _save(control, root + "/candidate.json", candidate)
            operation["receipt"].update(state="succeeded", candidate=candidate_pin)
    else:
        candidate_pin = _ref(root + "/candidate.json", recovery._canonical(candidate))
    return {"candidate": candidate_pin, "request": candidate["request"], "attestation": candidate["attestation"],
            "state": "candidate-published" if publish else "validated-read-only", "compute_started": False}


def _preview(control, pin, candidate, request, candidate_pin):
    from docker_volume_drained_successor import _operation
    execution = _read(control, pin)
    _require(set(execution) == {"schema", "executor", "candidate", "argv", "exit_code", "stdout", "binary_sha256_before", "binary_sha256_after", "operation"}
             and execution["schema"] == "fullmag.pending-recovery-preview-execution.v1"
             and execution["executor"] == candidate["executor"] and execution["candidate"] == candidate_pin
             and type(execution["exit_code"]) is int and execution["exit_code"] == 0, "preview execution differs")
    executor, identity = _executor(control, candidate["executor"], candidate["observation"]["containers"], request_schema=request["schema_version"])
    _require(execution["binary_sha256_before"] == executor["binary"]["sha256"]
             and execution["binary_sha256_after"] == executor["binary"]["sha256"], "preview executable changed")
    expected_argv = [executor["binary"]["path"], "runtime", "service-preview-container-recovery",
                     "--config", "/opt/fullmag/runtime-control/runtime-service/docker-all.json",
                     "--request", recovery.CONTROL_ROOT + "/" + candidate["request"]["path"],
                     "--request-sha256", candidate["request"]["sha256"],
                     "--attestation", recovery.CONTROL_ROOT + "/" + candidate["attestation"]["path"],
                     "--attestation-sha256", candidate["attestation"]["sha256"]]
    _require(execution["argv"] == expected_argv, "preview command is not the exact read-only operation")
    op = execution["operation"]
    _require(isinstance(op, dict) and set(op) == {"attempt"}
             and isinstance(op["attempt"], str) and recovery.ATTEMPT_RE.fullmatch(op["attempt"]), "preview operation identity differs")
    terminal_path = "pending-recovery-preview/attempts/" + op["attempt"] + "/terminal.json"
    terminal_raw = recovery._control_bytes(control, terminal_path)
    _require(terminal_raw is not None, "preview operation has no terminal")
    _, terminal = _operation(control, "pending-recovery-preview", {"attempt": op["attempt"], "terminal_sha256": _sha(terminal_raw)},
                             {"attempt": candidate["development_attempt"]}, candidate["compose_config_sha256"])
    _require(terminal.get("preview_execution") == pin and terminal.get("inputs", {}).get("candidate") == candidate_pin
             and terminal.get("inputs", {}).get("executor") == candidate["executor"], "preview execution is not bound by its successful operation")
    preview = _read(control, execution["stdout"])
    _require(preview.get("schema_version") == PREVIEW_SCHEMA and preview.get("status") == "validated",
             "native preview did not validate")
    for key in ("config_sha256", "owner_sha256", "launch_sha256", "ledger_snapshot_sha256"):
        _require(preview.get(key) == request[key], "preview differs: " + key)
    _require(preview.get("request_sha256") == candidate["request"]["sha256"]
             and preview.get("attestation_sha256") == candidate["attestation"]["sha256"]
             and preview.get("expected_outcome") == recovery.expected_recovery_outcome(request), "preview targets another request")
    _require(preview.get("executor_build_commit") == identity["git_commit"]
             and preview.get("executor_build_snapshot") == identity["source_snapshot_sha256"],
             "native preview lacks executor provenance")
    return preview


def _stop(control, pin, candidate, previous, actual, *, removed_container_proof=None):
    from docker_volume_drained_successor import _operation
    witness = _read(control, pin)
    _require(witness.get("schema") == STOP_SCHEMA and witness.get("development_attempt") == previous["attempt"]
             and witness.get("compose_config_sha256") == previous["config_sha256"], "stop witness targets another development")
    operation = witness.get("operation", {})
    _require(operation.get("phase") == "pending-diagnostic-stop", "stop phase differs")
    base, terminal = _operation(control, operation["phase"],
                               {key: operation[key] for key in ("attempt", "terminal_sha256")},
                               previous, previous["config_sha256"])
    result = _read(control, witness["result"])
    _require(terminal.get("diagnostic_stop_result") == witness["result"], "stop result is not bound by terminal receipt")
    for key in ("backend_before", "backend_after", "frontend", "protected_sha256", "preview", "probe"):
        _require(result.get(key) == witness.get(key), "stop result differs from witness: " + key)
    _read(control, witness["preview"])
    _raw(control, witness["probe"])
    _require(witness["result"]["path"] == base + "/result.json"
             and result.get("state") == "stopped-confirmed" and result.get("exit_code") == 0
             and result.get("operation_attempt") == operation["attempt"]
             and result.get("frontend_preserved") is True and result.get("history_preserved") is True
             and result.get("solve_started") is False, "controlled stop result is incomplete")
    before = candidate["observation"]["containers"]
    _require(witness.get("backend_before") == before["backend"] and witness.get("frontend") == before["frontend"]
             and witness.get("protected_sha256") == candidate["observation"]["protected_sha256"], "stop incarnation/protected records differ")
    after = witness.get("backend_after", {})
    _require(all(after.get(key) == value for key, value in before["backend"].items())
             and after.get("status") == "exited" and after.get("running") is False and after.get("pid") == 0
             and after.get("exit_code") == 0 and after.get("oom_killed") is False
             and isinstance(after.get("finished_at"), str) and after["finished_at"], "backend was not cleanly stopped")
    _require(result.get("backend_id") == before["backend"]["id"], "stop result backend differs")
    for service in ("backend", "frontend"):
        _require(_identity(actual[service]) == before[service], "current namespace differs from stopped namespace")
    state = actual["backend"]["State"]
    _require(state.get("Status") == "exited" and state.get("Running") is False and state.get("Pid") == 0
             and state.get("ExitCode") == 0 and state.get("OOMKilled") is False
             and state.get("FinishedAt") == after["finished_at"], "backend stop observation changed")
    if removed_container_proof is not None:
        proof = removed_container_proof
        _require(proof.get("schema") == "fullmag.docker-removed-recreation-container.v1"
                 and proof.get("container_id") == before["backend"]["id"]
                 and proof.get("frontend_container") == before["frontend"]["id"]
                 and proof.get("image_id") == before["backend"]["image_id"], "removed recreation namespace differs")
        for service in ("backend", "frontend"):
            from docker_volume_cancelled_recovery import _absence_observation
            _absence_observation(before[service]["id"])
    return witness


def _validate_evidence(control, previous, document, actual, binding, *, removed_container_proof=None):
    _require(set(binding) == {"schema", "candidate", "preview", "stop_witness", "authorization",
                             "development_attempt", "compose_config_sha256"}
             and binding["schema"] == BINDING_SCHEMA, "binding fields differ")
    _require(binding["development_attempt"] == previous["attempt"]
             and binding["compose_config_sha256"] == previous["config_sha256"], "binding development differs")
    candidate = _read(control, binding["candidate"])
    _require(set(candidate) == {"schema", "development_attempt", "compose_config_sha256", "observation", "request", "manifest", "attestation", "executor"}
             and candidate.get("schema") == CANDIDATE_SCHEMA and candidate.get("development_attempt") == previous["attempt"]
             and candidate.get("compose_config_sha256") == previous["config_sha256"], "candidate development differs")
    request = recovery.validate_request(_read(control, candidate["request"]))
    _require(request["schema_version"] in {recovery.PENDING_INBOX_REQUEST_SCHEMA, recovery.ABSENT_INBOX_REQUEST_SCHEMA},
             "candidate is not an approved v6/v7 request")
    absent_options = ({"retained_absent_inboxes": request["retained_absent_inboxes"]}
                      if request["schema_version"] == recovery.ABSENT_INBOX_REQUEST_SCHEMA else {})
    recovery.validate_attestation(_read(control, candidate["attestation"]), request, candidate["request"]["sha256"])
    manifest = _read(control, candidate["manifest"])
    _require(set(manifest) == {"schema", "request_id", "development_attempt", "compose_config_sha256", "observation"}
             and manifest.get("schema") == "fullmag.pending-recovery-manifest.v1"
             and manifest.get("request_id") == request["request_id"]
             and manifest.get("development_attempt") == previous["attempt"]
             and manifest.get("compose_config_sha256") == previous["config_sha256"]
             and candidate["manifest"]["sha256"] == request["docker_manifest_sha256"]
             and manifest.get("observation") == candidate["observation"], "manifest does not bind candidate")
    fresh, ancestor_auth, ancestor_request = _observe(control, previous, document, actual, request["retained_pending_inboxes"],
                                                     **absent_options, removed_container_proof=removed_container_proof)
    _require(fresh == candidate["observation"], "candidate evidence changed before authorization")
    expected = {**ancestor_request, "schema_version": request["schema_version"], **absent_options,
                "request_id": request["request_id"], "retained_pending_inboxes": request["retained_pending_inboxes"],
                "docker_manifest_sha256": request["docker_manifest_sha256"]}
    _require(request == expected and request["request_id"] != ancestor_request["request_id"], "successor changed ancestor semantics")
    _no_completion(control, candidate["request"]["sha256"])
    _preview(control, binding["preview"], candidate, request, binding["candidate"])
    _stop(control, binding["stop_witness"], candidate, previous, actual, removed_container_proof=removed_container_proof)
    return candidate, ancestor_auth, request


def _authorization(candidate, ancestor, request, binding):
    # Existing runtime schema stays unchanged. The separate binding is the host
    # authority for selecting this successor, while PID 1 revalidates v6.
    return recovery.validate_runtime_authorization({
        **ancestor, "request_id": request["request_id"],
        "operator_authorization_sha256": binding["candidate"]["sha256"],
        **{stem + suffix: (recovery.CONTROL_ROOT + "/" + candidate[name]["path"] if suffix == "_path" else candidate[name]["sha256"])
           for stem, name in (("native_request", "request"), ("attestation", "attestation"), ("manifest", "manifest"))
           for suffix in ("_path", "_sha256")},
    })


def validate_published(control, previous, document, actual, binding, *, removed_container_proof=None):
    candidate, ancestor, request = _validate_evidence(control, previous, document, actual, binding,
                                                       removed_container_proof=removed_container_proof)
    authorization = recovery.validate_runtime_authorization(_read(control, binding["authorization"]))
    _require(authorization == _authorization(candidate, ancestor, request, binding), "published authorization differs")
    return _context(binding["authorization"], authorization)


def publish(control, previous, document, actual, candidate_pin, preview_pin, stop_pin):
    candidate = _read(control, candidate_pin)
    request = _read(control, candidate["request"])
    path = recovery.RECOVERY_RELATIVE_ROOT + "/" + request["request_id"] + "/authorization.json"
    binding = {"schema": BINDING_SCHEMA, "candidate": candidate_pin, "preview": preview_pin, "stop_witness": stop_pin,
               "authorization": {"path": path, "sha256": "0" * 64},
               "development_attempt": previous["attempt"], "compose_config_sha256": previous["config_sha256"]}
    with control.operation("pending-recovery-publication", {"attempt": previous["attempt"],
            "config_sha256": previous["config_sha256"], "candidate": candidate_pin}) as operation:
        candidate, ancestor, request = _validate_evidence(control, previous, document, actual, binding)
        auth = _authorization(candidate, ancestor, request, binding)
        binding["authorization"] = _save(control, path, auth)
        # The selector is written last; partial documents cannot select new authority.
        validate_published(control, previous, document, actual, binding)
        result = _save(control, path.rsplit("/", 1)[0] + "/successor.json", binding)
        operation["receipt"].update(state="succeeded", successor=result)
    return {"binding": result, "state": "published-awaiting-explicit-recreate", "compute_started": False}


def main(argv=None):
    from docker_build_control import BuildControl, toolchain_configuration
    from docker_compose_identity import compose_project_identity
    from docker_development_inputs import select_checkout
    import fullmag_storage as storage
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--development-attempt", required=True)
    parser.add_argument("--config-sha256", required=True)
    parser.add_argument("--pending-inboxes", type=Path)
    parser.add_argument("--absent-inboxes", type=Path)
    parser.add_argument("--request-id")
    for name in ("candidate", "preview", "stop-witness", "executor"):
        parser.add_argument("--" + name + "-path")
        parser.add_argument("--" + name + "-sha256")
    parser.add_argument("--publish", action="store_true")
    args = parser.parse_args(argv)
    selected = select_checkout(args.repo_root.resolve(strict=True), args.source_root).resolve(strict=True)
    identity = compose_project_identity(storage.resolve_layout(selected))
    configured = toolchain_configuration(selected, identity)
    control = BuildControl(identity, configured["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"])
    _require(recovery.ATTEMPT_RE.fullmatch(args.development_attempt), "invalid development attempt")
    recovery._require_sha(args.config_sha256, "Compose configuration")
    root = "development/attempts/" + args.development_attempt
    previous, _ = recovery._control_json(control, root + "/terminal.json")
    document, _ = recovery._control_json(control, root + "/compose.json")
    _require(previous.get("attempt") == args.development_attempt
             and previous.get("config_sha256") == args.config_sha256
             and previous.get("inputs", {}).get("source_root") == str(selected)
             and previous.get("compose_project") == control.project,
             "selected development identity differs")
    actual = {service: _inspect(identifier) for service, identifier in _service_ids(document).items()}
    final_pins = []
    for name in ("candidate", "preview", "stop_witness"):
        path, digest = getattr(args, name + "_path"), getattr(args, name + "_sha256")
        _require(bool(path) == bool(digest), "paired publication pins required")
        final_pins.append({"path": path, "sha256": digest} if path else None)
    if any(final_pins):
        _require(all(final_pins) and args.pending_inboxes is None and args.absent_inboxes is None and args.request_id is None,
                 "publication requires only candidate, preview and stop witness")
        _require(args.publish, "final publication requires --publish")
        result = publish(control, previous, document, actual, *final_pins)
    else:
        _require(args.pending_inboxes is not None, "candidate requires pending-inbox pins")
        from docker_volume_dev import _session_host
        raw = _session_host().read_owned_regular(args.pending_inboxes.absolute(), 1024 * 1024)
        pending = json.loads(raw, object_pairs_hook=recovery._reject_duplicate_keys)
        _require(args.executor_path is not None and args.executor_sha256 is not None, "candidate requires executor pins")
        absent_options = {}
        if args.absent_inboxes is not None:
            absent_raw = _session_host().read_owned_regular(args.absent_inboxes.absolute(), 1024 * 1024)
            absent_options["retained_absent_inboxes"] = json.loads(absent_raw, object_pairs_hook=recovery._reject_duplicate_keys)
        result = prepare(control, previous, document, actual, pending, **absent_options, executor_pin={"path": args.executor_path, "sha256": args.executor_sha256},
                         request_id=args.request_id, publish=args.publish)
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (BuildControlError, recovery.ContainerRecoveryError, ValueError, OSError) as error:
        raise SystemExit("Pending recovery successor refused: " + str(error))
