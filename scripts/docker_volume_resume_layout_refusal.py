"""Qualify a stopped resume refused before frontend allocation or service start."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import shlex
import time

from docker_build_control import BuildControl, canonical, docker_capture, toolchain_configuration
from docker_volume_reconcile import (LAYOUT_REFUSAL_SCHEMA as SCHEMA, SCHEMA as STANDARD,
    SHA, TOKEN, digest, fingerprint, read_raw, require, write_immutable)

ERROR = "Single-volume group cannot fall back to legacy volume allocation; resume its pinned layout"
ABSENT_FILES = ("frontend-seed.json", "backend-build-receipt.json", "provenance.json",
    "storage-probe-log.json", "worker-cgroup-compose.json", "worker-cgroup-log.json")
CONTROLLERS = ("docker_volume_reconcile.py", "docker_volume_resume_layout_refusal.py",
    "docker_volume_activation_reconcile.py", "docker_build_control.py", "docker_volume_dev.py")


def optional_sha(control, path):
    raw = read_raw(control, path, optional=True)
    return digest(raw) if raw is not None else None


def validate_shape(request):
    from docker_volume_reconcile import validate_request
    require(isinstance(request, dict) and set(request) == {
        "schema", "attempt", "compose_project", "source_root", "port", "config_sha256",
        "unknown_receipt_sha256", "controller_sha256", "containers", "failure"},
        "Layout refusal request keys differ")
    standard = {key: value for key, value in request.items() if key != "failure"}
    standard.update(schema=STANDARD, package_documents={"receipt": "0"*64, "provenance": "0"*64})
    validate_request(standard)
    require(request["schema"] == SCHEMA, "Layout refusal schema differs")
    proof = request["failure"]
    require(isinstance(proof, dict) and set(proof) == {
        "previous_receipt_sha256", "compose_sha256", "private_owner_sha256", "frontend_inputs_sha256",
        "helper_log_sha256", "service_states", "engine_id", "current_sha256", "verified_sha256",
        "controllers"}, "Layout refusal proof keys differ")
    for key in ("previous_receipt_sha256", "compose_sha256", "private_owner_sha256",
                "frontend_inputs_sha256", "helper_log_sha256"):
        require(isinstance(proof[key], str) and SHA.fullmatch(proof[key]), "Invalid refusal pin: " + key)
    for key in ("current_sha256", "verified_sha256"):
        require(proof[key] is None or isinstance(proof[key], str) and SHA.fullmatch(proof[key]),
            "Invalid prior pointer pin")
    for key, names in (("service_states", {"backend", "frontend"}), ("controllers", set(CONTROLLERS))):
        require(isinstance(proof[key], dict) and set(proof[key]) == names
            and all(isinstance(value, str) and SHA.fullmatch(value) for value in proof[key].values()),
            "Incomplete refusal evidence: " + key)
    require(isinstance(proof["engine_id"], str) and bool(proof["engine_id"]), "Missing engine identity")


def validate_original(original, previous, actual):
    require(original.get("phase") == "resume"
        and original.get("state") == "outcome-unknown-resources-retained"
        and original.get("error") == ERROR and original.get("private_group_storage") is None
        and previous.get("state") == "succeeded" and previous.get("private_group_storage") == "group-volume-v1",
        "Not the exact pre-allocation private-layout refusal")
    require(all(original.get(key) is None for key in (
        "worker_cgroup", "worker_cgroup_helper", "config_sha256", "prestart_reconciliation",
        "terminal_prestart_reconciliation", "saved_authoring_restore_required")),
        "Resume crossed admission or carries a recovery obligation")
    for name in ("backend", "frontend"):
        observed = actual[name]
        state = observed["State"]
        require(observed["Id"] == original.get(name + "_container")
            and state.get("StartedAt") == original.get(name + "_started_at"),
            "Service incarnation changed after refusal")
        require(state.get("Status") == "exited" and state.get("Running") is False
            and state.get("Pid") == 0 and state.get("ExitCode") == 255
            and all(state.get(key) is False for key in ("OOMKilled", "Dead", "Restarting", "Paused"))
            and not state.get("Error"), "Refused resume requires stopped exit-255 services")
        from docker_volume_development_interrupted import _docker_timestamp_ns
        require(_docker_timestamp_ns(state["FinishedAt"]) < int(original["started_at"] * 1e9),
            "Service stopped during or after the refused resume")


def validate_failure(control, root, request, original, actual, state):
    from docker_volume_activation_reconcile import _validate_helper, _validate_helper_logged
    proof = request["failure"]
    source = Path(request["source_root"])
    for name, sha in proof["controllers"].items():
        require(digest((source / "scripts" / name).read_bytes()) == sha, "Refusal controller changed: " + name)
    require(docker_capture("info", "--format", "{{.ID}}").stdout.decode().strip() == proof["engine_id"],
        "Docker engine changed")
    base = "development/attempts/" + original["inputs"]["attempt"]
    previous = json.loads(read_raw(control, base + "/terminal.json"))
    validate_original(original, previous, actual)
    for path, key in ((base + "/terminal.json", "previous_receipt_sha256"),
        (base + "/compose.json", "compose_sha256"), ("private/.owner.json", "private_owner_sha256"),
        ("frontend/development-inputs.json", "frontend_inputs_sha256")):
        require(digest(read_raw(control, path)) == proof[key], "Refusal evidence changed: " + path)
    import docker_group_storage
    require(json.loads(read_raw(control, "private/.owner.json"))
        == docker_group_storage.owner_manifest(control, source), "Private layout owner is not authenticated")
    require(all(read_raw(control, root + "/" + name, optional=True) is None for name in ABSENT_FILES),
        "Resume produced allocation, publication or admission evidence")
    helper, helper_id = _validate_helper(control, original["helper_container"], request["attempt"], phase="resume")
    require(helper_id == actual["lease"]["Id"] and fingerprint(helper) == request["containers"]["lease"]["fingerprint"],
        "Original helper incarnation differs")
    require(digest(_validate_helper_logged(helper_id).encode()) == proof["helper_log_sha256"],
        "Original helper acknowledgement changed")
    require({name: digest(canonical(actual[name]["State"])) for name in ("backend", "frontend")}
        == proof["service_states"], "Stopped service state changed")
    require(optional_sha(control, "resume/verified.json") == proof["verified_sha256"],
        "Last verified resume changed")
    # A partial terminal-last commit may already have published its exact result
    # to current. The generic journal validator authenticates those bytes.
    current = read_raw(control, "resume/current.json", optional=True)
    if (digest(current) if current is not None else None) != proof["current_sha256"]:
        pending = read_raw(control, root + "/receipt.json")
        value = json.loads(pending)
        require(current == pending and value.get("state") == "failed-confirmed"
            and value.get("layout_refusal_proof") == proof, "Prior resume pointer changed")
    return dict(proof)


def pointer_cas_script(control, request, result_sha):
    proof = request["failure"]
    chunks = ["exec 8<>/control/operation.lock; if flock -n 8; then exit 72; fi; "]
    for name, expected, allow_result in (("current", proof["current_sha256"], True),
                                        ("verified", proof["verified_sha256"], False)):
        path = shlex.quote(control.path("resume/" + name + ".json"))
        checks = f"test -f {path}; test ! -L {path}; test $(stat -c %h {path}) = 1; s=$(sha256sum {path} | cut -d' ' -f1); "
        alternatives = ([expected] if expected is not None else []) + ([result_sha] if allow_result else [])
        match = " || ".join('test "$s" = ' + shlex.quote(value) for value in alternatives) or "false"
        if expected is None:
            chunks.append(f"test ! -L {path}; if test -e {path}; then {checks}{match}; fi; ")
        else:
            chunks.append(checks + match + "; ")
    return "".join(chunks)


def verify_finalization(control, root, request, result_raw):
    for path in (root + "/receipt.json", root + "/terminal.json", "resume/current.json"):
        require(read_raw(control, path) == result_raw, "Failure-only publication differs: " + path)
    require(optional_sha(control, "resume/verified.json") == request["failure"]["verified_sha256"],
        "Failure-only publication changed verified resume")


def completed(control, root, request, request_sha):
    """Observe an already committed refusal without requiring its retired helper."""
    raw = read_raw(control, root + "/terminal.json", optional=True)
    if raw is None:
        return False
    value = json.loads(raw)
    reconciliation = value.get("reconciliation", {})
    require(value.get("schema") == "fullmag.docker-build-operation.v1"
        and value.get("phase") == "resume" and value.get("attempt") == request["attempt"]
        and value.get("compose_project") == control.project and value.get("control_volume") == control.volume
        and value.get("state") == "failed-confirmed" and value.get("error") == ERROR
        and value.get("layout_refusal_proof") == request["failure"]
        and reconciliation.get("request_sha256") == request_sha
        and reconciliation.get("unknown_receipt_sha256") == request["unknown_receipt_sha256"],
        "Completed refusal terminal identity differs")
    require(digest(read_raw(control, root + "/unknown-receipt.json")) == request["unknown_receipt_sha256"],
        "Completed refusal original receipt differs")
    journal = root + "/reconciliation/" + digest(raw)
    prepared = json.loads(read_raw(control, journal + "/prepared.json"))
    require(read_raw(control, journal + "/result.json") == raw
        and prepared.get("request_sha256") == request_sha
        and prepared.get("unknown_receipt_sha256") == request["unknown_receipt_sha256"]
        and prepared.get("result_sha256") == digest(raw), "Completed refusal prepared journal differs")
    verify_finalization(control, root, request, raw)
    wait_release(control, request)
    return True


def wait_release(control, request):
    from docker_volume_activation_reconcile import _probe_helper_absence
    name = "fullmag-control-" + request["attempt"]
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        active = read_raw(control, "active", optional=True)
        require(active in (None, (request["attempt"] + "\n").encode()), "Control owner changed during release")
        absent = _probe_helper_absence(name)
        if absent is not None and active is None:
            require(read_raw(control, "active", optional=True) is None, "Control owner changed after helper exit")
            return
        if absent is None:
            inspected = docker_capture("inspect", name, allow_failure=True)
            if inspected.returncode:
                require(_probe_helper_absence(name) is not None, "Helper absence is not authoritative")
            else:
                values = json.loads(inspected.stdout)
                require(len(values) == 1 and values[0].get("Id") == request["containers"]["lease"]["id"],
                    "Original helper name has another occupant")
        time.sleep(.25)
    require(False, "Original helper exit and control lease release not confirmed")


def build_request(args):
    from docker_dev import _select_source, _compose_identity
    from docker_volume_activation_reconcile import _validate_helper, _validate_helper_logged
    require(TOKEN.fullmatch(args.attempt) is not None, "Exact resume attempt required")
    source, layout = _select_source(Path(args.source_root).resolve(strict=True), Path(args.source_root))
    identity = _compose_identity(layout)
    image = toolchain_configuration(source, identity)["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"]
    control = BuildControl(identity, image)
    root = "resume/attempts/" + args.attempt
    original_raw = read_raw(control, root + "/receipt.json")
    original = json.loads(original_raw)
    base = "development/attempts/" + original["inputs"]["attempt"]
    compose_raw = read_raw(control, base + "/compose.json")
    document = json.loads(compose_raw)
    helper, helper_id = _validate_helper(control, original["helper_container"], args.attempt, phase="resume")
    actual = {"lease": helper}
    for name in ("backend", "frontend"):
        records = json.loads(docker_capture("inspect", original[name + "_container"]).stdout)
        require(len(records) == 1, "Ambiguous stopped service")
        actual[name] = records[0]
    proof = {"previous_receipt_sha256": digest(read_raw(control, base + "/terminal.json")),
        "compose_sha256": digest(compose_raw), "private_owner_sha256": digest(read_raw(control, "private/.owner.json")),
        "frontend_inputs_sha256": digest(read_raw(control, "frontend/development-inputs.json")),
        "helper_log_sha256": digest(_validate_helper_logged(helper_id).encode()),
        "service_states": {name: digest(canonical(actual[name]["State"])) for name in ("backend", "frontend")},
        "engine_id": docker_capture("info", "--format", "{{.ID}}").stdout.decode().strip(),
        "current_sha256": optional_sha(control, "resume/current.json"),
        "verified_sha256": optional_sha(control, "resume/verified.json"),
        "controllers": {name: digest((source / "scripts" / name).read_bytes()) for name in CONTROLLERS}}
    request = {"schema": SCHEMA, "attempt": args.attempt, "source_root": str(source),
        "compose_project": control.project, "port": args.port, "config_sha256": digest(canonical(document)),
        "unknown_receipt_sha256": digest(original_raw), "controller_sha256": proof["controllers"]["docker_volume_reconcile.py"],
        "failure": proof, "containers": {name: {"id": value["Id"], "image": value["Image"],
            "started_at": value["State"]["StartedAt"], "fingerprint": fingerprint(value)} for name, value in actual.items()}}
    validate_shape(request)
    validate_failure(control, root, request, original, actual, Path(original["state_root"]))
    raw = canonical(request) + b"\n"
    path = "verification/resume-layout-refusal/" + args.attempt + "/" + digest(raw) + "/request.json"
    write_immutable(control, path, raw)
    return {"state": "request-pinned", "request": path, "request_sha256": digest(raw)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", required=True)
    parser.add_argument("--attempt", required=True)
    parser.add_argument("--port", required=True, type=int)
    print(json.dumps(build_request(parser.parse_args())))
