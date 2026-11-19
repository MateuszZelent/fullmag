"""Authenticate a diagnostic bootstrap stop without inventing a runtime owner.

This is read-only evidence handling. It neither stops services nor edits the
native owner, process receipt, store, or ledger. Container recovery remains
responsible for its normal stopped-pair, storage and destructive-boundary gates.
"""
from __future__ import annotations

from collections.abc import Mapping
import hashlib
import json

from docker_build_control import BuildControlError, canonical
import docker_volume_stop_bootstrap as stop


SCHEMA = "fullmag.docker-bootstrap-stop-recovery-evidence.v1"
HISTORICAL_SCHEMA = "fullmag.docker-bootstrap-stop-recovery-evidence.v2"
NAMESPACE_SCHEMA = "fullmag.docker-bootstrap-historical-namespace-absence.v1"


def _need(condition, message):
    if not condition:
        raise BuildControlError("Bootstrap recovery evidence: " + message)


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _paths(attempt, resume, development, fence):
    root = "stop-bootstrap/attempts/" + attempt
    return {
        "stop": root + "/stop-bootstrap-terminal.json",
        "operation": root + "/terminal.json",
        "preflight": root + "/stop-bootstrap-preflight.json",
        "resume": "resume/attempts/" + resume + "/terminal.json",
        "before_process": "resume/attempts/" + resume + "/process-failure.json",
        "development": "development/attempts/" + development + "/terminal.json",
        "compose": "development/attempts/" + development + "/compose.json",
        "fence": stop._runtime_relative(fence),
    }


def collect(control, reference, *, historical_namespace_reference=None):
    """Freeze an explicitly selected successful stop; never discover a latest one."""
    _need(isinstance(reference, Mapping) and set(reference) == {"attempt", "sha256"},
          "reference must pin the stop attempt and raw terminal digest")
    attempt = reference["attempt"]
    _need(isinstance(attempt, str) and stop.ATTEMPT_RE.fullmatch(attempt), "invalid stop attempt")
    _need(isinstance(reference["sha256"], str) and stop.SHA256_RE.fullmatch(reference["sha256"]),
          "invalid stop terminal digest")
    terminal_raw = stop._read_raw(control, "stop-bootstrap/attempts/" + attempt + "/stop-bootstrap-terminal.json")
    _need(_sha(terminal_raw) == reference["sha256"], "selected stop terminal changed")
    terminal = stop._json(terminal_raw, "bootstrap stop")
    for key in ("attempt", "resume_attempt"):
        _need(isinstance(terminal.get(key), str) and stop.ATTEMPT_RE.fullmatch(terminal[key]),
              "invalid " + key)
    before_raw = stop._read_raw(control, "resume/attempts/" + terminal["resume_attempt"] + "/process-failure.json")
    before = stop._json(before_raw, "bootstrap failed process")
    paths = _paths(attempt, terminal["resume_attempt"], terminal["attempt"], before.get("api_failure_fence"))
    records = {}
    for key, path in paths.items():
        raw = stop._read_raw(control, path)
        records[key] = {"path": path, "raw_utf8": raw.decode("utf-8"), "sha256": _sha(raw)}
    _need(records["stop"]["sha256"] == reference["sha256"], "stop changed during collection")
    evidence = {"schema": SCHEMA, "reference": dict(reference), "records": records}
    if historical_namespace_reference is not None:
        ref = historical_namespace_reference
        _need(isinstance(ref, Mapping) and set(ref) == {"path", "sha256"}, "invalid historical namespace reference")
        from docker_volume_container_recovery import _relative_control_path
        path = _relative_control_path(ref["path"])
        raw = stop._read_raw(control, path)
        _need(_sha(raw) == ref["sha256"], "historical namespace proof bytes changed")
        evidence.update(schema=HISTORICAL_SCHEMA, historical_namespace_absence={
            "path": path, "raw_utf8": raw.decode("utf-8"), "sha256": _sha(raw)})
    return evidence


def _observe_namespace_absence(hostname, identifiers):
    """Observe engine-wide hostname non-reuse, never signal or remove a PID."""
    from docker_build_control import docker_capture
    from docker_volume_container_recovery import _assert_container_absent, _docker_engine_sha
    engine = _docker_engine_sha()
    for identifier in identifiers:
        _assert_container_absent(identifier)
    def listing():
        raw = docker_capture("ps", "--all", "--no-trunc", "--format", "{{.ID}}", timeout=60).stdout
        values = sorted(raw.decode("utf-8").splitlines())
        _need(len(values) <= 4096 and len(set(values)) == len(values)
              and all(stop.CONTAINER_RE.fullmatch(item) for item in values), "invalid hostname absence inventory")
        return values
    ids = listing()
    _need(not set(identifiers).intersection(ids), "historical predecessor is still present")
    if ids:
        rows = json.loads(docker_capture("inspect", *ids, timeout=90).stdout)
        _need(isinstance(rows, list) and {row.get("Id") for row in rows} == set(ids), "hostname inspection inventory changed")
        _need(all(isinstance(row.get("Config"), Mapping) and
                  isinstance(row["Config"].get("Hostname"), str) and
                  row["Config"]["Hostname"] != hostname for row in rows), "historical owner hostname is reused")
    _need(listing() == ids and _docker_engine_sha() == engine, "engine inventory changed during namespace observation")
    return {"docker_engine_id_sha256": engine, "historical_container_ids_absent": sorted(identifiers),
            "historical_hostname": hostname, "hostname_reused": False}


def prepare_historical_namespace_absence(control, *, bootstrap_stop_reference,
                                        original_development_attempt, recreations):
    """Read-only new proof: absent historical namespace, not historical PID/drain.

    Recreation records are explicitly selected observed documents; this proof
    does not invent digest backlinks or claim an earlier observation of OWNER.
    Publish the returned document under a new BuildControl operation.
    """
    _need(isinstance(recreations, list) and 1 <= len(recreations) <= 16,
          "historical namespace requires a bounded explicit recreation chain")
    evidence = collect(control, bootstrap_stop_reference)
    terminal = json.loads(evidence["records"]["stop"]["raw_utf8"])
    records = {}
    def record(path):
        raw = stop._read_raw(control, path)
        records[path] = {"raw_utf8": raw.decode("utf-8"), "sha256": _sha(raw)}
        return json.loads(raw)
    runtime = {key: record("runtime-control/" + path) for key, path in (
        ("owner", "runtime-services/OWNER.json"), ("process", "runtime-service/process-tree.json"))}
    original = original_development_attempt
    _need(isinstance(original, str) and stop.ATTEMPT_RE.fullmatch(original), "invalid original development")
    development = record(f"development/attempts/{original}/terminal.json")
    record(f"development/attempts/{original}/compose.json")
    record(f"development/attempts/{original}/backend-build-receipt.json")
    for link in recreations:
        _need(isinstance(link, Mapping) and set(link) == {"attempt", "successor_development_attempt"}
              and all(isinstance(value, str) and stop.ATTEMPT_RE.fullmatch(value) for value in link.values()), "invalid recreation selection")
        record(f"recreate-services/attempts/{link['attempt']}/terminal.json")
        record(f"recreate-services/attempts/{link['attempt']}/retained-containers.json")
        successor = link["successor_development_attempt"]
        record(f"development/attempts/{successor}/terminal.json")
        record(f"development/attempts/{successor}/compose.json")
    absent = [development["backend_container"], development["frontend_container"]]
    for link in recreations[:-1]:
        item = json.loads(records[f"development/attempts/{link['successor_development_attempt']}/terminal.json"]["raw_utf8"])
        absent.extend([item["backend_container"], item["frontend_container"]])
    proof = {"schema": NAMESPACE_SCHEMA, "claim": "historical_namespace_absent",
        "historical_process_observation": "unknown", "native_drain_claimed": False,
        "bootstrap_stop_reference": dict(bootstrap_stop_reference),
        "original_development_attempt": original, "recreations": [dict(link) for link in recreations],
        "current_development_attempt": terminal["attempt"], "source_root": terminal["source_root"],
        "compose_project": terminal["compose_project"], "control_volume": control.volume,
        "control_namespace": control.namespace or None, "records": records,
        "absence": _observe_namespace_absence(runtime["owner"]["host"], absent)}
    from docker_build_control import docker_capture
    rows = json.loads(docker_capture("inspect", terminal["backend_container_id"], timeout=90).stdout)
    _need(isinstance(rows, list) and len(rows) == 1, "current diagnostic backend observation missing")
    raw = canonical(proof)
    _need(len(raw) <= 16 * 1024**2, "historical namespace proof exceeds its byte bound")
    runtime_records = {key: {"raw_utf8": records[path]["raw_utf8"]} for key, path in (
        ("owner", "runtime-control/runtime-services/OWNER.json"),
        ("process_receipt", "runtime-control/runtime-service/process-tree.json"))}
    pins = {"development_attempt": terminal["attempt"], "source_root": terminal["source_root"],
        "compose_project": terminal["compose_project"], "backend_container_id": terminal["backend_container_id"],
        "frontend_container_id": terminal["frontend_container_id"],
        "compose_config_sha256": terminal["config_sha256"],
        "owner_sha256": records["runtime-control/runtime-services/OWNER.json"]["sha256"],
        "process_receipt_sha256": records["runtime-control/runtime-service/process-tree.json"]["sha256"]}
    validate_owner_namespace({**evidence, "schema": HISTORICAL_SCHEMA, "historical_namespace_absence": {
        "path": "verification/not-yet-published.json", "raw_utf8": raw.decode(), "sha256": _sha(raw)}},
        pins, runtime_records, rows[0])
    for path, value in records.items():
        _need(_sha(stop._read_raw(control, path)) == value["sha256"], "historical namespace input changed during preparation")
    return proof


def validate_owner_namespace(evidence, pins, runtime_records, backend, *, control=None):
    try:
        return _validate_owner_namespace(evidence, pins, runtime_records, backend, control=control)
    except (KeyError, TypeError, ValueError, AttributeError, UnicodeError) as error:
        _need(False, "malformed historical namespace proof: " + str(error))


def _validate_owner_namespace(evidence, pins, runtime_records, backend, *, control=None):
    """Keep normal hostname binding; allow only the explicit bootstrap variant."""
    from docker_volume_container_recovery import _validate_owner_host
    owner = json.loads(runtime_records["owner"]["raw_utf8"])
    if evidence.get("schema") != HISTORICAL_SCHEMA:
        _validate_owner_host(owner, backend)
        return
    item = evidence.get("historical_namespace_absence")
    _need(isinstance(item, Mapping) and set(item) == {"path", "raw_utf8", "sha256"}, "invalid namespace proof envelope")
    raw = item["raw_utf8"].encode("utf-8")
    _need(len(raw) <= 16 * 1024**2 and _sha(raw) == item["sha256"], "historical namespace proof digest differs")
    if control is not None:
        _need(stop._read_raw(control, item["path"]) == raw, "historical namespace proof changed")
    proof = json.loads(raw)
    _need(proof.get("schema") == NAMESPACE_SCHEMA and proof.get("claim") == "historical_namespace_absent"
          and proof.get("historical_process_observation") == "unknown" and proof.get("native_drain_claimed") is False,
          "namespace proof must not claim historical process observation or drain")
    _need(backend.get("Id") == pins["backend_container_id"], "historical namespace backend differs")
    _need(proof.get("bootstrap_stop_reference") == evidence["reference"]
          and proof.get("current_development_attempt") == pins["development_attempt"]
          and proof.get("source_root") == pins["source_root"]
          and proof.get("compose_project") == pins["compose_project"], "historical namespace target differs")
    if control is not None:
        _need(proof.get("control_volume") == control.volume and proof.get("control_namespace") == (control.namespace or None), "historical namespace control differs")
    records = proof.get("records")
    _need(isinstance(records, Mapping), "historical namespace records missing")
    used = set()
    def record(path):
        used.add(path)
        value = records.get(path)
        _need(isinstance(value, Mapping) and set(value) == {"raw_utf8", "sha256"}, "missing historical record: " + path)
        raw_record = value["raw_utf8"].encode("utf-8")
        _need(len(raw_record) <= 8 * 1024**2 and _sha(raw_record) == value["sha256"], "historical record digest differs")
        if control is not None:
            _need(stop._read_raw(control, path) == raw_record, "historical record changed: " + path)
        return json.loads(raw_record)
    for key, path in (("owner", "runtime-services/OWNER.json"), ("process_receipt", "runtime-service/process-tree.json")):
        value = record("runtime-control/" + path)
        _need(value == json.loads(runtime_records[key]["raw_utf8"])
              and records["runtime-control/" + path]["sha256"] == pins[key + "_sha256"], "current owner/process pin differs")
    original = proof.get("original_development_attempt")
    _need(isinstance(original, str) and stop.ATTEMPT_RE.fullmatch(original), "invalid historical original attempt")
    project, source = pins["compose_project"], pins["source_root"]
    def development(attempt):
        terminal = record(f"development/attempts/{attempt}/terminal.json")
        compose = record(f"development/attempts/{attempt}/compose.json")
        _need(terminal.get("schema") == "fullmag.docker-build-operation.v1" and terminal.get("phase") == "development"
              and terminal.get("attempt") == attempt and terminal.get("compose_project") == project
              and terminal.get("inputs", {}).get("source_root") == source
              and compose.get("name") == project
              and (terminal.get("config_sha256") == _sha(canonical(compose)) or
                   (terminal.get("config_sha256") is None and terminal.get("state") == "failed-confirmed")),
              "historical development identity differs")
        return terminal, compose
    previous, previous_compose = development(original)
    state_root = previous.get("state_root")
    _need(isinstance(state_root, str) and previous.get("state") == "succeeded", "original namespace was not a successful development")
    package = record(f"development/attempts/{original}/backend-build-receipt.json")
    _need(package.get("state") == "succeeded" and package.get("source", {}).get("resolved_commit") == owner.get("build_commit")
          and package.get("source", {}).get("source_snapshot_sha256") == owner.get("build_snapshot"), "historical namespace build differs from current pinned owner")
    chain = proof.get("recreations")
    _need(isinstance(chain, list) and 1 <= len(chain) <= 16, "historical namespace chain is missing or unbounded")
    absent = []
    seen = {original}
    for index, link in enumerate(chain):
        _need(isinstance(link, Mapping) and set(link) == {"attempt", "successor_development_attempt"}
              and all(isinstance(v, str) and stop.ATTEMPT_RE.fullmatch(v) for v in link.values()), "invalid historical recreation link")
        recreation = record(f"recreate-services/attempts/{link['attempt']}/terminal.json")
        retained = record(f"recreate-services/attempts/{link['attempt']}/retained-containers.json")
        pair = [previous.get("backend_container"), previous.get("frontend_container")]
        _need(all(isinstance(v, str) and stop.CONTAINER_RE.fullmatch(v) for v in pair) and len(set(pair)) == 2, "invalid historical service pair")
        _need(recreation.get("schema") == "fullmag.docker-build-operation.v1" and recreation.get("phase") == "recreate-services"
              and recreation.get("state") == "succeeded" and recreation.get("fresh_state") is False
              and recreation.get("attempt") == link["attempt"] and recreation.get("compose_project") == project
              and recreation.get("control_volume") == proof["control_volume"]
              and recreation.get("inputs", {}).get("attempt") == previous.get("attempt")
              and recreation.get("inputs", {}).get("config_sha256") == _sha(canonical(previous_compose))
              and recreation.get("removed_containers") == pair and recreation.get("previous_state_root") == state_root,
              "historical successful deletion does not bind its predecessor pair")
        _need(isinstance(retained, Mapping) and set(retained) == {"backend", "frontend"}, "historical retained pair missing")
        for role, identifier in zip(("backend", "frontend"), pair):
            row = retained[role]
            labels = row.get("Config", {}).get("Labels", {})
            expected_labels = backend.get("Config", {}).get("Labels", {})
            _need(row.get("Id") == identifier and labels.get("com.docker.compose.project") == project
                  and labels.get("com.docker.compose.service") == role
                  and all(isinstance(expected_labels.get(key), str) and labels.get(key) == expected_labels[key] for key in (
                      "org.fullmag.source.project-id", "org.fullmag.source.worktree-id", "org.fullmag.source.checkout-kind")),
                  "historical service source/group identity differs")
            if role == "backend":
                _need(row.get("State", {}).get("Running") is False and row.get("State", {}).get("Pid") == 0
                      and row.get("Config", {}).get("Hostname") == previous_compose.get("services", {}).get("backend", {}).get("hostname"),
                      "historical backend namespace observation differs")
                if index == 0:
                    _need(row["Config"]["Hostname"] == owner.get("host"), "historical hostname does not bind current owner")
        absent.extend(pair)
        successor = link["successor_development_attempt"]
        _need(successor not in seen, "historical chain repeats a development")
        seen.add(successor)
        previous, previous_compose = development(successor)
        _need(previous.get("state_root") == state_root, "historical chain changed accepted store")
    _need(previous.get("attempt") == pins["development_attempt"]
          and _sha(canonical(previous_compose)) == pins["compose_config_sha256"]
          and previous.get("backend_container") == pins["backend_container_id"]
          and previous.get("frontend_container") == pins["frontend_container_id"] and set(records) == used, "historical chain does not terminate at selected diagnostic pair")
    observation = proof.get("absence")
    _need(len(set(absent)) == len(absent) and pins["backend_container_id"] not in absent
          and isinstance(observation, Mapping) and isinstance(observation.get("docker_engine_id_sha256"), str)
          and stop.SHA256_RE.fullmatch(observation["docker_engine_id_sha256"])
          and observation.get("historical_container_ids_absent") == sorted(absent)
          and observation.get("historical_hostname") == owner.get("host") and observation.get("hostname_reused") is False,
          "historical namespace absence claim differs")
    if control is not None:
        _need(_observe_namespace_absence(owner["host"], absent) == observation, "historical namespace absence changed")


def validate(evidence, pins, runtime_records, backend, *, control=None):
    """Validate frozen evidence, optionally CAS every source in its control volume.

    runtime_records are the ordinary abrupt proof's four pinned raw documents.
    Their exact paths and authorization hashes are checked here as well so this
    function is safe to call before that enclosing proof has been assembled.
    """
    _need(isinstance(pins, Mapping), "authorization pins are not an object")
    _need(isinstance(backend, Mapping) and isinstance(backend.get("State"), Mapping), "backend observation is incomplete")
    _need(isinstance(evidence, Mapping) and (
        (evidence.get("schema") == SCHEMA and set(evidence) == {"schema", "reference", "records"}) or
        (evidence.get("schema") == HISTORICAL_SCHEMA and set(evidence) == {
            "schema", "reference", "records", "historical_namespace_absence"})), "unsupported frozen schema")
    reference, records = evidence["reference"], evidence["records"]
    _need(isinstance(reference, Mapping) and set(reference) == {"attempt", "sha256"}, "invalid reference")
    attempt = reference["attempt"]
    _need(isinstance(attempt, str) and stop.ATTEMPT_RE.fullmatch(attempt), "invalid stop attempt")
    _need(isinstance(records, Mapping) and set(records) == {
        "stop", "operation", "preflight", "resume", "before_process", "development", "compose", "fence"
    }, "incomplete evidence inventory")
    decoded, raw_records = {}, {}
    for key, record in records.items():
        _need(isinstance(record, Mapping) and set(record) == {"path", "raw_utf8", "sha256"}
              and isinstance(record["raw_utf8"], str), "invalid record " + key)
        raw = record["raw_utf8"].encode("utf-8")
        _need(len(raw) <= stop.MAX_EVIDENCE_BYTES and _sha(raw) == record["sha256"], "changed bytes: " + key)
        decoded[key], raw_records[key] = stop._json(raw, key), raw
    terminal, operation = decoded["stop"], decoded["operation"]
    preflight, before = decoded["preflight"], decoded["before_process"]
    resume, development = decoded["resume"], decoded["development"]
    _need(records["stop"]["sha256"] == reference["sha256"], "stop digest differs from explicit reference")
    for key in ("attempt", "resume_attempt"):
        _need(isinstance(terminal.get(key), str) and stop.ATTEMPT_RE.fullmatch(terminal[key]), "invalid terminal " + key)
    paths = _paths(attempt, terminal["resume_attempt"], terminal["attempt"], before.get("api_failure_fence"))
    for key, path in paths.items():
        _need(records[key]["path"] == path, "unexpected record path: " + key)
        if control is not None:
            _need(stop._read_raw(control, path) == raw_records[key], "stale evidence: " + key)

    runtime = {}
    expected_runtime = {"process_receipt": "runtime-service/process-tree.json",
                        "owner": "runtime-services/OWNER.json", "launch": "runtime-services/LAUNCH.json",
                        "config": "runtime-service/docker-all.json"}
    _need(isinstance(runtime_records, Mapping) and set(runtime_records) == set(expected_runtime), "runtime inventory differs")
    for key, suffix in expected_runtime.items():
        item = runtime_records[key]
        _need(isinstance(item, Mapping) and set(item) == {"path", "raw_utf8", "sha256"}
              and isinstance(item["raw_utf8"], str), "invalid runtime record: " + key)
        raw = item["raw_utf8"].encode("utf-8")
        _need(item["path"] == "runtime-control/" + suffix and len(raw) <= stop.MAX_EVIDENCE_BYTES
              and _sha(raw) == item["sha256"] == pins.get(key + "_sha256"), "runtime pin differs: " + key)
        runtime[key] = stop._json(raw, key)
        if control is not None:
            _need(stop._read_raw(control, item["path"]) == raw, "runtime record changed: " + key)

    _need(terminal.get("schema") == "fullmag.docker-bootstrap-api-stop.v1"
          and terminal.get("state") == "stopped-confirmed"
          and terminal.get("execution_state") == "unknown"
          and terminal.get("backend_running") is False and terminal.get("frontend_running") is True
          and terminal.get("runtime_owner_state") == "ready-history-preserved"
          and terminal.get("resource_leases") == terminal.get("session_store") == "untouched", "stop did not preserve an unknown historical owner")
    bindings = {"attempt": pins.get("development_attempt"), "source_root": pins.get("source_root"),
                "compose_project": pins.get("compose_project"), "config_sha256": pins.get("compose_config_sha256"),
                "backend_container_id": pins.get("backend_container_id"),
                "frontend_container_id": pins.get("frontend_container_id"), "image_id": pins.get("old_image_id")}
    for key, value in bindings.items():
        _need(value is not None and terminal.get(key) == value, "stop identity differs: " + key)
    _need(operation.get("schema") == "fullmag.docker-build-operation.v1"
          and operation.get("attempt") == attempt and operation.get("phase") == "stop-bootstrap"
          and operation.get("state") == "succeeded" and operation.get("execution_state") == "unknown"
          and operation.get("compose_project") == pins["compose_project"]
          and operation.get("stop_state") == "stopped-confirmed"
          and operation.get("stop_bootstrap_terminal_sha256") == _sha(canonical(terminal)), "stop operation is not successfully linked to its canonical terminal")
    if control is not None:
        _need(operation.get("control_volume") == control.volume
              and operation.get("control_namespace") == (control.namespace or None), "stop control identity differs")
    inputs = operation.get("inputs")
    _need(isinstance(inputs, Mapping), "stop operation has no inputs")
    for key, value in bindings.items():
        if key != "compose_project":
            _need(inputs.get(key) == value, "operation input differs: " + key)
    _need(preflight.get("schema") == "fullmag.docker-bootstrap-api-stop-preflight.v1"
          and preflight.get("state") == "preflight-confirmed", "missing qualified preflight")
    shared = ("attempt", "resume_attempt", "config_sha256", "backend_container_id", "frontend_container_id",
              "backend_started_at", "image_id", "development_terminal_sha256", "resume_terminal_sha256",
              "compose_sha256", "failure_fence_sha256", "api_pid", "api_instance_id",
              "current_build_commit", "current_build_snapshot", "resume_process_failure_sha256")
    for key in shared:
        _need(terminal.get(key) is not None and preflight.get(key) == terminal[key], "preflight binding differs: " + key)
        if key != "api_pid":
            _need(inputs.get(key) == terminal[key], "operation input binding differs: " + key)
    for key, field in (("development", "development_terminal_sha256"), ("resume", "resume_terminal_sha256"),
                       ("compose", "compose_sha256"), ("fence", "failure_fence_sha256"),
                       ("before_process", "resume_process_failure_sha256")):
        _need(_sha(raw_records[key]) == terminal.get(field), "linked document differs: " + key)
    _need(_sha(canonical(decoded["compose"])) == pins["compose_config_sha256"], "canonical Compose digest differs")
    _need(isinstance(development.get("inputs"), Mapping) and isinstance(resume.get("inputs"), Mapping),
          "development/resume inputs are not objects")
    _need(development.get("attempt") == pins["development_attempt"]
          and development.get("phase") == "development" and development.get("compose_project") == pins["compose_project"]
          and development.get("inputs", {}).get("source_root") == pins["source_root"], "development identity differs")
    _need(resume.get("phase") == "resume" and resume.get("state") == "failed-confirmed"
          and resume.get("attempt") == terminal["resume_attempt"]
          and resume.get("compose_project") == pins["compose_project"]
          and resume.get("inputs", {}).get("attempt") == pins["development_attempt"]
          and resume.get("inputs", {}).get("config_sha256") == pins["compose_config_sha256"]
          and resume.get("backend_started_at") == terminal["backend_started_at"], "failed resume identity differs")
    _need(isinstance(resume.get("frontend_started_at"), str) and bool(resume["frontend_started_at"]),
          "failed resume does not pin the frontend incarnation")
    _need(backend.get("Id") == pins["backend_container_id"] and backend.get("Image") == pins["old_image_id"]
          and backend.get("State", {}).get("StartedAt") == terminal["backend_started_at"], "backend incarnation differs")

    process, owner, fence = runtime["process_receipt"], runtime["owner"], decoded["fence"]
    _need(process.get("schema") == before.get("schema") == "fullmag.docker-process-tree.v1"
          and before.get("state") == "failed_outcome_retained" and process.get("state") == "shutdown_unknown"
          and process.get("api_diagnostic_only") is True and before.get("api_diagnostic_only") is True
          and not {"service_owner", "runtime_pid", "terminal_service_owner", "startup_activation"}.intersection(process)
          and not {"service_owner", "runtime_pid", "terminal_service_owner", "startup_activation"}.intersection(before)
          and stop._matches_target_build_failure(before.get("error")), "process is not the exact diagnostic stop")
    _need(process.get("shutdown_error") == terminal.get("shutdown_error") == stop.EXPECTED_SHUTDOWN_ERROR
          and type(process.get("api_exit_code")) is int and process["api_exit_code"] == terminal.get("api_exit_code"), "unknown shutdown result differs")
    ignored = {"state", "api_exit_code", "shutdown_error"}
    _need({k: v for k, v in before.items() if k not in ignored} == {k: v for k, v in process.items() if k not in ignored}, "process changed beyond diagnostic shutdown")
    _need(terminal.get("process_receipt_sha256_after") == pins["process_receipt_sha256"]
          and terminal.get("process_receipt_sha256_before") == preflight.get("process_receipt_sha256") == _sha(raw_records["before_process"]), "process byte chain differs")
    _need(terminal.get("owner_sha256_before") == terminal.get("owner_sha256_after") == preflight.get("owner_sha256") == pins["owner_sha256"]
          and terminal.get("runtime_config_sha256") == pins["config_sha256"], "native owner/config changed")
    from docker_volume_stop_failed import _validate_native_ready_owner
    owner = _validate_native_ready_owner(owner)
    launch = runtime["launch"]
    _need(launch.get("schema_version") == "runtime_service_launch.v1"
          and launch.get("state") in ("spawned", "ready")
          and type(launch.get("pid")) is int and launch["pid"] == owner["pid"],
          "LAUNCH is not the exact historical owner")
    _need(owner.get("target_id") == "docker-all"
          and (owner.get("build_commit"), owner.get("build_snapshot")) != (terminal["current_build_commit"], terminal["current_build_snapshot"]), "owner is not the historical build")
    _need(preflight.get("owner_pids_absent") == sorted([owner["pid"], *(child["pid"] for child in owner["children"])]), "absence proof differs from the retained owner")
    _need(fence.get("schema") == "fullmag.api-runtime-failure-fence.v1" and fence.get("stage") == "runtime_startup"
          and fence.get("reason") == before.get("error") and type(before.get("api_pid")) is int
          and before["api_pid"] > 0 and fence.get("api_pid") == before["api_pid"] == terminal["api_pid"]
          and fence.get("api_instance_id") == terminal["api_instance_id"], "startup fence identity differs")
    _need(isinstance(terminal["api_instance_id"], str) and stop.UUID_RE.fullmatch(terminal["api_instance_id"]),
          "API incarnation is not a UUID")
    _need(runtime["config"].get("schema_version") == "runtime_service_config.v2"
          and runtime["config"].get("target_id") == "docker-all"
          and runtime["config"].get("store_root") == "/state/runs/docker-all/session-store", "runtime store binding differs")
    validate_owner_namespace(evidence, pins, runtime_records, backend, control=control)
    return {"frontend_started_at": resume.get("frontend_started_at"), "stop_attempt": attempt}
