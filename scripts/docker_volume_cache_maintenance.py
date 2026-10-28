"""Retain packages in one exact healthy DEV backend, under its control lease."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

from docker_build_control import (BuildControl, BuildControlError, MIN_FREE_CONTROL_BYTES,
                                  canonical, docker_capture, toolchain_configuration)
from docker_dev_host import docker_argv, require_host


def maintain(args):
    from docker_dev import _select_source, _compose_identity
    from docker_volume_dev import _validate_retained_service
    require_host()
    selected, layout = _select_source(Path(args.repo_root).resolve(strict=True), args.source_root)
    identity = _compose_identity(layout)
    configured = toolchain_configuration(selected, identity)
    control = BuildControl(identity, configured["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"])
    control.prepare(minimum_free_bytes=MIN_FREE_CONTROL_BYTES)
    if not re.fullmatch(r"[a-f0-9]{32}", args.attempt) or not re.fullmatch(r"[a-f0-9]{64}", args.config_sha256):
        raise BuildControlError("Cache maintenance requires exact attempt/configuration pins")
    root = "development/attempts/" + args.attempt
    previous = control.read(root + "/terminal.json")
    document = control.read(root + "/compose.json")
    if (previous.get("state") != "succeeded" or previous.get("compose_project") != control.project
            or previous.get("inputs", {}).get("source_root") != str(selected)
            or document.get("name") != control.project
            or hashlib.sha256(canonical(document)).hexdigest() != args.config_sha256):
        raise BuildControlError("Cache maintenance source or retained configuration differs")
    backend_id = previous.get("backend_container", "")
    if re.fullmatch(r"[a-f0-9]{64}", backend_id) is None:
        raise BuildControlError("Cache maintenance requires the recorded backend incarnation")

    def attest():
        actual = json.loads(docker_capture("inspect", backend_id).stdout)
        if len(actual) != 1:
            raise BuildControlError("Backend inspection is ambiguous")
        actual = actual[0]
        labels = actual.get("Config", {}).get("Labels", {})
        if (actual.get("Id") != backend_id or actual.get("Image") != previous["inputs"]["image_id"]
                or actual.get("State", {}).get("Running") is not True
                or actual["State"].get("Health", {}).get("Status") != "healthy"
                or labels.get("com.docker.compose.project") != control.project
                or labels.get("com.docker.compose.service") != "backend"
                or labels.get("org.fullmag.source.worktree-id") != identity["worktree_id"]):
            raise BuildControlError("Cache maintenance requires the exact healthy owned backend")
        image = json.loads(docker_capture("image", "inspect", actual["Image"]).stdout)
        if len(image) != 1:
            raise BuildControlError("Backend image inspection is ambiguous")
        _validate_retained_service(document, actual, "backend", image[0]["Config"])

    with control.operation("cache-maintenance", {"attempt": args.attempt,
            "config_sha256": args.config_sha256, "backend_container": backend_id},
            minimum_free_bytes=MIN_FREE_CONTROL_BYTES) as operation:
        attest()
        result = run_guest_maintenance(operation, backend_id,
            max_shared_entries=args.max_shared_entries, max_shared_bytes=args.max_shared_bytes)
        control.write(operation["root"] + "/result.json", result)
        operation["receipt"].update(state="succeeded", result=result)
    return 0


def run_guest_maintenance(operation, backend_id, *, max_shared_entries=8, max_shared_bytes=64 * 1024**3):
    """Run after API readiness under the existing group lease, without stopping it."""
    command = [*docker_argv("exec"), backend_id, "/usr/local/bin/python3", "-B",
               "/opt/fullmag/backend_dev.py", "maintain-packages",
               "--max-shared-entries", str(max_shared_entries),
               "--max-shared-bytes", str(max_shared_bytes)]
    # No client timeout: killing Docker exec would not prove the guest
    # stopped. Interruptions retain the durable unknown-outcome lease.
    operation["daemon_pending"] = True
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    tail = bytearray()
    while chunk := process.stdout.read1(65536):
        tail.extend(chunk)
        if len(tail) > 256 * 1024:
            del tail[:-256 * 1024]
        operation["logger"].stdin.write(chunk)
        operation["logger"].stdin.flush()
    code = process.wait()
    operation["daemon_pending"] = False
    operation["receipt"]["exit_code"] = code
    if code:
        raise BuildControlError("Package maintenance failed; inspect the retained operation log")
    try:
        result = json.loads(bytes(tail).splitlines()[-1])
    except (ValueError, IndexError) as error:
        raise BuildControlError("Package maintenance returned no result receipt") from error
    if result.get("schema") != "fullmag.package-maintenance.v1" or result.get("state") != "succeeded":
        raise BuildControlError("Package maintenance result is invalid")
    return result
