"""Explicit launcher handoff for a published pending-recovery successor."""
from __future__ import annotations

import hashlib
from typing import Mapping

from docker_build_control import BuildControlError
from docker_volume_dev import RetainedContainerRecoveryContext

SCHEMA = "fullmag.pending-recovery-successor.v1"


class PendingRecoverySuccessorContext(RetainedContainerRecoveryContext):
    def __init__(self, context, witness):
        super().__init__(context)
        self.witness = dict(witness)


def option_pins(path, digest):
    from docker_volume_container_recovery import _relative_control_path, _require_sha
    if bool(path) != bool(digest):
        raise BuildControlError("Pending recovery successor requires paired proof and SHA-256")
    if not path:
        return None
    return _relative_control_path(path), _require_sha(digest, "pending recovery successor SHA-256")


def retained_context(control, previous, document, actual, path, digest, *, removed_container_proof=None):
    import docker_volume_container_recovery as recovery
    from docker_volume_dev import _validate_recovery_environment, _validate_recovery_metadata
    path, digest = option_pins(path, digest)
    raw = recovery._control_bytes(control, path)
    if raw is None or hashlib.sha256(raw).hexdigest() != digest:
        raise BuildControlError("Pending recovery successor binding is absent or changed")
    binding = recovery._parse_json(raw, "pending recovery successor")
    fields = {"schema", "candidate", "preview", "stop_witness", "authorization",
              "development_attempt", "compose_config_sha256"}
    if not isinstance(binding, Mapping) or set(binding) != fields or binding.get("schema") != SCHEMA:
        raise BuildControlError("Pending recovery successor binding has an invalid schema")
    for key in ("candidate", "preview", "stop_witness", "authorization"):
        pin = binding[key]
        if not isinstance(pin, Mapping) or set(pin) != {"path", "sha256"}:
            raise BuildControlError("Pending recovery successor document pin is invalid")
        recovery._relative_control_path(pin["path"])
        recovery._require_sha(pin["sha256"], key)
    if (binding["development_attempt"] != previous.get("attempt")
            or binding["compose_config_sha256"] != hashlib.sha256(recovery._canonical(document)).hexdigest()):
        raise BuildControlError("Pending recovery successor selects a different development attempt")
    from docker_prepare_pending_recovery_successor import validate_published
    context = validate_published(control, previous, document, actual, binding,
                                 removed_container_proof=removed_container_proof)
    if not isinstance(context, Mapping) or set(context) != {"recovery_environment", "recovery_metadata"}:
        raise BuildControlError("Pending recovery successor validator returned an invalid handoff")
    validated = {
        "recovery_environment": _validate_recovery_environment(context["recovery_environment"]),
        "recovery_metadata": _validate_recovery_metadata(context["recovery_metadata"]),
    }
    return PendingRecoverySuccessorContext(validated, {"proof_path": path, "proof_sha256": digest})
