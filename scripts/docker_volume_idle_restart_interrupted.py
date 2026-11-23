"""Close an interrupted DEV idle restart after both fixed services have started."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import time
import uuid

from docker_build_control import BuildControl, BuildControlError, canonical, docker_capture, toolchain_configuration
from docker_volume_reconcile import (
    INTERRUPTED_IDLE_RESTART_SCHEMA as SCHEMA, SHA, TOKEN, claim_script, digest, fingerprint,
    require, write_immutable,
)


def validate_restart(receipt, previous, drain, *, token, project, volume, source):
    inputs = receipt.get("inputs", {})
    require(receipt.get("schema") == "fullmag.docker-build-operation.v1"
            and receipt.get("phase") == "iteration"
            and receipt.get("state") == "restarting-idle-backend"
            and receipt.get("attempt") == token
            and receipt.get("compose_project") == project
            and receipt.get("control_volume") == volume
            and receipt.get("helper_container") == "fullmag-control-" + token
            and not receipt.get("saved_authoring_restore_required")
            and not receipt.get("api_quiescence_intent_sha256")
            and inputs.get("source_root") == source,
            "Only a pinned, ordinary idle restart can be closed")
    require(previous.get("state") == "succeeded"
            and previous.get("attempt") == inputs.get("attempt")
            and previous.get("compose_project") == project
            and previous.get("control_volume") == volume
            and previous.get("config_sha256") == inputs.get("config_sha256")
            and previous.get("state_root") == receipt.get("state_root")
            and previous.get("ledger_profile") == "group-ledger-v1",
            "Original successful Linux development receipt differs")
    for service in ("backend", "frontend"):
        identifier = receipt.get(service + "_container", "")
        started = receipt.get(service + "_started_at")
        original_start = previous.get(service + "_started_at")
        require(SHA.fullmatch(identifier) and previous.get(service + "_container") == identifier
                and isinstance(started, str) and isinstance(original_start, str)
                and started > original_start,
                "Both restarted service incarnations must be durably pinned")
    process = drain.get("process_receipt", {})
    # The native runtime writes sorted compact JSON with ASCII escapes and a trailing newline.
    process_raw = (json.dumps(process, sort_keys=True, separators=(",", ":")) + "\n").encode()
    require(drain.get("schema") == "fullmag.docker-idle-restart-drain.v1"
            and drain.get("backend_container_id") == receipt["backend_container"]
            and drain.get("process_receipt_sha256") == digest(process_raw)
            and process.get("schema") == "fullmag.docker-process-tree.v1"
            and process.get("state") == "drained" and process.get("api_exit_code") in (0, -15)
            and process.get("terminal_service_owner", {}).get("state") == "drained",
            "Original graceful native drain proof is incomplete")


def observe(control, selected, layout, token, receipt_sha, *, observer=None):
    import docker_volume_dev as dev
    import fullmag_storage as storage

    root = f"iteration/attempts/{token}"
    raw = control.read_bytes(root + "/receipt.json")
    require(digest(raw) == receipt_sha, "Interrupted restart receipt CAS differs")
    require(control.read_bytes("active") == (token + "\n").encode(), "Different operation owns the active marker")
    require(control.read_bytes(root + "/terminal.json", optional=True) is None, "Restart is already terminal")
    receipt = json.loads(raw)
    parent = receipt.get("inputs", {}).get("attempt", "")
    require(TOKEN.fullmatch(parent), "Original development UUID is missing")
    parent_root = f"development/attempts/{parent}"
    previous_raw = control.read_bytes(parent_root + "/terminal.json")
    drain_raw = control.read_bytes(root + "/backend-drain.json")
    validate_restart(receipt, json.loads(previous_raw), json.loads(drain_raw), token=token,
                     project=control.project, volume=control.volume, source=str(selected))
    document_raw = control.read_bytes(root + "/compose.json")
    document = json.loads(document_raw)
    require(document.get("name") == control.project and set(document.get("services", {})) == {"backend", "frontend"}
            and digest(canonical(document)) == receipt["inputs"]["config_sha256"],
            "Restart Compose identity differs")
    require(not any(name.startswith("FULLMAG_STARTUP_") for name in document["services"]["backend"]["environment"]),
            "Automatic script startup is outside idle restart recovery")
    state = storage.validate_path(Path(receipt["state_root"]), layout["runtime_root"], "retained restart state")
    certificate = dev._retained_certificate(state, document)
    require(certificate.get("storage_profile") == "linux-native-v1"
            and certificate.get("restart_verified") is True, "Retained Linux storage has not passed admission")
    require(control.read_bytes(root + "/handoff-log.json", optional=True) is None,
            "Restart finalization has already started publishing evidence")
    require(control.read_bytes(root + "/backend-build-receipt.json", optional=True) is None,
            "Restart has already published a backend build receipt")

    helper = control._inspect_operation_helper({"receipt": receipt})
    log = docker_capture("logs", "--tail", "3", helper, timeout=10).stdout
    require(log.splitlines() == [b"READY", b"LOGGED"], "Original launcher has not closed the operation log")
    ids = {service: receipt[service + "_container"] for service in ("backend", "frontend")}
    group = docker_capture("ps", "-a", "--no-trunc", "--filter",
                           "label=com.docker.compose.project=" + control.project,
                           "--format", "{{.ID}}", timeout=10).stdout.decode().splitlines()
    expected = {*ids.values(), helper}
    if observer is not None:
        expected.add(observer)
    require(len(group) == len(expected) and set(group) == expected, "Additional DEV operation or container found")
    actual = {}
    for service, identifier in ids.items():
        row, = json.loads(docker_capture("inspect", identifier, timeout=10).stdout)
        image = document["services"][service]["image"]
        image_row, = json.loads(docker_capture("image", "inspect", image, timeout=10).stdout)
        require(dev._service_readiness_satisfied(document, row, service, image_row["Config"],
                expected_image=image, expected_started_at=receipt[service + "_started_at"], headless=False),
                "Restarted service is not ready")
        actual[service] = row
    dev._assert_private_restart_network(actual, ids, control.project)
    verified = control.read_bytes("iteration/verified.json", optional=True)
    return raw, receipt, {
        "schema": SCHEMA, "attempt": token, "receipt_sha256": receipt_sha, "helper_id": helper,
        "compose_sha256": digest(document_raw), "development_terminal_sha256": digest(previous_raw),
        "previous_native_drain_sha256": digest(drain_raw),
        "verified_sha256": None if verified is None else digest(verified),
        "containers": {name: {"id": entry["Id"], "started_at": entry["State"]["StartedAt"],
                              "fingerprint": fingerprint(entry)} for name, entry in actual.items()},
    }


def reconcile(args):
    from docker_dev import _compose_identity, _select_source

    require(TOKEN.fullmatch(args.attempt) and SHA.fullmatch(args.receipt_sha256), "Invalid restart pins")
    selected, layout = _select_source(args.source_root, args.source_root)
    identity = _compose_identity(layout)
    config = toolchain_configuration(selected, identity)
    control = BuildControl(identity, config["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"])
    args_tuple = control, selected, layout, args.attempt, args.receipt_sha256
    original, receipt, proof = observe(*args_tuple)
    plan_sha = digest(canonical(proof))
    if not args.apply:
        print(json.dumps({"state": "validated-only", "plan_sha256": plan_sha, **proof}, indent=2))
        return
    require(args.expected_plan_sha256 == plan_sha, "Interrupted restart recovery plan CAS differs")
    root = "iteration/attempts/" + args.attempt
    request = {"schema": SCHEMA, "attempt": args.attempt, "unknown_receipt_sha256": args.receipt_sha256}
    script = claim_script(control, root, request, args.receipt_sha256, publish_verified=False)
    name = "fullmag-idle-restart-observer-" + uuid.uuid4().hex
    claim = subprocess.Popen(control.helper_args(script, name=name), stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        require(control._line(claim, timeout=30) == "READY", "Restart recovery observer lock was not admitted")
        observer, = json.loads(docker_capture("inspect", name, timeout=10).stdout)
        require(observe(*args_tuple, observer=observer["Id"])[2] == proof, "Restart proof changed under the observer lock")
        write_immutable(control, root + "/unknown-receipt.json", original)
        failed = {**receipt, "state": "failed-confirmed", "finished_at": time.time(),
                  "error": "Idle restart finalization interrupted after the fixed services started",
                  "reconciliation": {**proof, "plan_sha256": plan_sha, "restart_replayed": False}}
        result = canonical(failed) + b"\n"
        journal = root + "/reconciliation/" + digest(result)
        write_immutable(control, journal + "/result.json", result)
        claim.stdin.write(b"BEGIN\nCOMMIT " + digest(result).encode() + b"\n")
        claim.stdin.flush()
        require(control._line(claim, timeout=30) == "OBSERVING", "Observer BEGIN outcome is unknown")
        require(control._line(claim, timeout=30) == "COMMITTED", "Observer terminal publication outcome is unknown")
    finally:
        claim.stdin.close()
    require(claim.wait(timeout=30) == 0, "Restart observer did not terminate cleanly")
    require(control.read_bytes(root + "/terminal.json") == result, "Restart terminal differs from the journal")
    for _ in range(30):
        if control.read_bytes("active", optional=True) is None:
            break
        time.sleep(0.25)
    else:
        raise BuildControlError("Terminal published but original helper has not released the operation marker")
    verified = control.read_bytes("iteration/verified.json", optional=True)
    require((None if verified is None else digest(verified)) == proof["verified_sha256"],
            "Last verified iteration changed during failure-only reconciliation")
    print(json.dumps({"state": "failed-confirmed", "attempt": args.attempt, "plan_sha256": plan_sha,
                      "released": True, "restart_replayed": False}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--attempt", required=True)
    parser.add_argument("--receipt-sha256", required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--expected-plan-sha256")
    try:
        reconcile(parser.parse_args())
    except (BuildControlError, ValueError, OSError) as error:
        parser.exit(1, f"idle-restart-reconcile: {error}\n")


if __name__ == "__main__":
    main()
