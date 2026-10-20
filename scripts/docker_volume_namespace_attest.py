"""Publish a fresh stopped-backend namespace attestation.

This is an explicit recovery observation for journals written before
``container_state`` was recorded.  It reads the old journal byte-for-byte,
observes the currently stopped container, and publishes only the separate
attestation sidecar under the managed control-volume lock.  It never rewrites
the old journal, clears an activation marker, releases a lease, or starts a
service.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re

import fullmag_storage as storage
from docker_build_control import BuildControl, BuildControlError, docker_capture, toolchain_configuration
from docker_compose_identity import compose_project_identity, validate_source_labels
from docker_volume_activation_reconcile import (
    _control_bytes,
    _json,
    publish_stopped_namespace_attestation,
)


CONTAINER_RE = re.compile(r"[0-9a-f]{64}")
IMAGE_RE = re.compile(r"sha256:[0-9a-f]{64}")


def attest(source_root: Path, container_id: str, image_id: str) -> dict[str, object]:
    if CONTAINER_RE.fullmatch(container_id) is None:
        raise BuildControlError("Namespace attestation requires a complete container identity")
    if IMAGE_RE.fullmatch(image_id) is None:
        raise BuildControlError("Namespace attestation requires an immutable image identity")
    selected = source_root.resolve(strict=True)
    layout = storage.resolve_layout(selected, "docker-all-gpu")
    identity = compose_project_identity(layout)
    configured = toolchain_configuration(selected, identity)
    control = BuildControl(
        identity,
        configured["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"],
    )
    control.prepare()
    inspected = json.loads(docker_capture("inspect", container_id, timeout=90).stdout)
    if len(inspected) != 1 or not isinstance(inspected[0], dict):
        raise BuildControlError("Namespace attestation container identity is ambiguous")
    document = inspected[0]
    if document.get("Id") != container_id or document.get("Image") != image_id:
        raise BuildControlError("Namespace attestation container identity/image differs")
    state = document.get("State")
    if not isinstance(state, dict) or state.get("Running") is not False or state.get("Status") != "exited":
        raise BuildControlError("Namespace attestation requires the backend to be stopped")
    labels = document.get("Config", {}).get("Labels", {})
    if labels.get("com.docker.compose.project") != control.project or labels.get("com.docker.compose.service") != "backend":
        raise BuildControlError("Namespace attestation backend belongs to another Compose group")
    validate_source_labels(document, control.identity)
    relative = "verification/stop-failed-" + container_id + ".json"
    journal_raw = _control_bytes(control, relative)
    journal = _json(journal_raw, "legacy stopped-backend journal")
    if (journal.get("schema") != "fullmag.stop-failed-admission.v1"
            or journal.get("state") != "stopped-confirmed"
            or journal.get("container_id") != container_id
            or journal.get("image_id") != image_id):
        raise BuildControlError("Namespace attestation journal is not the exact stopped backend proof")
    return publish_stopped_namespace_attestation(
        control,
        backend_id=container_id,
        image_id=image_id,
        selected_source=str(selected),
        journal_raw=journal_raw,
        journal=journal,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--container-id", required=True)
    parser.add_argument("--image-id", required=True)
    args = parser.parse_args()
    print(json.dumps(attest(args.source_root, args.container_id, args.image_id), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
