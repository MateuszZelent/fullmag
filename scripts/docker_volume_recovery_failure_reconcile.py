"""Close only a proven pre-publication retained recovery build failure."""
import copy
import hashlib
import json
from pathlib import Path
import re
import subprocess
import time
import uuid

from docker_build_control import BuildControlError, canonical, docker_capture, bounded_capture
from docker_volume_reconcile import (claim_script, digest, fingerprint, read_raw,
    require, validate_failed_build_state, validate_incarnation, validate_original_owner,
    validate_partial_journal, write_immutable)

SCHEMA = "fullmag.retained-recovery-failed-build-reconciliation.v1"
SHA = re.compile(r"[0-9a-f]{64}\Z")
TOKEN = re.compile(r"[0-9a-f]{32}\Z")
MAX_LOG = 32 * 1024 * 1024


def validate_request(request):
    fields = {"schema", "attempt", "compose_project", "source_root", "port",
        "unknown_receipt_sha256", "before_sha256", "build_request_sha256",
        "compose_sha256", "previous_sha256", "controller_sha256", "reconciler_sha256",
        "phase_current_sha256", "verified_sha256", "recovery_controller_sha256", "containers", "failure"}
    require(isinstance(request, dict) and set(request) == fields and request["schema"] == SCHEMA,
            "Recovery failure request fields/schema differ")
    require(isinstance(request["attempt"], str) and TOKEN.fullmatch(request["attempt"]), "Invalid operation attempt")
    for name in fields:
        if name.endswith("_sha256"):
            value = request[name]
            require((name in {"phase_current_sha256", "verified_sha256"} and value is None)
                    or isinstance(value, str) and SHA.fullmatch(value), "Invalid document pin: " + name)
    require(isinstance(request["containers"], dict) and set(request["containers"]) == {"backend", "frontend", "lease"},
            "Exact backend/frontend/lease required")
    for pin in request["containers"].values():
        require(isinstance(pin, dict) and set(pin) == {"id", "image", "started_at", "fingerprint"}
                and SHA.fullmatch(pin["id"]) and pin["image"].startswith("sha256:")
                and SHA.fullmatch(pin["image"][7:]) and SHA.fullmatch(pin["fingerprint"])
                and isinstance(pin["started_at"], str) and pin["started_at"], "Invalid container pin")
    require(len({v["id"] for v in request["containers"].values()}) == 3, "Repeated container identity")
    require(isinstance(request["failure"], dict) and set(request["failure"]) == {"exit_code", "finished_at", "log_sha256"}
            and type(request["failure"]["exit_code"]) is int and request["failure"]["exit_code"] == 2
            and SHA.fullmatch(request["failure"]["log_sha256"]), "Only canonical Make failure is admissible")


def unchanged(before, after):
    for name in ("authorization_pins", "raw_records", "storage_proof", "retained_terminal_runs",
                 "retained_held_manual_runs", "retained_attempt_histories", "docker_engine_id_sha256", "network"):
        require(before.get(name) == after.get(name), "Recovery evidence changed: " + name)
    require(before["containers"]["frontend"] == after["containers"]["frontend"], "Stopped frontend changed")
    require(fingerprint(before["containers"]["backend"]) == fingerprint(after["containers"]["backend"]),
            "Backend configuration changed")


def validate_failure(actual, request, log):
    require(len(log) <= MAX_LOG, "Failure log exceeds observation bound")
    validate_failed_build_state(actual, request["failure"], log)
    state = actual["State"]
    require(type(state.get("Pid")) is int and state["Pid"] == 0 and state.get("Paused") is False,
            "Failed namespace is not fully stopped")
    text = log.decode("utf-8", "strict")
    require(not any(marker in text for marker in ("phase=start state=handoff", "phase=api state=exec",
            "phase=gate state=complete", "phase=start state=cache-hit")), "Failure crossed publication/admission")


def inspect_pins(request):
    from docker_volume_container_recovery import _stable_container_observation
    actual = {}
    for name, pin in request["containers"].items():
        rows = json.loads(docker_capture("inspect", pin["id"]).stdout)
        require(len(rows) == 1, "Ambiguous container inventory")
        validate_incarnation(rows[0], pin, request["compose_project"], running=name == "lease")
        actual[name] = _stable_container_observation(rows[0])
    return actual


def collect(control, selected, request, *, observer=None):
    import docker_volume_dev as dev
    import docker_volume_container_recovery as recovery
    from docker_dev import _select_source
    validate_request(request)
    require(request["compose_project"] == control.project and request["source_root"] == str(selected),
            "Source/group differs")
    require(digest(Path(__file__).read_bytes()) == request["controller_sha256"]
            and digest(Path(__file__).with_name("docker_volume_reconcile.py").read_bytes()) == request["reconciler_sha256"],
            "Reviewed reconciliation code changed")
    require(digest(Path(recovery.__file__).read_bytes()) == request["recovery_controller_sha256"], "Recovery observer code changed")
    root = "recovery-build/attempts/" + request["attempt"]
    current_raw = read_raw(control, root + "/receipt.json")
    saved = read_raw(control, root + "/unknown-receipt.json", optional=True)
    original_raw = saved if saved is not None else current_raw
    require(digest(original_raw) == request["unknown_receipt_sha256"], "Unknown operation CAS differs")
    original = json.loads(original_raw)
    require(original.get("schema") == "fullmag.docker-build-operation.v1"
            and original.get("phase") == "recovery-build" and original.get("state") == "outcome-unknown-resources-retained"
            and original.get("attempt") == request["attempt"] and original.get("compose_project") == control.project
            and original.get("control_volume") == control.volume, "Wrong retained operation")
    require(original.get("helper_container") == "fullmag-control-" + request["attempt"], "Wrong original helper")
    require(original.get("backend_started_at") == request["containers"]["backend"]["started_at"], "Wrong build incarnation")
    require(read_raw(control, root + "/terminal.json", optional=True) is None, "Already terminal; inspect result")
    require(current_raw == original_raw, "Partial finalization requires dedicated journal inspection")
    inputs = original["inputs"]
    require(inputs.get("source_root") == str(selected), "Operation source differs")
    build_raw = read_raw(control, root + "/request.json")
    require(digest(build_raw) == request["build_request_sha256"], "Build request changed")
    build = dev._recovery_build_request(build_raw)
    submitted_raw = read_raw(control, inputs["request"])
    require(digest(submitted_raw) == inputs["request_sha256"] and json.loads(submitted_raw) == build,
            "Historical submitted request changed")
    pins = build["authorization_pins"]
    require(inputs["attempt"] == pins["development_attempt"] and inputs["config_sha256"] == pins["compose_config_sha256"]
            and inputs["image_id"] == pins["old_image_id"] and inputs["source_commit"] == build["source_commit"]
            and inputs["controller_sha256"] == build["controller_sha256"]
            and pins["source_root"] == str(selected) and pins["compose_project"] == control.project,
            "Historical recovery authorization differs")
    for role in ("backend", "frontend"):
        require(request["containers"][role]["id"] == pins[role + "_container_id"]
                and request["containers"][role]["image"] == pins["old_image_id"], "Wrong authorized service")
    base = "development/attempts/" + pins["development_attempt"]
    previous_raw = read_raw(control, base + "/terminal.json")
    require(digest(previous_raw) == request["previous_sha256"], "Development receipt changed")
    previous = json.loads(previous_raw)
    compose_raw = read_raw(control, base + "/compose.json")
    require(digest(compose_raw) == request["compose_sha256"], "Compose document changed")
    document = json.loads(compose_raw)
    require(digest(canonical(document)) == pins["compose_config_sha256"] and document.get("name") == control.project,
            "Compose authority differs")
    ports = document["services"]["frontend"].get("ports", [])
    require(len(ports) == 1 and str(ports[0].get("published")) == str(request["port"])
            and ports[0].get("host_ip") == "127.0.0.1", "Loopback port differs")
    before_raw = read_raw(control, root + "/before.json")
    require(digest(before_raw) == request["before_sha256"], "Before proof changed")
    before = json.loads(before_raw)
    actual = inspect_pins(request)
    validate_original_owner(actual["lease"], original, control, request["containers"]["lease"]["image"])
    require(actual["lease"].get("Config", {}).get("Entrypoint") == ["/bin/bash"]
            and actual["lease"].get("Config", {}).get("Cmd") == ["-euo", "pipefail", "-c", control.operation_script("recovery-build", request["attempt"])],
            "Original lease command differs")
    output = docker_capture("logs", "--since", request["containers"]["backend"]["started_at"], request["containers"]["backend"]["id"])
    log = output.stdout + output.stderr
    validate_failure(actual["backend"], request, log)
    for name in ("backend-build-receipt.json", "provenance.json", "native-capabilities.json", "handoff-log.json"):
        require(read_raw(control, root + "/" + name, optional=True) is None, "Publication boundary already crossed")
    options = {"retained_attempt_histories": build["retained_attempt_histories"]} if build["schema"] == dev._RECOVERY_HISTORY_BUILD_SCHEMA else {}
    after = recovery.prepare_abrupt_stop_proof(control, pins, document,
        retained_terminal_runs=build["retained_terminal_runs"], retained_held_manual_runs=build["retained_held_manual_runs"],
        failure_reconciliation_helpers={"request": request, "observer": observer}, **options)
    unchanged(before, after)
    require(after["containers"]["backend"] == actual["backend"] and after["containers"]["frontend"] == actual["frontend"],
            "Service changed during observation")
    _, layout = _select_source(selected, selected)
    state = dev.storage.validate_path(Path(previous["state_root"]), layout["runtime_root"], "retained Linux sessions")
    certificate = dev._recovery_build_certificate(state, document, build)
    # Only certificate_sha256 has historical authority; other hashes pin this observation window.
    for name, expected in (("current.json", request["phase_current_sha256"]), ("verified.json", request["verified_sha256"])):
        value = read_raw(control, "recovery-build/" + name, optional=True)
        require((digest(value) if value is not None else None) == expected, "Recovery phase record changed")
    require(inspect_pins(request) == actual, "Service/helper changed during proof")
    return {"root": root, "original": original, "original_raw": original_raw, "current_raw": current_raw,
        "proof": after, "certificate": certificate, "failure_log_sha256": digest(log)}


def reconcile(args, control, selected, request, request_raw):
    validate_request(request)
    require(digest(request_raw) == args.request_sha256 and json.loads(request_raw) == request, "Request CAS differs")
    before = collect(control, selected, request)
    root = before["root"]
    script = claim_script(control, root, request, digest(before["current_raw"]), phase="recovery-build", publish_verified=False)
    if getattr(args, "preview", False):
        return {"state": "validated-only", "attempt": request["attempt"], "schema": SCHEMA}
    name = "fullmag-recovery-failure-observer-" + uuid.uuid4().hex
    claim = subprocess.Popen(control.helper_args(script, name=name), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    began = False
    try:
        require(control._line(claim) == "READY", "Observer exclusion was not acquired")
        observed = json.loads(docker_capture("inspect", name).stdout)
        require(len(observed) == 1 and observed[0]["State"]["Running"], "Observer is not live")
        helper_image = json.loads(docker_capture("image", "inspect", control.image).stdout)[0]["Id"]
        validate_original_owner(observed[0], {"helper_container": name}, control, helper_image)
        write_immutable(control, root + "/unknown-receipt.json", before["original_raw"])
        write_immutable(control, root + "/reconciliation/observer-" + observed[0]["Id"] + ".json",
                        canonical({"request_sha256": args.request_sha256, "container": observed[0]}))
        claim.stdin.write(b"BEGIN\n"); claim.stdin.flush(); began = True
        require(control._line(claim) == "OBSERVING", "Observer BEGIN outcome unknown")
        require(collect(control, selected, request, observer=observed[0]) == before, "Evidence changed under observer lock")
        require(claim.poll() is None, "Observer disappeared")
        result = copy.deepcopy(before["original"])
        result.update(state="failed-confirmed", finished_at=time.time(), package_built=False,
            runtime_started=False, storage_admitted=False, runtime_qualification="NOT VERIFIED",
            reconciliation={"schema": SCHEMA, "request_sha256": args.request_sha256,
                "unknown_receipt_sha256": request["unknown_receipt_sha256"], "failure": request["failure"],
                "raw_records_unchanged": True, "storage_proof_unchanged": True,
                "historical_certificate_sha256": json.loads(read_raw(control, root + "/request.json"))["certificate_sha256"]})
        raw = canonical(result) + b"\n"; result_sha = digest(raw)
        journal = root + "/reconciliation/" + result_sha
        write_immutable(control, journal + "/result.json", raw)
        write_immutable(control, journal + "/prepared.json", canonical({"schema": SCHEMA,
            "request_sha256": args.request_sha256, "unknown_receipt_sha256": request["unknown_receipt_sha256"], "result_sha256": result_sha}))
        claim.stdin.write(("COMMIT " + result_sha + "\n").encode()); claim.stdin.flush(); claim.stdin.close()
        require(control._line(claim) == "COMMITTED", "Finalization outcome unknown; retain original lease")
        require(read_raw(control, root + "/terminal.json") == raw, "Terminal publication differs")
        verified = read_raw(control, "recovery-build/verified.json", optional=True)
        require((digest(verified) if verified is not None else None) == request["verified_sha256"], "Verified record changed")
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if bounded_capture(control.helper_args("test ! -e /control/active"), data=b"").returncode == 0:
                return {"state": "failed-confirmed", "attempt": request["attempt"], "schema": SCHEMA}
            time.sleep(.25)
        raise BuildControlError("Terminal exists; original lease release unconfirmed")
    finally:
        if claim.stdin and not claim.stdin.closed: claim.stdin.close()
        try: claim.wait(timeout=10)
        except subprocess.TimeoutExpired:
            raise BuildControlError("Observer retained after BEGIN" if began else "Observer did not exit")


def authenticated_control_helpers(control, context):
    """Permit only the existing lease and exact read-only observer commands."""
    require(isinstance(context, dict) and set(context) == {"request", "observer"}, "Unknown helper context")
    request = context["request"]
    validate_request(request)
    require(request["compose_project"] == control.project, "Foreign helper project")
    root = "recovery-build/attempts/" + request["attempt"]
    raw = read_raw(control, root + "/receipt.json")
    require(digest(raw) == request["unknown_receipt_sha256"], "Helper lease receipt changed")
    original = json.loads(raw)
    require(original.get("phase") == "recovery-build" and original.get("state") == "outcome-unknown-resources-retained"
            and original.get("attempt") == request["attempt"] and original.get("compose_project") == control.project
            and original.get("control_volume") == control.volume
            and original.get("helper_container") == "fullmag-control-" + request["attempt"], "Helper lease authority differs")
    actual = inspect_pins(request)["lease"]
    validate_original_owner(actual, original, control, request["containers"]["lease"]["image"])
    require(actual["Config"].get("Entrypoint") == ["/bin/bash"]
            and actual["Config"].get("Cmd") == ["-euo", "pipefail", "-c", control.operation_script("recovery-build", request["attempt"])],
            "Original lease command differs")
    ids = {actual["Id"]}
    observer = context["observer"]
    if observer is not None:
        require(isinstance(observer, dict) and isinstance(observer.get("Id"), str) and SHA.fullmatch(observer["Id"]), "Invalid observer")
        rows = json.loads(docker_capture("inspect", observer["Id"]).stdout)
        require(rows == [observer] and observer["State"]["Running"] is True, "Observer incarnation changed")
        name = observer.get("Name", "")[1:]
        require(re.fullmatch(r"fullmag-recovery-failure-observer-[0-9a-f]{32}", name), "Foreign observer name")
        image = json.loads(docker_capture("image", "inspect", control.image).stdout)[0]["Id"]
        validate_original_owner(observer, {"helper_container": name}, control, image)
        script = claim_script(control, root, request, digest(raw), phase="recovery-build", publish_verified=False)
        require(observer["Config"].get("Entrypoint") == ["/bin/bash"]
                and observer["Config"].get("Cmd") == ["-euo", "pipefail", "-c", script], "Observer command differs")
        ids.add(observer["Id"])
    return ids
