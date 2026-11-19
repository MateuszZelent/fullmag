"""Read-only proof for a saved-authoring OCI rejection before a new PID 1."""
from __future__ import annotations
import json
from pathlib import Path
from docker_build_control import BuildControlError, canonical

SCHEMA = "fullmag.docker-iteration-prestart-reconciliation.v1"


def validate_failure_pin(proof):
    from docker_volume_reconcile import require, SHA
    require(isinstance(proof, dict) and set(proof) == {
        "checkpoint_sha256", "drain_sha256", "preflight_sha256",
        "backend_state_sha256", "frontend_state_sha256", "error_sha256",
    }, "Exact prestart failure pins required")
    require(all(isinstance(v, str) and SHA.fullmatch(v) for v in proof.values()),
            "Invalid prestart digest")


def validate_stopped_states(actual, proof):
    from docker_volume_reconcile import require, digest
    validate_failure_pin(proof)
    for name in ("backend", "frontend"):
        state = actual[name].get("State", {})
        require(digest(canonical(state)) == proof[name + "_state_sha256"],
                "Prestart Docker state CAS differs: " + name)
        require(state.get("Status") == "exited" and state.get("Pid") == 0
                and all(state.get(key) is False for key in
                        ("Running", "Paused", "Restarting", "OOMKilled", "Dead")),
                "Prestart service is not confirmed stopped: " + name)
    backend, frontend = actual["backend"]["State"], actual["frontend"]["State"]
    error = backend.get("Error")
    require(backend.get("ExitCode") == 128 and isinstance(error, str)
            and digest(error.encode()) == proof["error_sha256"]
            and "error running prestart hook #0" in error
            and "nvidia-container-cli: ldcache error: process /sbin/ldconfig terminated with signal 9" in error,
            "Only the pinned NVIDIA prestart hook rejection is supported")
    require(frontend.get("ExitCode") == 0 and frontend.get("Error") == "",
            "Frontend did not stop cleanly")


def validate_failure(control, root, request, original, actual, state):
    from docker_volume_reconcile import require, digest, read_raw
    import docker_volume_dev as dev
    from docker_volume_stop_unadmitted import _read_terminal_process_receipt
    require(digest(Path(__file__).read_bytes()) == request["prestart_helper_sha256"],
            "Prestart helper code differs from reviewed request")
    proof = request["failure"]
    validate_stopped_states(actual, proof)
    documents = {}
    for name, filename in (("checkpoint", "saved-authoring-checkpoint.json"),
                           ("drain", "backend-drain.json"),
                           ("preflight", "saved-authoring-final-preflight.json")):
        raw = read_raw(control, root + "/" + filename)
        require(digest(raw) == proof[name + "_sha256"], "Prestart evidence CAS differs: " + name)
        documents[name] = json.loads(raw)
    checkpoint, drain, probe = (documents[name] for name in ("checkpoint", "drain", "preflight"))
    require(original.get("inputs", {}).get("saved_authoring_checkpoint_sha256") == proof["checkpoint_sha256"]
            and checkpoint.get("archive") == original.get("saved_authoring_restore_required"),
            "Original authoring checkpoint obligation differs")
    dev._saved_authoring_validate_request(checkpoint, project=control.project,
        attempt=original["inputs"]["attempt"], config_sha256=request["config_sha256"],
        selected=Path(request["source_root"]))
    for name in ("backend", "frontend"):
        require(checkpoint["containers"][name] == request["containers"][name],
                "Prestart service differs from original checkpoint: " + name)
    raw, current = _read_terminal_process_receipt(actual["backend"], control)
    require(drain.get("schema") == "fullmag.docker-idle-restart-drain.v1"
            and drain.get("backend_container_id") == request["containers"]["backend"]["id"]
            and digest(raw) == drain.get("process_receipt_sha256")
            and current == drain.get("process_receipt"), "Native terminal receipt changed")
    dev._saved_authoring_validate_drain(probe, current)
    dev._saved_authoring_verify_retained_history(checkpoint, state)
    dev._saved_authoring_read_archive(checkpoint, state)
    require(read_raw(control, root + "/backend-build-receipt.json", optional=True) is None
            and "backend_started_at" not in original,
            "A new backend generation or build publication was observed")
    return dict(proof)


def continuation(control, args, previous, document, actual, state):
    """Validate the exact reconciled failure again before the one managed retry."""
    from docker_volume_reconcile import require, digest, read_raw, fingerprint
    reference = getattr(args, "prestart_reconciliation", None)
    sha = getattr(args, "prestart_reconciliation_sha256", None)
    require(bool(reference) == bool(sha), "Both prestart reconciliation pins are required")
    if reference is None:
        return None
    from docker_volume_reconcile import TOKEN, SHA
    require(isinstance(reference, str) and TOKEN.fullmatch(reference)
            and isinstance(sha, str) and SHA.fullmatch(sha), "Invalid prestart continuation pins")
    require(getattr(args, "restart_backend", False), "Prestart continuation requires explicit backend restart")
    root = "iteration/attempts/" + reference
    raw = read_raw(control, root + "/terminal.json")
    require(digest(raw) == sha, "Confirmed prestart receipt CAS differs")
    terminal = json.loads(raw)
    reconciliation = terminal.get("reconciliation", {})
    require(terminal.get("state") == "failed-confirmed"
            and terminal.get("attempt") == reference and terminal.get("phase") == "iteration"
            and terminal.get("inputs", {}).get("attempt") == args.attempt
            and terminal.get("inputs", {}).get("config_sha256") == args.config_sha256
            and terminal.get("state_root") == previous.get("state_root")
            and terminal.get("compose_project") == control.project,
            "Confirmed prestart operation differs")
    require(terminal.get("prestart_failure_proof") == reconciliation.get("evidence"),
            "Confirmed prestart proof differs")
    request_raw = read_raw(control, reconciliation["request"])
    require(digest(request_raw) == reconciliation.get("request_sha256"), "Prestart request CAS differs")
    request = json.loads(request_raw)
    require(request.get("schema") == SCHEMA and request.get("attempt") == reference
            and request.get("config_sha256") == args.config_sha256
            and request.get("source_root") == terminal["inputs"].get("source_root")
            and request.get("compose_project") == control.project,
            "Prestart request identity differs")
    require(terminal.get("prestart_failure_proof") == request.get("failure"),
            "Confirmed proof does not match request")
    require(document["services"]["backend"]["environment"].get("FULLMAG_STARTUP_ENABLED") != "1",
            "Prestart continuation never activates a startup script")
    for name in ("backend", "frontend"):
        pin = request["containers"][name]
        observed = actual[name]
        require(observed.get("Id") == pin["id"] and observed.get("Image") == pin["image"]
                and observed.get("State", {}).get("StartedAt") == pin["started_at"]
                and fingerprint(observed) == pin["fingerprint"], "Prestart continuation incarnation changed")
    original_raw = read_raw(control, root + "/unknown-receipt.json")
    require(digest(original_raw) == request["unknown_receipt_sha256"], "Original prestart receipt changed")
    validate_failure(control, root, request, json.loads(original_raw), actual, state)
    checkpoint = json.loads(read_raw(control, root + "/saved-authoring-checkpoint.json"))
    return checkpoint, request["failure"]["checkpoint_sha256"]
