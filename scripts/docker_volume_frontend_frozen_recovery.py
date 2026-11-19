"""Qualify a failed frontend generation while preserving its running backend."""
from __future__ import annotations
import io
import json
from pathlib import Path
import tarfile
from docker_build_control import MAX_DOCUMENT_BYTES, canonical, docker_capture
from docker_volume_reconcile import digest, read_raw, require, SHA, TOKEN

SCHEMA = "fullmag.docker-resume-frontend-frozen-reconciliation.v1"
ERROR = "Docker development configuration or source identity changed; create a new development state"


def validate_shape(request):
    from docker_volume_reconcile import validate_request, SCHEMA as STANDARD
    require(isinstance(request, dict) and set(request) == {
        "schema", "attempt", "compose_project", "source_root", "port", "config_sha256",
        "unknown_receipt_sha256", "controller_sha256", "containers", "package_documents",
        "frontend_helper_sha256", "failure", "source_transition"}, "Frozen frontend request keys differ")
    require(request["schema"] == SCHEMA, "Frozen frontend request schema differs")
    standard = {k: v for k, v in request.items()
                if k not in {"frontend_helper_sha256", "failure", "source_transition"}}
    standard["schema"] = STANDARD
    validate_request(standard)
    require(isinstance(request["frontend_helper_sha256"], str)
            and SHA.fullmatch(request["frontend_helper_sha256"]), "Invalid frozen helper digest")
    pin = request["source_transition"]
    require(isinstance(pin, dict) and set(pin) == {"path", "sha256"}
            and isinstance(pin["path"], str) and pin["path"].startswith(
                "verification/frontend-frozen-recovery-20261027/")
            and pin["path"].isascii() and pin["path"].endswith(".json") and ".." not in pin["path"].split("/")
            and all(char.isalnum() or char in "/._-" for char in pin["path"])
            and isinstance(pin["sha256"], str) and SHA.fullmatch(pin["sha256"]),
            "Explicit reviewed same-root transition pins are required")
    failure = request["failure"]
    require(isinstance(failure, dict) and set(failure) == {
        "frontend_state_sha256", "log_sha256", "freeze_sha256", "inputs_sha256",
        "previous_receipt_sha256", "backend_observation"}, "Frozen frontend failure keys differ")
    require(all(isinstance(failure[k], str) and SHA.fullmatch(failure[k])
                for k in failure if k != "backend_observation")
            and isinstance(failure["backend_observation"], dict),
            "Frozen frontend failure pins differ")


def container_file(identifier, path):
    # docker cp reads stopped containers without creating or starting a helper.
    result = docker_capture("cp", identifier + ":" + path, "-")
    require(len(result.stdout) <= MAX_DOCUMENT_BYTES, "Frontend document archive exceeds its bound")
    with tarfile.open(fileobj=io.BytesIO(result.stdout)) as archive:
        members = archive.getmembers()
        require(len(members) == 1 and members[0].isfile()
                and 0 < members[0].size <= MAX_DOCUMENT_BYTES,
                "Frontend document must be one bounded regular file")
        raw = archive.extractfile(members[0]).read(MAX_DOCUMENT_BYTES + 1)
    require(len(raw) <= MAX_DOCUMENT_BYTES, "Frontend document exceeds its bound")
    return raw


def frozen_failure(control, actual):
    state = actual["State"]
    require(state.get("Status") == "exited" and state.get("Running") is False
            and state.get("ExitCode") == 1 and state.get("Pid") == 0
            and all(state.get(k) is False for k in ("OOMKilled", "Dead", "Restarting", "Paused"))
            and not state.get("Error") and state.get("FinishedAt"),
            "Frontend is not the exact non-OOM exit-1 failure")
    output = docker_capture("logs", "--since", state["StartedAt"], actual["Id"])
    log = output.stdout + output.stderr
    require(len(log) <= MAX_DOCUMENT_BYTES
            and log.decode("utf-8", "strict").rstrip().endswith(
                "frontend_dev.FrontendDevError: " + ERROR),
            "Frontend log is not the frozen-input rejection")
    freeze_raw = container_file(actual["Id"], "/state/development/inputs-freeze.json")
    inputs_raw = read_raw(control, "frontend/development-inputs.json")
    freeze, inputs = json.loads(freeze_raw), json.loads(inputs_raw)
    require(freeze.get("schema") == "fullmag.docker-development-inputs-freeze.v1"
            and isinstance(freeze.get("manifest"), dict)
            and freeze["manifest"] != inputs,
            "Frontend does not have a distinct frozen input identity")
    return {"frontend_state_sha256": digest(canonical(state)), "log_sha256": digest(log),
            "freeze_sha256": digest(freeze_raw), "inputs_sha256": digest(inputs_raw)}


def terminal_context(control, original, document):
    import docker_volume_terminal_prestart_recovery as terminal
    from docker_volume_reconcile import validate_request
    reference = original.get("terminal_prestart_reconciliation")
    pin = original.get("terminal_prestart_reconciliation_sha256")
    require(isinstance(reference, str) and TOKEN.fullmatch(reference)
            and isinstance(pin, str) and SHA.fullmatch(pin),
            "Resume has no exact terminal-history continuation")
    root = "iteration/attempts/" + reference
    raw = read_raw(control, root + "/terminal.json")
    require(digest(raw) == pin, "Terminal-history continuation CAS differs")
    confirmed = json.loads(raw)
    reconciliation = confirmed.get("reconciliation", {})
    request_raw = read_raw(control, reconciliation["request"])
    require(digest(request_raw) == reconciliation.get("request_sha256"),
            "Terminal-history request CAS differs")
    request = json.loads(request_raw)
    validate_request(request)
    require(request["schema"] == terminal.SCHEMA and confirmed.get("state") == "failed-confirmed"
            and confirmed.get("phase") == "iteration" and confirmed.get("attempt") == reference
            and confirmed.get("compose_project") == control.project
            and confirmed.get("control_volume") == control.volume
            and request["compose_project"] == control.project
            and confirmed.get("inputs", {}).get("attempt") == original["inputs"]["attempt"]
            and request["config_sha256"] == original["inputs"]["config_sha256"]
            and digest(canonical(document)) == request["config_sha256"]
            and confirmed.get("terminal_prestart_failure_proof") == request["failure"]
            and reconciliation.get("evidence") == request["failure"],
            "Resume terminal-history obligation differs")
    probe = json.loads(read_raw(control, root + "/terminal-session-preflight.json"))
    require(digest(canonical(probe)) == confirmed.get("terminal_session_preflight_sha256"),
            "Terminal-history preflight differs")
    terminal.validate_preflight(probe)
    return {"kind": "terminal_history", "request": request, "probe": probe}


def _frontend_volumes(control, request, original, document):
    from docker_development_inputs import metadata_cache_key
    raw = read_raw(control, "frontend/development-inputs.json")
    require(digest(raw) == request["failure"]["inputs_sha256"],
            "Seeded frontend input CAS differs")
    inputs = json.loads(raw)
    retained = document.get("volumes", {}).get("frontend-build", {}).get("name")
    require(isinstance(retained, str) and retained.startswith("fullmag-dev-frontend-v1-")
            and len(retained) == len("fullmag-dev-frontend-v1-") + 24
            and all(char in "0123456789abcdef" for char in retained[-24:]),
            "Retained frontend volume configuration differs")
    seeded = "fullmag-dev-frontend-v1-" + metadata_cache_key(inputs, control.project)[:24]
    require(original.get("frontend_volume") == seeded,
            "Recorded seeded frontend volume differs from its pinned inputs")
    return {"seeded": seeded, "retained": retained}


def validate_base(control, request, original, previous, document, selected):
    require(not getattr(control, "namespace", None), "Namespaced frontend recovery is unsupported")
    require(original.get("phase") == "resume" and original.get("compose_project") == control.project
            and original.get("control_volume") == control.volume
            and original.get("error") == "DEV service exited before readiness: frontend",
            "Only this group's exact frontend readiness failure is supported")
    volumes = _frontend_volumes(control, request, original, document)
    require(previous.get("state") in {"failed-confirmed", "succeeded"}
            and previous.get("attempt") == original["inputs"]["attempt"]
            and previous.get("inputs", {}).get("source_root") == str(selected) == request["source_root"]
            and previous.get("state_root") == original.get("state_root")
            and previous.get("backend_volumes") == original.get("backend_volumes")
            and previous.get("frontend_volume") == volumes["retained"]
            and digest(read_raw(control, "development/attempts/" + previous["attempt"] + "/terminal.json"))
                == request["failure"]["previous_receipt_sha256"],
            "Frozen frontend base resources differ")
    require(document["services"]["backend"]["environment"].get("FULLMAG_STARTUP_ENABLED") != "1",
            "Frontend recovery never repeats startup activation")
    return terminal_context(control, original, document)


def backend_observation(backend_id):
    import docker_volume_dev as dev
    value = dev._frontend_recovery_backend_observation(backend_id, allow_empty=True)
    if value["active_session"]:
        probe = dev._terminal_session_restart_probe(backend_id, allow_prepared=True)
        require(probe is not None and probe.get("run", {}).get("run_id") == value["run_id"]
                and probe.get("run", {}).get("status") in {"completed", "failed", "cancelled", "stopped"},
                "Frontend recovery requires the exact terminal session")
    return value



BASE_CAPTURE_SCRIPT = r"""import sys
from pathlib import Path
sys.path.insert(0,"/opt/fullmag")
import backend_dev
path=Path("/build/.fullmag-live-source/manifest.json")
document,raw=backend_dev._read_json(path,"sealed application source capture",64*1024*1024)
backend_dev._validate_live_manifest(document)
sys.stdout.buffer.write(raw)
"""


def source_qualification(control, request, actual, current, backend, receipt_source):
    import docker_dev_codegen as codegen
    import docker_helper_source as helper
    from docker_dev import BASE_CONTEXT_FILES, RUNTIME_IMAGE_CONTEXT_FILES
    pin = request["source_transition"]
    raw = read_raw(control, pin["path"])
    require(digest(raw) == pin["sha256"], "Reviewed helper transition CAS differs")
    base_raw, _ = codegen._exec(actual["Id"], (
        "/usr/local/bin/python3", "-B", "-c", BASE_CAPTURE_SCRIPT),
        stdout_limit=64 * 1024 * 1024)
    binding = helper.verify_same_root_transition(
        raw, pin["sha256"], base_raw, current, backend, receipt_source,
        Path(request["source_root"]), base_context_files=BASE_CONTEXT_FILES,
        runtime_context_files=RUNTIME_IMAGE_CONTEXT_FILES)
    # The ordinary equality remains exact. This separately qualified transition
    # describes an older sealed app and newer helpers without rewriting either.
    binding["ordinary_source_matches"] = codegen._source_matches(current, backend)
    return binding


def qualified_backend(control, root, request, actual, *, runtime_config_sha256):
    require(isinstance(runtime_config_sha256, str) and SHA.fullmatch(runtime_config_sha256),
            "Authenticated runtime configuration digest is required")
    import docker_dev_codegen as codegen
    receipt, provenance, receipt_sha, binary = codegen._backend_documents(actual["Id"])
    source, _, _ = codegen._validate_backend(receipt, provenance, receipt_sha, binary)
    source_probe, _ = codegen._probe_source(actual["Id"], request["attempt"])
    binding = source_qualification(control, request, actual, source_probe, source, receipt["source"])
    require(receipt_sha == request["package_documents"]["receipt"]
            and digest(read_raw(control, root + "/backend-build-receipt.json")) == receipt_sha
            and digest(read_raw(control, root + "/provenance.json")) == request["package_documents"]["provenance"],
            "Resume publication CAS differs")
    qualified = {"backend_container_id": actual["Id"],
                 "backend_started_at": actual["State"]["StartedAt"],
                 "image_id": actual["Image"], "package_receipt_sha256": receipt_sha,
                 "provenance_sha256": request["package_documents"]["provenance"],
                 "runtime_config_sha256": runtime_config_sha256}
    return qualified, binding


def validate_failure(control, root, request, original, actual, state):
    import docker_volume_terminal_prestart_recovery as terminal
    require(digest(Path(__file__).read_bytes()) == request["frontend_helper_sha256"],
            "Frozen frontend helper source differs")
    document = control.read("development/attempts/" + original["inputs"]["attempt"] + "/compose.json")
    volumes = _frontend_volumes(control, request, original, document)
    mounts = [row for row in actual["frontend"].get("Mounts", [])
              if row.get("Destination") == "/state/development"]
    require(len(mounts) == 1 and mounts[0].get("Type") == "volume"
            and mounts[0].get("RW") is True and mounts[0].get("Name") == volumes["retained"],
            "Actual retained frontend volume mount differs")
    context = terminal_context(control, original, document)
    require(original.get("backend_started_at") == actual["backend"]["State"]["StartedAt"]
            and actual["backend"]["State"].get("Health", {}).get("Status") == "healthy",
            "Retried backend is not its exact healthy incarnation")
    require({**frozen_failure(control, actual["frontend"]),
             "previous_receipt_sha256": request["failure"]["previous_receipt_sha256"],
             "backend_observation": backend_observation(actual["backend"]["Id"])} == request["failure"],
            "Frozen frontend failure or live observation changed")
    qualified, binding = qualified_backend(
        control, root, request, actual["backend"],
        runtime_config_sha256=context["request"]["observation"]["runtime_config_sha256"])
    operation = {"root": root, "receipt": {}, "daemon_pending": True}
    terminal.complete(control, operation, actual["backend"]["Id"], context, qualified)
    require(backend_observation(actual["backend"]["Id"]) == request["failure"]["backend_observation"]
            and frozen_failure(control, actual["frontend"]) == {
                k: v for k, v in request["failure"].items()
                if k not in {"previous_receipt_sha256", "backend_observation"}},
            "Frontend or terminal session changed during native completion")
    return {"failure": dict(request["failure"]), "frontend_volumes": volumes,
            "app_source": binding["app_source"],
            "helper_source": binding["helper_source"],
            "transition_manifest_sha256": binding["transition_manifest_sha256"]}


def refresh_context(control, args, previous, document, actual):
    reference = getattr(args, "frontend_frozen_resume", None)
    sha = getattr(args, "frontend_frozen_resume_sha256", None)
    require(bool(reference) == bool(sha), "Both frozen frontend resume pins are required")
    if reference is None:
        return None
    require(isinstance(reference, str) and TOKEN.fullmatch(reference)
            and isinstance(sha, str) and SHA.fullmatch(sha), "Invalid frozen frontend resume pins")
    raw = read_raw(control, "resume/attempts/" + reference + "/terminal.json")
    require(digest(raw) == sha, "Frozen frontend terminal CAS differs")
    original = json.loads(raw)
    record = original.get("reconciliation", {})
    request_raw = read_raw(control, record["request"])
    require(digest(request_raw) == record.get("request_sha256"), "Frozen frontend request CAS differs")
    request = json.loads(request_raw)
    validate_shape(request)
    require(original.get("state") == "failed-confirmed" and original.get("phase") == "resume"
            and original.get("attempt") == request["attempt"] == reference
            and original.get("frontend_frozen_failure_proof", {}).get("failure") == request["failure"]
            and original.get("frontend_frozen_failure_proof", {}).get("transition_manifest_sha256")
                == request["source_transition"]["sha256"]
            and original["inputs"]["attempt"] == args.attempt
            and request["config_sha256"] == args.config_sha256
            and request["port"] == args.port, "Frozen frontend completion differs")
    from docker_volume_reconcile import validate_incarnation
    for name in ("backend", "frontend"):
        validate_incarnation(actual[name], request["containers"][name], control.project,
                             running=name == "backend")
    validate_base(control, request, original, previous, document, Path(args.source_root).resolve(strict=True))
    validate_failure(control, "resume/attempts/" + reference, request, original, actual,
                     Path(original["state_root"]))
    return {"resume": reference, "terminal_sha256": sha, "request": request}


def complete_refresh(control, operation, context, backend):
    import docker_volume_terminal_prestart_recovery as terminal
    request = context["request"]
    raw = read_raw(control, "resume/attempts/" + context["resume"] + "/terminal.json")
    require(digest(raw) == context["terminal_sha256"], "Frozen frontend terminal changed")
    original = json.loads(raw)
    document = control.read("development/attempts/" + original["inputs"]["attempt"] + "/compose.json")
    history = terminal_context(control, original, document)
    qualified, binding = qualified_backend(
        control, "resume/attempts/" + context["resume"], request, backend,
        runtime_config_sha256=history["request"]["observation"]["runtime_config_sha256"])
    terminal.complete(control, operation, backend["Id"], history, qualified)
    operation["receipt"].update(app_source=binding["app_source"], helper_source=binding["helper_source"],
                                helper_transition_manifest_sha256=binding["transition_manifest_sha256"])
    require(backend_observation(backend["Id"]) == request["failure"]["backend_observation"],
            "Terminal session changed after frontend refresh")
