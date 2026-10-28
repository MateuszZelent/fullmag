"""Reconcile one retained, unknown Docker DEV activation lease.

This module handles only the narrow case in which the activation helper owns
the control lease, the backend has already been stopped by the managed
failed-stop route, and the host lost the observation before activation had a
known outcome.  It never retries the startup script, removes the activation
marker, releases a solver lease, or deletes the original unknown receipt.
"""
from __future__ import annotations

import base64
import hashlib
import json
from collections.abc import Mapping
import re
import shlex
import time

from docker_build_control import (
    BuildControl,
    BuildControlError,
    MAX_DOCUMENT_BYTES,
    bounded_capture,
    canonical,
    control_read_script,
    docker_capture,
)
from docker_compose_identity import source_labels, validate_source_labels


ATTEMPT_RE = re.compile(r"^[0-9a-f]{32}$")
CONTAINER_ID_RE = re.compile(r"^[0-9a-f]{64}$")
IMAGE_ID_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
MAX_TEXT = 4096

ACTIVATION_RECONCILIATION_SCHEMA = "fullmag.docker-activation-reconciliation.v1"
ACTIVATION_UNRESOLVED_SCHEMA = "fullmag.docker-activation-unresolved.v1"
OPERATION_SCHEMA = "fullmag.docker-build-operation.v1"
NAMESPACE_ATTESTATION_SCHEMA = "fullmag.docker-stopped-namespace-attestation.v1"
UNKNOWN_STATE = "unknown-retained"
UNKNOWN_REASON = "backend-namespace-stopped"


def _fail(message: str) -> BuildControlError:
    return BuildControlError(message)


def _control_bytes(control: BuildControl, relative: str, *, optional: bool = False) -> bytes | None:
    """Read one bounded, regular control-volume file through the pinned image."""
    path = control.path(relative)
    script = control_read_script(path)
    result = bounded_capture(control.helper_args(script), data=b"", timeout=90)
    if optional and result.returncode == 44:
        return None
    if result.returncode:
        detail = result.stderr.decode("utf-8", "replace")[-1024:]
        raise _fail(f"cannot read control-volume record {relative}: {detail}")
    if len(result.stdout) > MAX_DOCUMENT_BYTES:
        raise _fail(f"control-volume record {relative} exceeds its size bound")
    return bytes(result.stdout)


def _json(raw: bytes, label: str) -> dict[str, object]:
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise _fail(f"{label} is not valid JSON") from error
    if not isinstance(value, dict):
        raise _fail(f"{label} is not a JSON object")
    return value


def _read_json(control: BuildControl, relative: str, *, optional: bool = False) -> dict[str, object] | None:
    raw = _control_bytes(control, relative, optional=optional)
    return None if raw is None else _json(raw, f"control-volume record {relative}")


def _text(value: object, label: str) -> str:
    if not isinstance(value, str) or not value or "\x00" in value or len(value) > MAX_TEXT:
        raise _fail(f"{label} is not a bounded text value")
    return value


def _hash(value: object, label: str) -> str:
    if not isinstance(value, str) or SHA256_RE.fullmatch(value) is None:
        raise _fail(f"{label} is not a lowercase SHA-256")
    return value


def _attempt(value: object, label: str) -> str:
    if not isinstance(value, str) or ATTEMPT_RE.fullmatch(value) is None:
        raise _fail(f"{label} is not an operation token")
    return value


def _container(value: object, label: str) -> str:
    if not isinstance(value, str) or CONTAINER_ID_RE.fullmatch(value) is None:
        raise _fail(f"{label} is not a container identity")
    return value


def _image(value: object, label: str) -> str:
    if not isinstance(value, str) or IMAGE_ID_RE.fullmatch(value) is None:
        raise _fail(f"{label} is not an immutable image identity")
    return value


def _namespace_attestation_path(backend_id: str) -> str:
    _container(backend_id, "stopped namespace backend")
    return "verification/stopped-namespace-attestation-" + backend_id + ".json"


def _activation_reconciliation_token(activation_attempt: str) -> str:
    return hashlib.sha256(
        b"fullmag.docker-activation-reconciliation.v1:" + activation_attempt.encode("ascii")
    ).hexdigest()[:32]


def _activation_marker_path(key: str) -> str:
    return "/opt/fullmag/control/backend/script-activation-" + key + "/activation.json"


def _validate_native_restart_metadata(
    metadata: object,
    *,
    backend_id: str,
    image_id: str,
) -> dict[str, object]:
    if not isinstance(metadata, Mapping):
        raise _fail("Unknown activation recovery requires native failed-stop metadata")
    if metadata.get("schema") != "fullmag.docker-native-failed-stop-recreate.v1":
        raise _fail("Native failed-stop metadata schema differs")
    failure_kind = metadata.get("failure_kind")
    if failure_kind not in {"native-start-failure", "native-after-ready-failure"}:
        raise _fail("Native failed-stop metadata has an invalid failure kind")
    failure_mode = metadata.get("failure_mode")
    if failure_mode is not None and (failure_kind != "native-start-failure"
                                     or failure_mode != "api-start-failure"):
        raise _fail("Native failed-stop metadata has an unsupported failure mode")
    if metadata.get("container_id") != backend_id or metadata.get("image_id") != image_id:
        raise _fail("Native failed-stop metadata is pinned to another backend")
    if metadata.get("claim_pending") is not False:
        raise _fail("Native failed-stop metadata still has a pending claim")
    for key in (
        "journal_sha256",
        "failure_receipt_sha256",
        "terminal_process_receipt_sha256",
        "terminal_failed_owner_sha256",
        "previous_config_sha256",
    ):
        _hash(metadata.get(key), "native failed-stop " + key)
    attestation_path = metadata.get("namespace_attestation_path")
    attestation_sha256 = metadata.get("namespace_attestation_sha256")
    if (attestation_path is None) != (attestation_sha256 is None):
        raise _fail("Native failed-stop namespace attestation metadata is incomplete")
    if attestation_path is not None:
        if attestation_path != _namespace_attestation_path(backend_id):
            raise _fail("Native failed-stop namespace attestation path differs")
        _hash(attestation_sha256, "native failed-stop namespace attestation digest")
    return dict(metadata)


def _inspect_stopped_backend(
    control: BuildControl,
    backend_id: str,
    image_id: str,
) -> dict[str, object]:
    result = docker_capture("inspect", backend_id, timeout=90)
    try:
        documents = json.loads(result.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise _fail("Stopped backend inspection is not valid JSON") from error
    if not isinstance(documents, list) or len(documents) != 1 or not isinstance(documents[0], dict):
        raise _fail("Stopped backend identity is ambiguous")
    document = documents[0]
    if document.get("Id") != backend_id or document.get("Image") != image_id:
        raise _fail("Stopped backend identity or image differs")
    state = document.get("State")
    if (not isinstance(state, Mapping) or state.get("Running") is not False
            or state.get("Status") != "exited"
            or not isinstance(state.get("StartedAt"), str) or not state.get("StartedAt")
            or not isinstance(state.get("FinishedAt"), str) or not state.get("FinishedAt")):
        raise _fail("Backend is not confirmed stopped for activation reconciliation")
    config = document.get("Config")
    labels = config.get("Labels") if isinstance(config, Mapping) else None
    if not isinstance(labels, Mapping):
        raise _fail("Stopped backend has no authenticated labels")
    if (labels.get("com.docker.compose.project") != control.project
            or labels.get("com.docker.compose.service") != "backend"):
        raise _fail("Stopped backend belongs to another Compose group")
    try:
        validate_source_labels(document, control.identity)
    except ValueError as error:
        raise _fail("Stopped backend source labels differ") from error
    return document


def _validate_stopped_backend(
    control: BuildControl,
    backend_id: str,
    image_id: str,
    *,
    journal: Mapping[str, object],
) -> dict[str, object]:
    document = _inspect_stopped_backend(control, backend_id, image_id)
    state = document["State"]
    incarnation = journal.get("container_state")
    if (not isinstance(incarnation, Mapping)
            or incarnation.get("id") != document.get("Id")
            or incarnation.get("image") != document.get("Image")
            or incarnation.get("started_at") != state.get("StartedAt")
            or incarnation.get("finished_at") != state.get("FinishedAt")
            or type(incarnation.get("exit_code")) is not int
            or incarnation.get("exit_code") != state.get("ExitCode")
            or journal.get("container_id") != backend_id
            or journal.get("image_id") != image_id):
        raise _fail("Stopped backend incarnation/timestamps differ from the stop journal")
    if type(journal.get("exit_code")) is not int or journal.get("exit_code") != state.get("ExitCode"):
        raise _fail("Stopped backend top-level exit code differs from Docker")
    return document


def _validate_namespace_attestation(
    control: BuildControl,
    attestation: object,
    *,
    backend_id: str,
    image_id: str,
    journal_raw: bytes,
    journal: Mapping[str, object],
    terminal_raw: bytes,
    terminal: Mapping[str, object],
    owner_raw: bytes,
    owner: Mapping[str, object],
    selected_source: str | None = None,
) -> dict[str, object]:
    """Validate a fresh sidecar for a legacy stopped-backend journal.

    Journals written before the incarnation fields existed remain immutable and
    are never upgraded in place.  This sidecar is a separate, CAS-published
    observation that binds the current Docker object and every control proof.
    """
    if not isinstance(attestation, Mapping):
        raise _fail("Stopped namespace attestation is not an object")
    required = {
        "schema": NAMESPACE_ATTESTATION_SCHEMA,
        "state": "stopped-confirmed",
        "compose_project": control.project,
        "control_volume": control.volume,
        "backend_container": backend_id,
        "image_id": image_id,
        "stop_journal_path": "verification/stop-failed-" + backend_id + ".json",
        "terminal_process_receipt_path": "runtime-control/runtime-service/process-tree.json",
        "terminal_failed_owner_path": "runtime-control/runtime-services/OWNER.json",
    }
    if any(attestation.get(key) != value for key, value in required.items()):
        raise _fail("Stopped namespace attestation identity/state differs")
    if selected_source is not None and attestation.get("source_root") != selected_source:
        raise _fail("Stopped namespace attestation source differs")
    _text(attestation.get("source_root"), "stopped namespace attestation source")
    for key in (
        "stop_journal_sha256", "terminal_process_receipt_sha256",
        "terminal_failed_owner_sha256", "native_failure_probe_sha256",
    ):
        _hash(attestation.get(key), "stopped namespace " + key)
    if hashlib.sha256(journal_raw).hexdigest() != attestation.get("stop_journal_sha256"):
        raise _fail("Stopped namespace attestation journal digest differs")
    if hashlib.sha256(terminal_raw).hexdigest() != attestation.get("terminal_process_receipt_sha256"):
        raise _fail("Stopped namespace attestation process receipt digest differs")
    if hashlib.sha256(owner_raw).hexdigest() != attestation.get("terminal_failed_owner_sha256"):
        raise _fail("Stopped namespace attestation owner digest differs")
    container_state = attestation.get("container_state")
    if not isinstance(container_state, Mapping):
        raise _fail("Stopped namespace attestation has no container incarnation")
    document = _inspect_stopped_backend(control, backend_id, image_id)
    state = document["State"]
    for key, observed in (
        ("id", document.get("Id")), ("image", document.get("Image")),
        ("started_at", state.get("StartedAt")), ("finished_at", state.get("FinishedAt")),
        ("exit_code", state.get("ExitCode")),
    ):
        if container_state.get(key) != observed:
            raise _fail("Stopped namespace attestation container incarnation differs")
    journal_state = journal.get("container_state")
    if isinstance(journal_state, Mapping) and dict(journal_state) != dict(container_state):
        raise _fail("Stopped namespace attestation differs from journal incarnation")
    if type(journal.get("exit_code")) is not int or journal.get("exit_code") != container_state.get("exit_code"):
        raise _fail("Stopped namespace attestation top-level exit code differs from its incarnation")
    if journal.get("container_id") != backend_id or journal.get("image_id") != image_id:
        raise _fail("Stopped namespace attestation journal identity differs")
    if not isinstance(terminal, Mapping) or attestation.get("terminal_process_receipt") != dict(terminal):
        raise _fail("Stopped namespace attestation process receipt differs")
    if not isinstance(owner, Mapping) or attestation.get("terminal_failed_owner") != dict(owner):
        raise _fail("Stopped namespace attestation owner differs")
    if journal.get("terminal_process_receipt") != dict(terminal):
        raise _fail("Stopped namespace attestation terminal differs from journal")
    if journal.get("terminal_failed_owner") != dict(owner):
        raise _fail("Stopped namespace attestation owner differs from journal")
    failure_kind = attestation.get("failure_kind")
    if failure_kind not in {"native-start-failure", "native-after-ready-failure"}:
        raise _fail("Stopped namespace attestation failure kind is invalid")
    if journal.get("failure_kind") != failure_kind:
        raise _fail("Stopped namespace attestation failure kind differs from journal")
    if attestation.get("failure_mode") != journal.get("failure_mode"):
        raise _fail("Stopped namespace attestation failure mode differs from journal")
    failure_mode = journal.get("failure_mode")
    api_start_failure = failure_mode == "api-start-failure"
    if failure_mode is not None and (failure_kind != "native-start-failure" or not api_start_failure):
        raise _fail("Stopped namespace journal has an unsupported failure mode")
    probe = attestation.get("native_failure_probe")
    if not isinstance(probe, Mapping) or probe != journal.get("native_failure_probe"):
        raise _fail("Stopped namespace attestation native proof differs from journal")
    failure = journal.get("failure_receipt")
    process_sha256 = failure.get("sha256") if isinstance(failure, Mapping) else None
    try:
        from docker_volume_stop_failed import (
            _validate_native_after_ready_failure_probe,
            _validate_native_failure_probe,
        )
        native = (
            _validate_native_after_ready_failure_probe(probe, process_sha256)
            if failure_kind == "native-after-ready-failure"
            else _validate_native_failure_probe(
                probe, process_sha256, api_start_failure=api_start_failure
            )
        )
    except (ImportError, BuildControlError) as error:
        raise _fail("Stopped namespace attestation native proof is not authoritative") from error
    if native["failed_owner"] != dict(owner):
        raise _fail("Stopped namespace attestation failed owner differs from native proof")
    probe_raw, probe_digest, _ = _payload(probe)
    if probe_digest != attestation.get("native_failure_probe_sha256"):
        raise _fail("Stopped namespace attestation native proof digest differs")
    if failure_kind == "native-after-ready-failure":
        if attestation.get("retained_ready_owner") != journal.get("retained_ready_owner"):
            raise _fail("Stopped namespace attestation retained owner differs")
    elif "retained_ready_owner" in attestation:
        raise _fail("Start-failure attestation contains a ready owner")
    created_at = attestation.get("created_at")
    if not isinstance(created_at, (int, float)) or isinstance(created_at, bool):
        raise _fail("Stopped namespace attestation has no valid creation timestamp")
    # Keep the local variable explicit: the digest is over canonical JSON plus
    # the same newline used for every control record.
    if hashlib.sha256(probe_raw).hexdigest() != attestation.get("native_failure_probe_sha256"):
        raise _fail("Stopped namespace attestation native proof bytes differ")
    return dict(attestation)


def _namespace_attestation_script(*, backend_id: str) -> str:
    def q(value: str) -> str:
        return shlex.quote(value)

    journal = "/control/verification/stop-failed-" + backend_id + ".json"
    terminal = "/control/runtime-control/runtime-service/process-tree.json"
    owner = "/control/runtime-control/runtime-services/OWNER.json"
    target = "/control/verification/stopped-namespace-attestation-" + backend_id + ".json"
    target_parent = target.rsplit("/", 1)[0]
    attestation_lock = target + ".lock"
    return f'''umask 027
check_parent() {{
    local p="$1"
    test ! -L "$p"
    test -e "$p"
    test -d "$p"
    test "$(readlink -f "$p")" = "$p"
}}
check_parent /control
check_parent /control/verification
test ! -L {q(attestation_lock)}
exec 9>{q(attestation_lock)}
flock -n 9
check_parent /control/runtime-control
check_parent /control/runtime-control/runtime-service
check_parent /control/runtime-control/runtime-services
regular() {{ test ! -L "$1"; test -f "$1"; test "$(stat -c %h "$1")" = 1; }}
regular {q(journal)}
test "$(sha256sum {q(journal)} | cut -d' ' -f1)" = "$FULLMAG_NS_JOURNAL_SHA256"
regular {q(terminal)}
test "$(sha256sum {q(terminal)} | cut -d' ' -f1)" = "$FULLMAG_NS_TERMINAL_SHA256"
regular {q(owner)}
test "$(sha256sum {q(owner)} | cut -d' ' -f1)" = "$FULLMAG_NS_OWNER_SHA256"
parent={q(target_parent)}
check_parent "$parent"
test ! -L {q(target)}
if test -e {q(target)}; then
    regular {q(target)}
    test "$(sha256sum {q(target)} | cut -d' ' -f1)" = "$FULLMAG_NS_ATTESTATION_SHA256"
else
    tmp="$(mktemp "$parent/.namespace-attestation.XXXXXXXX")"
    trap 'rm -f -- "$tmp"' EXIT
    printf '%s' "$FULLMAG_NS_ATTESTATION_B64" | base64 -d > "$tmp"
    regular "$tmp"
    test "$(sha256sum "$tmp" | cut -d' ' -f1)" = "$FULLMAG_NS_ATTESTATION_SHA256"
    sync "$tmp"
    mv -T -- "$tmp" {q(target)}
    sync "$parent"
    trap - EXIT
fi
printf 'ATTESTED\\n'
'''


def publish_stopped_namespace_attestation(
    control: BuildControl,
    *,
    backend_id: str,
    image_id: str,
    selected_source: str,
    journal_raw: bytes,
    journal: Mapping[str, object],
) -> dict[str, object]:
    """CAS-publish or replay the immutable stopped-namespace sidecar.

    A retry authenticates the already committed bytes against the current
    stopped container and control proofs; it never mints a replacement
    timestamp or overwrites the sidecar.
    """
    _container(backend_id, "stopped namespace backend")
    _image(image_id, "stopped namespace image")
    _text(selected_source, "stopped namespace source")
    terminal_raw = _control_bytes(control, "runtime-control/runtime-service/process-tree.json")
    owner_raw = _control_bytes(control, "runtime-control/runtime-services/OWNER.json")
    terminal = _json(terminal_raw, "stopped namespace process receipt")
    owner = _json(owner_raw, "stopped namespace failed owner")
    probe = journal.get("native_failure_probe")
    if not isinstance(probe, Mapping):
        raise _fail("Cannot attest stopped namespace without native failure proof")
    _, probe_sha256, _ = _payload(probe)
    state = journal.get("container_state")
    if not isinstance(state, Mapping):
        # This is an explicit fresh attestation route for a legacy journal.
        # It observes the currently stopped Docker object and never rewrites
        # the historical journal with the newly observed incarnation.
        document = _inspect_stopped_backend(control, backend_id, image_id)
        observed_state = document["State"]
        state = {
            "id": document["Id"],
            "image": document["Image"],
            "started_at": observed_state["StartedAt"],
            "finished_at": observed_state["FinishedAt"],
            "exit_code": observed_state["ExitCode"],
        }
    attestation_relative = _namespace_attestation_path(backend_id)
    existing_raw = _control_bytes(control, attestation_relative, optional=True)
    if existing_raw is not None:
        # The sidecar is immutable.  A retry must authenticate the current
        # Docker/proof set against the exact bytes already committed instead
        # of creating a new timestamp and racing its own digest.
        attestation = _json(existing_raw, "stopped namespace attestation")
        if existing_raw != canonical(attestation) + b"\n":
            raise _fail("Stopped namespace attestation is not canonical")
        _validate_namespace_attestation(
            control, attestation, backend_id=backend_id, image_id=image_id,
            journal_raw=journal_raw, journal=journal,
            terminal_raw=terminal_raw, terminal=terminal,
            owner_raw=owner_raw, owner=owner, selected_source=selected_source,
        )
        payload = existing_raw
        digest = hashlib.sha256(existing_raw).hexdigest()
    else:
        attestation = {
            "schema": NAMESPACE_ATTESTATION_SCHEMA,
            "state": "stopped-confirmed",
            "compose_project": control.project,
            "control_volume": control.volume,
            "backend_container": backend_id,
            "image_id": image_id,
            "source_root": selected_source,
            "container_state": dict(state),
            "stop_journal_path": "verification/stop-failed-" + backend_id + ".json",
            "stop_journal_sha256": hashlib.sha256(journal_raw).hexdigest(),
            "terminal_process_receipt_path": "runtime-control/runtime-service/process-tree.json",
            "terminal_process_receipt_sha256": hashlib.sha256(terminal_raw).hexdigest(),
            "terminal_process_receipt": terminal,
            "terminal_failed_owner_path": "runtime-control/runtime-services/OWNER.json",
            "terminal_failed_owner_sha256": hashlib.sha256(owner_raw).hexdigest(),
            "terminal_failed_owner": owner,
            "failure_kind": journal.get("failure_kind"),
            "native_failure_probe_sha256": probe_sha256,
            "native_failure_probe": dict(probe),
            "created_at": time.time(),
        }
        if journal.get("failure_mode") is not None:
            attestation["failure_mode"] = journal.get("failure_mode")
        if journal.get("failure_kind") == "native-after-ready-failure":
            attestation["retained_ready_owner"] = journal.get("retained_ready_owner")
        _validate_namespace_attestation(
            control, attestation, backend_id=backend_id, image_id=image_id,
            journal_raw=journal_raw, journal=journal,
            terminal_raw=terminal_raw, terminal=terminal,
            owner_raw=owner_raw, owner=owner, selected_source=selected_source,
        )
        payload, digest, _ = _payload(attestation)
    script = _namespace_attestation_script(backend_id=backend_id)
    name = "fullmag-control-namespace-attest-" + backend_id[:24]
    args = control.helper_args(script, name=name)
    entrypoint = args.index("--entrypoint")
    values = {
        "FULLMAG_NS_JOURNAL_SHA256": hashlib.sha256(journal_raw).hexdigest(),
        "FULLMAG_NS_TERMINAL_SHA256": hashlib.sha256(terminal_raw).hexdigest(),
        "FULLMAG_NS_OWNER_SHA256": hashlib.sha256(owner_raw).hexdigest(),
        "FULLMAG_NS_ATTESTATION_B64": base64.b64encode(payload).decode("ascii"),
        "FULLMAG_NS_ATTESTATION_SHA256": digest,
    }
    env_args: list[str] = []
    for key, value in values.items():
        env_args.extend(["--env", key + "=" + value])
    args[entrypoint:entrypoint] = env_args
    result = bounded_capture(args, data=b"", timeout=180)
    if result.returncode or b"ATTESTED\n" not in result.stdout:
        detail = (result.stderr + result.stdout).decode("utf-8", "replace")[-2048:]
        raise _fail("Stopped namespace attestation was not committed: " + detail)
    # The observer has no Docker access inside its network-isolated helper.
    # Recheck the pinned incarnation after publication so a restart/removal
    # during capture cannot be mistaken for the sidecar's stopped namespace.
    document = _inspect_stopped_backend(control, backend_id, image_id)
    state = document["State"]
    observed_state = {
        "id": document["Id"],
        "image": document["Image"],
        "started_at": state["StartedAt"],
        "finished_at": state["FinishedAt"],
        "exit_code": state["ExitCode"],
    }
    if attestation.get("container_state") != observed_state:
        raise _fail("Stopped namespace incarnation changed during attestation publication")
    return {"path": attestation_relative, "sha256": digest, **attestation}


def _validate_helper(
    control: BuildControl,
    helper_name: str,
    activation_attempt: str,
    *, phase: str = "activation",
) -> tuple[dict[str, object], str]:
    if phase not in {"activation", "iteration", "browser-qa", "development", "stop-diagnostic"}:
        raise _fail("Unsupported retained helper phase")
    result = docker_capture("inspect", helper_name, timeout=90)
    try:
        documents = json.loads(result.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise _fail("Activation helper inspection is not valid JSON") from error
    if not isinstance(documents, list) or len(documents) != 1 or not isinstance(documents[0], dict):
        raise _fail("Original activation helper identity is ambiguous")
    document = documents[0]
    helper_id = _container(document.get("Id"), "activation helper")
    name = document.get("Name")
    if name not in {helper_name, "/" + helper_name}:
        raise _fail("Activation helper name differs from its retained receipt")
    image_result = docker_capture("image", "inspect", control.image, timeout=90)
    try:
        image_documents = json.loads(image_result.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise _fail("Pinned activation helper image inspection is not valid JSON") from error
    if (not isinstance(image_documents, list) or len(image_documents) != 1
            or not isinstance(image_documents[0], Mapping)):
        raise _fail("Pinned activation helper image identity is ambiguous")
    resolved_image_id = _image(image_documents[0].get("Id"), "pinned activation helper image")
    if document.get("Image") != resolved_image_id:
        raise _fail("Activation helper image ID differs from the pinned image")
    state = document.get("State")
    if not isinstance(state, Mapping) or state.get("Running") is not True:
        raise _fail("Original activation helper is not still running")
    config = document.get("Config")
    if not isinstance(config, Mapping):
        raise _fail("Activation helper configuration is missing")
    if config.get("Image") != control.image:
        raise _fail("Activation helper Config.Image is not the pinned image reference")
    expected_labels = {
        "com.docker.compose.project": control.project,
        "com.docker.compose.service": "build-control",
        **control.labels,
        **source_labels(control.identity),
    }
    labels = config.get("Labels")
    if not isinstance(labels, Mapping) or any(labels.get(key) != value for key, value in expected_labels.items()):
        raise _fail("Activation helper labels differ from the selected source group")
    # helper_args adds the selected namespace registry fence to the lease
    # script. Authenticate that exact command, including the prefix, rather
    # than only the legacy unnamespaced operation_script body.
    expected_args = control.helper_args(
        control.operation_script(phase, activation_attempt), name=helper_name,
    )
    entrypoint_index = expected_args.index("--entrypoint")
    expected_cmd = expected_args[entrypoint_index + 3:]
    if config.get("Entrypoint") != ["/bin/bash"] or config.get("Cmd") != expected_cmd:
        raise _fail("Activation helper command differs from the pinned lease protocol")
    mounts = document.get("Mounts")
    expected_mount_count = 2 if control.namespace else 1
    if (not isinstance(mounts, list) or len(mounts) != expected_mount_count
            or not all(isinstance(mount, Mapping) for mount in mounts)):
        raise _fail("Activation helper mounts are not exact")
    mount = mounts[0]
    if (mount.get("Type") != "volume" or mount.get("Name") != control.volume
            or mount.get("Destination") != "/control" or mount.get("RW") is not True):
        raise _fail("Activation helper control volume differs")
    if control.namespace:
        registry = mounts[1]
        if (registry.get("Type") != "volume" or registry.get("Name") != control.volume
                or registry.get("Destination") != "/registry" or registry.get("RW") is not False):
            raise _fail("Activation helper namespace registry mount differs")
        # Docker's normalized Mounts array omits volume-subpath. The daemon
        # HostConfig is required as well, otherwise a whole-volume mount could
        # impersonate the exact selected control namespace.
        host_config = document.get("HostConfig")
        expected_host_mounts = [
            {"Type": "volume", "Source": control.volume, "Target": "/control",
             "VolumeOptions": {"NoCopy": True, "Subpath": control.namespace}},
            {"Type": "volume", "Source": control.volume, "Target": "/registry",
             "ReadOnly": True, "VolumeOptions": {"NoCopy": True}},
        ]
        if not isinstance(host_config, Mapping) or host_config.get("Mounts") != expected_host_mounts:
            raise _fail("Activation helper namespace subpath differs")
    return document, helper_id


def _probe_helper_absence(helper_name: str) -> str | None:
    """Return a stable absence proof, or ``None`` when the name is live.

    Docker daemon errors are deliberately reduced to a small canonical probe;
    retaining arbitrary daemon text in the control volume would make the
    recovery receipt both noisy and difficult to authenticate.  Any error
    other than Docker's exact not-found response fails closed.
    """
    inspected = docker_capture("inspect", helper_name, timeout=90, allow_failure=True)
    if inspected.returncode == 0:
        return None
    detail = (inspected.stdout + inspected.stderr).decode("utf-8", "replace")
    lines = [line.strip() for line in detail.splitlines() if line.strip()]
    expected_error = re.compile(
        r"^(?i:(?:Error(?:: response from daemon| response from daemon)?: )?No such (?:object|container): )"
        + re.escape(helper_name) + r"$"
    )
    if inspected.returncode != 1 or not lines or expected_error.fullmatch(lines[-1]) is None:
        raise _fail("Original activation helper absence could not be authenticated")
    listed = docker_capture(
        "ps", "-a", "--no-trunc", "--filter", "name=^/" + helper_name + "$",
        "--format", "{{.ID}}", timeout=90, allow_failure=True,
    )
    if listed.returncode:
        raise _fail("Original activation helper absence listing failed")
    identifiers = [line.strip() for line in listed.stdout.decode("utf-8", "replace").splitlines()
                   if line.strip()]
    if identifiers:
        raise _fail("Original activation helper name is occupied by another container")
    probe = {
        "schema": "fullmag.docker-helper-absence-probe.v1",
        "state": "absent",
        "helper_name": helper_name,
        "containers": [],
    }
    return hashlib.sha256(canonical(probe)).hexdigest()


def _validate_helper_logged(helper_id: str) -> str:
    result = docker_capture("logs", "--tail", "256", helper_id, timeout=30)
    output = result.stdout + result.stderr
    ready = output.find(b"READY\n")
    logged = output.find(b"LOGGED\n")
    if ready < 0 or logged < ready:
        raise _fail("Activation helper has not durably acknowledged READY and LOGGED")
    return output.decode("utf-8", "replace")[-8192:]


def _validate_activation_receipt(
    control: BuildControl,
    *,
    activation_attempt: str,
    development_attempt: str,
    config_sha256: str,
    source_root: str,
    image_id: str,
    backend_id: str,
) -> tuple[dict[str, object], bytes, dict[str, object]]:
    root = "activation/attempts/" + activation_attempt
    raw = _control_bytes(control, root + "/receipt.json")
    if raw is None:
        raise _fail("Unknown activation has no durable receipt")
    receipt = _json(raw, "unknown activation receipt")
    if (receipt.get("schema") != OPERATION_SCHEMA
            or receipt.get("phase") != "activation"
            or receipt.get("state") != "outcome-unknown-resources-retained"
            or receipt.get("attempt") != activation_attempt
            or receipt.get("compose_project") != control.project
            or receipt.get("control_volume") != control.volume):
        raise _fail("Activation receipt is not the retained unknown-outcome record")
    if receipt.get("helper_container") != "fullmag-control-" + activation_attempt:
        raise _fail("Activation receipt helper identity differs")
    _hash(receipt.get("helper_sha256"), "activation helper digest")
    if not isinstance(receipt.get("started_at"), (int, float)) or isinstance(receipt.get("started_at"), bool):
        raise _fail("Activation receipt has no valid start timestamp")
    if not isinstance(receipt.get("finished_at"), (int, float)) or isinstance(receipt.get("finished_at"), bool):
        raise _fail("Activation receipt has no valid failure timestamp")
    _text(receipt.get("error"), "activation failure")
    inputs = receipt.get("inputs")
    if not isinstance(inputs, Mapping):
        raise _fail("Unknown activation receipt has no immutable inputs")
    if inputs.get("development_attempt") != development_attempt:
        raise _fail("Unknown activation belongs to another development attempt")
    if inputs.get("config_sha256") != config_sha256:
        raise _fail("Unknown activation/config pin differs")
    if inputs.get("source_root") != source_root:
        raise _fail("Unknown activation/source pin differs")
    if inputs.get("image_id") != image_id:
        raise _fail("Unknown activation/image pin differs")
    if inputs.get("backend_container") != backend_id:
        raise _fail("Unknown activation/backend pin differs")
    source_relative = _text(inputs.get("source_relative"), "activation source relative path")
    source_sha256 = _hash(inputs.get("source_sha256"), "activation source digest")
    request_id = inputs.get("request_id")
    if not isinstance(request_id, str) or REQUEST_ID_RE.fullmatch(request_id) is None:
        raise _fail("Unknown activation request id is invalid")
    provenance_sha256 = _hash(inputs.get("provenance_sha256"), "activation provenance digest")
    key = _hash(inputs.get("activation_receipt_key"), "activation receipt key")
    path = inputs.get("activation_receipt_path")
    if path != _activation_marker_path(key):
        raise _fail("Unknown activation marker path differs from its request key")
    validated_inputs = {
        "development_attempt": development_attempt,
        "config_sha256": config_sha256,
        "source_root": source_root,
        "image_id": image_id,
        "backend_container": backend_id,
        "source_relative": source_relative,
        "source_sha256": source_sha256,
        "request_id": request_id,
        "provenance_sha256": provenance_sha256,
        "activation_receipt_key": key,
        "activation_receipt_path": path,
    }
    return receipt, raw, validated_inputs


def _validate_unresolved_activation(
    control: BuildControl,
    record: object,
    *,
    expected: Mapping[str, object] | None = None,
) -> dict[str, object]:
    if not isinstance(record, Mapping):
        raise _fail("Unresolved activation quarantine is not an object")
    required = {
        "schema": ACTIVATION_UNRESOLVED_SCHEMA,
        "state": UNKNOWN_STATE,
        "phase": "activation",
        "activation_outcome": UNKNOWN_STATE,
        "reason": UNKNOWN_REASON,
        "compose_project": control.project,
        "control_volume": control.volume,
    }
    if any(record.get(key) != value for key, value in required.items()):
        raise _fail("Unresolved activation quarantine has an invalid group or state")
    activation_attempt = _attempt(record.get("activation_attempt"), "quarantined activation attempt")
    _attempt(record.get("development_attempt"), "quarantined development attempt")
    _hash(record.get("config_sha256"), "quarantined config digest")
    _image(record.get("image_id"), "quarantined image")
    _container(record.get("backend_container"), "quarantined backend")
    _hash(record.get("activation_receipt_sha256"), "quarantined activation receipt digest")
    _hash(record.get("source_sha256"), "quarantined source digest")
    _hash(record.get("provenance_sha256"), "quarantined provenance digest")
    key = _hash(record.get("activation_receipt_key"), "quarantined activation receipt key")
    if record.get("activation_receipt_path") != _activation_marker_path(key):
        raise _fail("Quarantined activation marker path differs")
    request_id = record.get("request_id")
    if not isinstance(request_id, str) or REQUEST_ID_RE.fullmatch(request_id) is None:
        raise _fail("Quarantined activation request id is invalid")
    _text(record.get("source_root"), "quarantined source root")
    _text(record.get("source_relative"), "quarantined source path")
    if record.get("helper_container") != "fullmag-control-" + activation_attempt:
        raise _fail("Quarantined helper name does not match its activation")
    _hash(record.get("helper_sha256"), "quarantined helper digest")
    helper_state = record.get("helper_state", "running")
    if helper_state == "running":
        _container(record.get("helper_id"), "quarantined helper")
    elif helper_state == "absent-confirmed":
        if record.get("helper_id") is not None:
            raise _fail("Absent activation helper quarantine retains a container identity")
        _hash(record.get("helper_absence_probe_sha256"), "helper absence probe digest")
    else:
        raise _fail("Quarantined activation has an invalid helper state")
    _hash(record.get("native_stop_journal_sha256"), "quarantined stop journal digest")
    _attempt(record.get("reconciliation_attempt"), "quarantined reconciliation attempt")
    if not isinstance(record.get("created_at"), (int, float)) or isinstance(record.get("created_at"), bool):
        raise _fail("Quarantined activation has no valid creation timestamp")
    if expected is not None:
        for key, value in expected.items():
            if record.get(key) != value:
                raise _fail("Unresolved activation quarantine does not match the selected group: " + key)
    return dict(record)


def assert_no_unresolved_activation(
    control: BuildControl,
    *,
    development_attempt: str | None = None,
    config_sha256: str | None = None,
    source_root: str | None = None,
    image_id: str | None = None,
    backend_container: str | None = None,
    request_id: str | None = None,
) -> None:
    """Block every new activation while one prior activation is unknown."""
    from docker_volume_offline_reconcile import assert_activation_allowed
    assert_activation_allowed(control)
    from docker_control_namespace import assert_namespace_activation
    assert_namespace_activation(control, request_id)
    from docker_volume_cancelled_activation_guard import assert_start_allowed
    assert_start_allowed(control, request_id)
    aborted = _read_json(control, "preparation-abort/current.json", optional=True)
    if aborted is not None:
        from docker_volume_preparation_abort import has_fresh_archive
        if ((request_id is not None and aborted.get("request_id") == request_id)
            or not has_fresh_archive(control, aborted)):
            raise _fail("An unreleased preparation was aborted; preserve it through recreate-volume --fresh-state before a new activation; old request replay is forbidden")
    record = _read_json(control, "activation/unresolved.json", optional=True)
    if record is None:
        return
    expected = {
        key: value for key, value in {
            "development_attempt": development_attempt,
            "config_sha256": config_sha256,
            "source_root": source_root,
            "image_id": image_id,
            "backend_container": backend_container,
        }.items() if value is not None
    }
    _validate_unresolved_activation(control, record, expected=expected)
    raise _fail(
        "An earlier startup activation has unknown outcome; its retained marker "
        "must be resolved before a new activation or Solve"
    )


def _validate_reconciliation_receipt(
    control: BuildControl,
    receipt: Mapping[str, object],
    *,
    reconciliation_attempt: str,
    activation_attempt: str,
    expected: Mapping[str, object] | None = None,
) -> dict[str, object]:
    if (receipt.get("schema") != OPERATION_SCHEMA
            or receipt.get("phase") != "activation-reconciliation"
            or receipt.get("attempt") != reconciliation_attempt
            or receipt.get("reconciled_activation_attempt") != activation_attempt
            or receipt.get("compose_project") != control.project
            or receipt.get("control_volume") != control.volume):
        raise _fail("Activation reconciliation receipt identity differs")
    if receipt.get("state") not in {"reconciling", "failed-confirmed"}:
        raise _fail("Activation reconciliation receipt has an invalid state")
    if receipt.get("activation_outcome") != UNKNOWN_STATE or receipt.get("reason") != UNKNOWN_REASON:
        raise _fail("Activation reconciliation receipt does not retain unknown outcome")
    if expected is not None:
        for key, value in expected.items():
            if receipt.get(key) != value:
                raise _fail("Activation reconciliation receipt differs: " + key)
    return dict(receipt)


def _wait_for_helper_exit(helper_id: str) -> int:
    result = docker_capture("wait", helper_id, timeout=90, allow_failure=True)
    if result.returncode:
        raise _fail("Activation helper exit could not be observed; resources remain retained")
    try:
        output = result.stdout.decode("utf-8").strip()
        exit_code = int(output)
    except (UnicodeDecodeError, ValueError) as error:
        raise _fail("Activation helper returned no canonical exit code") from error
    if exit_code != 0:
        raise _fail("Activation helper failed while releasing its retained lease")
    inspected = docker_capture("inspect", helper_id, timeout=30, allow_failure=True)
    if not inspected.returncode:
        try:
            documents = json.loads(inspected.stdout)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise _fail("Activation helper post-exit inspection is invalid") from error
        if len(documents) != 1 or not isinstance(documents[0], Mapping):
            raise _fail("Activation helper post-exit identity is ambiguous")
        state = documents[0].get("State")
        if not isinstance(state, Mapping) or state.get("Running") or state.get("ExitCode") != 0:
            raise _fail("Activation helper did not finish with a confirmed zero exit")
    return exit_code


def _payload(value: Mapping[str, object]) -> tuple[bytes, str, str]:
    raw = canonical(value) + b"\n"
    if len(raw) > MAX_DOCUMENT_BYTES:
        raise _fail("Reconciliation control record exceeds its size bound")
    digest = hashlib.sha256(raw).hexdigest()
    return raw, digest, base64.b64encode(raw).decode("ascii")


def _reconciliation_helper_script(
    *,
    activation_attempt: str,
    reconciliation_attempt: str,
    backend_id: str,
) -> str:
    """Return the image-owned CAS transaction for an absent old helper.

    Every durable mutation happens under the control-volume operation lock.
    The active marker and original receipt are checked immediately before the
    final removal, so a changed lease is retained instead of being guessed at.
    """
    active = "/control/active"
    receipt = f"/control/activation/attempts/{activation_attempt}/receipt.json"
    old_terminal = f"/control/activation/attempts/{activation_attempt}/terminal.json"
    unresolved = "/control/activation/unresolved.json"
    root = f"/control/activation-reconciliation/attempts/{reconciliation_attempt}"
    reconciliation_receipt = root + "/receipt.json"
    reconciliation_terminal = root + "/terminal.json"
    reconciliation_current = "/control/activation-reconciliation/current.json"
    stop_journal = "/control/verification/stop-failed-" + backend_id + ".json"
    terminal_process = "/control/runtime-control/runtime-service/process-tree.json"
    def q(value: str) -> str:
        return shlex.quote(value)
    return f'''umask 027
exec 9>/control/operation.lock
flock -n 9

regular() {{
    test -f "$1"
    test ! -L "$1"
    test "$(stat -c %h "$1")" = 1
}}

exact_active() {{
    regular {q(active)}
    test "$(cat {q(active)})" = "$FULLMAG_RECON_ACTIVE_TOKEN"
    test "$(sha256sum {q(active)} | cut -d' ' -f1)" = "$FULLMAG_RECON_ACTIVE_SHA256"
}}

regular {q(receipt)}
test "$(sha256sum {q(receipt)} | cut -d' ' -f1)" = "$FULLMAG_RECON_OLD_RECEIPT_SHA256"
regular {q(stop_journal)}
test "$(sha256sum {q(stop_journal)} | cut -d' ' -f1)" = "$FULLMAG_RECON_STOP_JOURNAL_SHA256"
regular {q(terminal_process)}
test "$(sha256sum {q(terminal_process)} | cut -d' ' -f1)" = "$FULLMAG_RECON_TERMINAL_PROCESS_SHA256"
if test -e {q(old_terminal)}; then
    regular {q(old_terminal)}
    observed="$(sha256sum {q(old_terminal)} | cut -d' ' -f1)"
    test "$observed" = "$FULLMAG_RECON_ACTIVATION_TERMINAL_SHA256" \
        || test "$observed" = "$FULLMAG_RECON_ACTIVATION_TERMINAL_REPLACE_SHA256"
else
    test ! -L {q(old_terminal)}
fi
exact_active

publish() {{
    local path="$1" payload="$2" expected="$3" replace_sha="$4"
    local parent tmp observed
    parent="${{path%/*}}"
    test -n "$parent"
    test ! -L "$parent"
    mkdir -p "$parent"
    test "$(readlink -f "$parent")" = "$parent"
    test ! -L "$path"
    if test -e "$path"; then
        regular "$path"
        observed="$(sha256sum "$path" | cut -d' ' -f1)"
        if test "$observed" = "$expected"; then
            return 0
        fi
        test -n "$replace_sha" && test "$observed" = "$replace_sha"
    fi
    tmp="$(mktemp "$parent/.reconcile.XXXXXXXX")"
    trap 'rm -f -- "$tmp"' EXIT
    printf '%s' "$payload" | base64 -d > "$tmp"
    regular "$tmp"
    test "$(sha256sum "$tmp" | cut -d' ' -f1)" = "$expected"
    sync "$tmp"
    mv -T -- "$tmp" "$path"
    sync "$parent"
    trap - EXIT
}}

publish /control/activation/unresolved.json "$FULLMAG_RECON_UNRESOLVED_B64" \
    "$FULLMAG_RECON_UNRESOLVED_SHA256" "$FULLMAG_RECON_UNRESOLVED_REPLACE_SHA256"
publish {q(reconciliation_receipt)} "$FULLMAG_RECON_RECEIPT_B64" \
    "$FULLMAG_RECON_RECEIPT_SHA256" "$FULLMAG_RECON_RECEIPT_REPLACE_SHA256"
publish {q(reconciliation_terminal)} "$FULLMAG_RECON_TERMINAL_B64" \
    "$FULLMAG_RECON_TERMINAL_SHA256" ""
publish {q(reconciliation_current)} "$FULLMAG_RECON_CURRENT_B64" \
    "$FULLMAG_RECON_CURRENT_SHA256" ""
publish {q(old_terminal)} "$FULLMAG_RECON_ACTIVATION_TERMINAL_B64" \
    "$FULLMAG_RECON_ACTIVATION_TERMINAL_SHA256" "$FULLMAG_RECON_ACTIVATION_TERMINAL_REPLACE_SHA256"

exact_active
regular {q(receipt)}
test "$(sha256sum {q(receipt)} | cut -d' ' -f1)" = "$FULLMAG_RECON_OLD_RECEIPT_SHA256"
rm -f -- {q(active)}
sync /control
test ! -e {q(active)}
test ! -L {q(active)}
printf 'RECONCILED\\n'
'''


def _run_absent_helper_reconciliation(
    control: BuildControl,
    *,
    activation_attempt: str,
    reconciliation_attempt: str,
    backend_id: str,
    stop_journal_sha256: str,
    terminal_process_sha256: str,
    active_raw: bytes,
    receipt_raw: bytes,
    unresolved_raw: bytes,
    unresolved_payload: bytes,
    reconciliation_payload: bytes,
    reconciliation_replace_sha256: str,
    reconciliation_terminal_payload: bytes,
    reconciliation_current_payload: bytes,
    activation_terminal_payload: bytes,
    activation_terminal_replace_sha256: str = "",
) -> None:
    """Run the bounded image-owned reconciliation transaction."""
    active_token = active_raw.decode("utf-8").strip()
    _attempt(active_token, "active activation")
    script = _reconciliation_helper_script(
        activation_attempt=activation_attempt,
        reconciliation_attempt=reconciliation_attempt,
        backend_id=backend_id,
    )
    values = {
        "FULLMAG_RECON_ACTIVE_TOKEN": active_token,
        "FULLMAG_RECON_ACTIVE_SHA256": hashlib.sha256(active_raw).hexdigest(),
        "FULLMAG_RECON_OLD_RECEIPT_SHA256": hashlib.sha256(receipt_raw).hexdigest(),
        "FULLMAG_RECON_STOP_JOURNAL_SHA256": stop_journal_sha256,
        "FULLMAG_RECON_TERMINAL_PROCESS_SHA256": terminal_process_sha256,
        "FULLMAG_RECON_UNRESOLVED_B64": base64.b64encode(unresolved_payload).decode("ascii"),
        "FULLMAG_RECON_UNRESOLVED_SHA256": hashlib.sha256(unresolved_payload).hexdigest(),
        "FULLMAG_RECON_UNRESOLVED_REPLACE_SHA256": hashlib.sha256(unresolved_raw).hexdigest(),
        "FULLMAG_RECON_RECEIPT_B64": base64.b64encode(reconciliation_payload).decode("ascii"),
        "FULLMAG_RECON_RECEIPT_SHA256": hashlib.sha256(reconciliation_payload).hexdigest(),
        "FULLMAG_RECON_RECEIPT_REPLACE_SHA256": reconciliation_replace_sha256,
        "FULLMAG_RECON_TERMINAL_B64": base64.b64encode(reconciliation_terminal_payload).decode("ascii"),
        "FULLMAG_RECON_TERMINAL_SHA256": hashlib.sha256(reconciliation_terminal_payload).hexdigest(),
        "FULLMAG_RECON_CURRENT_B64": base64.b64encode(reconciliation_current_payload).decode("ascii"),
        "FULLMAG_RECON_CURRENT_SHA256": hashlib.sha256(reconciliation_current_payload).hexdigest(),
        "FULLMAG_RECON_ACTIVATION_TERMINAL_B64": base64.b64encode(activation_terminal_payload).decode("ascii"),
        "FULLMAG_RECON_ACTIVATION_TERMINAL_SHA256": hashlib.sha256(activation_terminal_payload).hexdigest(),
        "FULLMAG_RECON_ACTIVATION_TERMINAL_REPLACE_SHA256": activation_terminal_replace_sha256,
    }
    name = "fullmag-control-reconcile-" + reconciliation_attempt
    args = control.helper_args(script, name=name)
    entrypoint = args.index("--entrypoint")
    env_args: list[str] = []
    for key, value in values.items():
        env_args.extend(["--env", key + "=" + value])
    args[entrypoint:entrypoint] = env_args
    result = bounded_capture(args, data=b"", timeout=180)
    if result.returncode or b"RECONCILED\n" not in result.stdout:
        detail = (result.stderr + result.stdout).decode("utf-8", "replace")[-1024:]
        raise _fail("Managed activation reconciliation did not commit its CAS transaction: " + detail)


def _reconciliation_finalization_script(
    *,
    activation_attempt: str,
    reconciliation_attempt: str,
) -> str:
    """Return the locked, replayable finalization transaction.

    The old activation helper already removed ``active`` before the host
    observed its final receipt.  This transaction only completes the three
    reconciliation records.  It never removes a marker and it accepts an
    already-published exact final record, which makes a crash between two
    atomic publishes safely replayable.
    """

    def q(value: str) -> str:
        return shlex.quote(value)

    unresolved = "/control/activation/unresolved.json"
    receipt = f"/control/activation/attempts/{activation_attempt}/receipt.json"
    activation_terminal = f"/control/activation/attempts/{activation_attempt}/terminal.json"
    root = f"/control/activation-reconciliation/attempts/{reconciliation_attempt}"
    recon_receipt = root + "/receipt.json"
    recon_terminal = root + "/terminal.json"
    recon_current = "/control/activation-reconciliation/current.json"
    return f'''umask 027
exec 9>/control/operation.lock
flock -n 9

regular() {{
    test ! -L "$1"
    test -f "$1"
    test "$(stat -c %h "$1")" = 1
}}

publish() {{
    local path="$1" payload="$2" expected="$3" replace_sha="$4"
    local parent tmp observed
    parent="${{path%/*}}"
    test -n "$parent"
    test ! -L "$parent"
    mkdir -p "$parent"
    test "$(readlink -f "$parent")" = "$parent"
    test ! -L "$path"
    if test -e "$path"; then
        regular "$path"
        observed="$(sha256sum "$path" | cut -d' ' -f1)"
        if test "$observed" = "$expected"; then
            return 0
        fi
        test -n "$replace_sha" && test "$observed" = "$replace_sha"
    fi
    tmp="$(mktemp "$parent/.reconcile-finalize.XXXXXXXX")"
    trap 'rm -f -- "$tmp"' EXIT
    printf '%s' "$payload" | base64 -d > "$tmp"
    regular "$tmp"
    test "$(sha256sum "$tmp" | cut -d' ' -f1)" = "$expected"
    sync "$tmp"
    mv -T -- "$tmp" "$path"
    sync "$parent"
    trap - EXIT
}}

test ! -L /control/active
test ! -e /control/active
regular {q(unresolved)}
observed="$(sha256sum {q(unresolved)} | cut -d' ' -f1)"
test "$observed" = "$FULLMAG_FINAL_UNRESOLVED_REPLACE_SHA256" \
    || test "$observed" = "$FULLMAG_FINAL_UNRESOLVED_SHA256"
regular {q(receipt)}
test "$(sha256sum {q(receipt)} | cut -d' ' -f1)" = "$FULLMAG_FINAL_ACTIVATION_RECEIPT_SHA256"
regular {q(activation_terminal)}
observed="$(sha256sum {q(activation_terminal)} | cut -d' ' -f1)"
test "$observed" = "$FULLMAG_FINAL_ACTIVATION_TERMINAL_REPLACE_SHA256" \
    || test "$observed" = "$FULLMAG_FINAL_ACTIVATION_TERMINAL_SHA256"
regular {q(recon_receipt)}
observed="$(sha256sum {q(recon_receipt)} | cut -d' ' -f1)"
if test "$observed" != "$FULLMAG_FINAL_RECONCILING_SHA256" \
        && test "$observed" != "$FULLMAG_FINAL_RECEIPT_SHA256"; then
    exit 1
fi
publish {q(unresolved)} "$FULLMAG_FINAL_UNRESOLVED_B64" \
    "$FULLMAG_FINAL_UNRESOLVED_SHA256" "$FULLMAG_FINAL_UNRESOLVED_REPLACE_SHA256"
publish {q(activation_terminal)} "$FULLMAG_FINAL_ACTIVATION_TERMINAL_B64" \
    "$FULLMAG_FINAL_ACTIVATION_TERMINAL_SHA256" "$FULLMAG_FINAL_ACTIVATION_TERMINAL_REPLACE_SHA256"
publish {q(recon_receipt)} "$FULLMAG_FINAL_RECEIPT_B64" \
    "$FULLMAG_FINAL_RECEIPT_SHA256" "$FULLMAG_FINAL_RECONCILING_SHA256"
publish {q(recon_terminal)} "$FULLMAG_FINAL_TERMINAL_B64" \
    "$FULLMAG_FINAL_TERMINAL_SHA256" ""
publish {q(recon_current)} "$FULLMAG_FINAL_CURRENT_B64" \
    "$FULLMAG_FINAL_CURRENT_SHA256" ""
test ! -L /control/active
test ! -e /control/active
printf 'FINALIZED\\n'
'''


def _run_reconciliation_finalization(
    control: BuildControl,
    *,
    activation_attempt: str,
    reconciliation_attempt: str,
    unresolved_raw: bytes,
    unresolved_final_raw: bytes,
    activation_receipt_raw: bytes,
    activation_terminal_raw: bytes,
    activation_terminal_final_raw: bytes,
    reconciling_raw: bytes,
    final_raw: bytes,
) -> None:
    script = _reconciliation_finalization_script(
        activation_attempt=activation_attempt,
        reconciliation_attempt=reconciliation_attempt,
    )
    values = {
        "FULLMAG_FINAL_UNRESOLVED_B64": base64.b64encode(unresolved_final_raw).decode("ascii"),
        "FULLMAG_FINAL_UNRESOLVED_SHA256": hashlib.sha256(unresolved_final_raw).hexdigest(),
        "FULLMAG_FINAL_UNRESOLVED_REPLACE_SHA256": hashlib.sha256(unresolved_raw).hexdigest(),
        "FULLMAG_FINAL_ACTIVATION_RECEIPT_SHA256": hashlib.sha256(activation_receipt_raw).hexdigest(),
        "FULLMAG_FINAL_ACTIVATION_TERMINAL_B64": base64.b64encode(activation_terminal_final_raw).decode("ascii"),
        "FULLMAG_FINAL_ACTIVATION_TERMINAL_SHA256": hashlib.sha256(activation_terminal_final_raw).hexdigest(),
        "FULLMAG_FINAL_ACTIVATION_TERMINAL_REPLACE_SHA256": hashlib.sha256(activation_terminal_raw).hexdigest(),
        "FULLMAG_FINAL_RECONCILING_SHA256": hashlib.sha256(reconciling_raw).hexdigest(),
        "FULLMAG_FINAL_RECEIPT_B64": base64.b64encode(final_raw).decode("ascii"),
        "FULLMAG_FINAL_RECEIPT_SHA256": hashlib.sha256(final_raw).hexdigest(),
        "FULLMAG_FINAL_TERMINAL_B64": base64.b64encode(final_raw).decode("ascii"),
        "FULLMAG_FINAL_TERMINAL_SHA256": hashlib.sha256(final_raw).hexdigest(),
        "FULLMAG_FINAL_CURRENT_B64": base64.b64encode(final_raw).decode("ascii"),
        "FULLMAG_FINAL_CURRENT_SHA256": hashlib.sha256(final_raw).hexdigest(),
    }
    name = "fullmag-control-finalize-" + reconciliation_attempt
    args = control.helper_args(script, name=name)
    entrypoint = args.index("--entrypoint")
    env_args: list[str] = []
    for key, value in values.items():
        env_args.extend(["--env", key + "=" + value])
    args[entrypoint:entrypoint] = env_args
    result = bounded_capture(args, data=b"", timeout=180)
    if result.returncode or b"FINALIZED\n" not in result.stdout:
        detail = (result.stderr + result.stdout).decode("utf-8", "replace")[-1024:]
        raise _fail("Managed reconciliation finalization did not commit its locked transaction: " + detail)


def _reconcile_absent_helper(
    control: BuildControl,
    *,
    active_raw: bytes,
    unresolved: Mapping[str, object] | None,
    previous: Mapping[str, object],
    document: Mapping[str, object],
    selected_source: str,
    config_sha256: str,
    image_id: str,
    backend_id: str,
    native: Mapping[str, object],
    terminal_process_sha256: str,
    receipt: Mapping[str, object],
    receipt_raw: bytes,
    activation_inputs: Mapping[str, object],
    helper_name: str,
    helper_absence_probe_sha256: str,
) -> dict[str, object]:
    """Finish an activation whose original helper is already absent.

    The host only performs authenticated reads.  All writes, including the
    quarantine and conditional removal of ``active``, are made by the new
    image-owned helper under the control volume operation lock.
    """
    activation_attempt = _attempt(active_raw.decode("utf-8").strip(), "active activation")
    reconciliation_attempt = _activation_reconciliation_token(activation_attempt)
    reconciliation_root = "activation-reconciliation/attempts/" + reconciliation_attempt
    receipt_sha256 = hashlib.sha256(receipt_raw).hexdigest()
    common_expected = {
        "activation_attempt": activation_attempt,
        "development_attempt": _attempt(previous.get("attempt"), "retained development attempt"),
        "config_sha256": config_sha256,
        "source_root": selected_source,
        "image_id": image_id,
        "backend_container": backend_id,
        "source_relative": activation_inputs["source_relative"],
        "source_sha256": activation_inputs["source_sha256"],
        "request_id": activation_inputs["request_id"],
        "provenance_sha256": activation_inputs["provenance_sha256"],
        "activation_receipt_key": activation_inputs["activation_receipt_key"],
        "activation_receipt_path": activation_inputs["activation_receipt_path"],
        "activation_receipt_sha256": receipt_sha256,
        "helper_container": helper_name,
        "helper_sha256": receipt["helper_sha256"],
        "native_stop_journal_sha256": native["journal_sha256"],
        "reconciliation_attempt": reconciliation_attempt,
    }
    existing_raw = _control_bytes(control, "activation/unresolved.json", optional=True)
    if (unresolved is None) != (existing_raw is None):
        raise _fail("Unresolved activation quarantine changed during reconciliation admission")
    if unresolved is not None:
        _validate_unresolved_activation(control, unresolved)
        for key, value in common_expected.items():
            if unresolved.get(key) != value:
                raise _fail("Existing unresolved activation quarantine differs: " + key)
        existing_state = unresolved.get("helper_state", "running")
        if existing_state == "absent-confirmed":
            if unresolved.get("helper_absence_probe_sha256") != helper_absence_probe_sha256:
                raise _fail("Existing helper absence proof differs")
        elif existing_state != "running":
            raise _fail("Existing unresolved activation helper state is invalid")
        created_at = unresolved.get("created_at")
        if not isinstance(created_at, (int, float)) or isinstance(created_at, bool):
            raise _fail("Existing unresolved activation timestamp is invalid")
    else:
        created_at = time.time()
    unresolved_record = {
        "schema": ACTIVATION_UNRESOLVED_SCHEMA,
        "state": UNKNOWN_STATE,
        "phase": "activation",
        "activation_outcome": UNKNOWN_STATE,
        "reason": UNKNOWN_REASON,
        "compose_project": control.project,
        "control_volume": control.volume,
        **common_expected,
        "helper_state": "absent-confirmed",
        "helper_id": None,
        "helper_absence_probe_sha256": helper_absence_probe_sha256,
        "created_at": created_at,
    }
    _validate_unresolved_activation(control, unresolved_record)
    unresolved_payload, _, _ = _payload(unresolved_record)
    # Preserve an already exact quarantine byte-for-byte.  If it was written
    # by the prior live-helper route, the helper transaction upgrades it to
    # the explicit absent-confirmed form using the old bytes as its CAS pin.
    unresolved_for_helper = existing_raw if existing_raw is not None else b""

    final_receipt = {
        "schema": OPERATION_SCHEMA,
        "phase": "activation-reconciliation",
        "state": "failed-confirmed",
        "attempt": reconciliation_attempt,
        "compose_project": control.project,
        "control_volume": control.volume,
        "reconciled_activation_attempt": activation_attempt,
        "activation_receipt_sha256": receipt_sha256,
        "helper_container": helper_name,
        "helper_id": None,
        "helper_state": "absent-confirmed",
        "helper_absence_probe_sha256": helper_absence_probe_sha256,
        "helper_image": control.image,
        "helper_sha256": receipt["helper_sha256"],
        "backend_container": backend_id,
        "image_id": image_id,
        "development_attempt": common_expected["development_attempt"],
        "config_sha256": config_sha256,
        "source_root": selected_source,
        "native_stop_journal_sha256": native["journal_sha256"],
        "activation_outcome": UNKNOWN_STATE,
        "reason": UNKNOWN_REASON,
        "started_at": time.time(),
        "finished_at": time.time(),
    }
    if native.get("namespace_attestation_path") is not None:
        final_receipt.update(
            namespace_attestation_path=native["namespace_attestation_path"],
            namespace_attestation_sha256=native["namespace_attestation_sha256"],
        )
    existing_receipt_raw = _control_bytes(
        control, reconciliation_root + "/receipt.json", optional=True,
    )
    reconciliation_replace_sha256 = ""
    existing_final_raw: bytes | None = None
    if existing_receipt_raw is not None:
        existing_receipt = _json(existing_receipt_raw, "existing activation reconciliation receipt")
        _validate_reconciliation_receipt(
            control,
            existing_receipt,
            reconciliation_attempt=reconciliation_attempt,
            activation_attempt=activation_attempt,
            expected={
                "activation_receipt_sha256": receipt_sha256,
                "backend_container": backend_id,
                "image_id": image_id,
                "development_attempt": common_expected["development_attempt"],
                "config_sha256": config_sha256,
                "source_root": selected_source,
                "native_stop_journal_sha256": native["journal_sha256"],
            },
        )
        existing_helper_state = existing_receipt.get("helper_state")
        if existing_receipt.get("helper_container") != helper_name:
            raise _fail("Existing activation reconciliation helper identity differs")
        if existing_receipt.get("state") == "reconciling":
            if existing_helper_state != "running":
                raise _fail("Existing reconciling activation helper state is invalid")
            existing_helper_id = _container(existing_receipt.get("helper_id"), "existing activation helper")
            if (unresolved is not None and unresolved.get("helper_state", "running") == "running"
                    and existing_helper_id != unresolved.get("helper_id")):
                raise _fail("Existing reconciling activation helper identity differs")
            reconciliation_replace_sha256 = hashlib.sha256(existing_receipt_raw).hexdigest()
        elif existing_receipt.get("state") == "failed-confirmed":
            if (existing_helper_state != "absent-confirmed"
                    or existing_receipt.get("helper_id") is not None
                    or existing_receipt.get("helper_absence_probe_sha256") != helper_absence_probe_sha256):
                raise _fail("Existing terminal activation helper absence differs")
            # The previous recovery helper may have published the final
            # receipt and then lost observation before its final CAS removal.
            # Reuse those exact bytes; never invent a second terminal record.
            final_receipt = existing_receipt
            existing_final_raw = existing_receipt_raw
        else:
            raise _fail("Existing activation reconciliation receipt has an invalid state")
    final_raw = existing_final_raw if existing_final_raw is not None else _payload(final_receipt)[0]
    if existing_receipt_raw is not None and hashlib.sha256(existing_receipt_raw).hexdigest() != hashlib.sha256(final_raw).hexdigest():
        raise _fail("Existing activation reconciliation receipt differs from the selected final record")

    for relative in (
        reconciliation_root + "/terminal.json",
        "activation-reconciliation/current.json",
    ):
        existing = _control_bytes(control, relative, optional=True)
        if existing is not None and hashlib.sha256(existing).hexdigest() != hashlib.sha256(final_raw).hexdigest():
            raise _fail("Existing activation reconciliation terminal differs")

    activation_terminal = {
        **receipt,
        "state": "failed-confirmed",
        "activation_outcome": UNKNOWN_STATE,
        "reason": UNKNOWN_REASON,
        "reconciliation_attempt": reconciliation_attempt,
        "helper_state": "absent-confirmed",
        "helper_id": None,
        "helper_absence_probe_sha256": helper_absence_probe_sha256,
        "finished_at": final_receipt["finished_at"],
    }
    activation_terminal_raw, _, _ = _payload(activation_terminal)
    activation_terminal_replace_sha256 = ""
    existing_activation_terminal = _control_bytes(
        control,
        "activation/attempts/" + activation_attempt + "/terminal.json",
        optional=True,
    )
    if existing_activation_terminal is not None:
        existing_terminal = _json(existing_activation_terminal, "existing activation terminal")
        if any(existing_terminal.get(key) != value for key, value in {
            "schema": OPERATION_SCHEMA,
            "phase": "activation",
            "attempt": activation_attempt,
            "compose_project": control.project,
            "control_volume": control.volume,
            "state": "failed-confirmed",
            "activation_outcome": UNKNOWN_STATE,
            "reason": UNKNOWN_REASON,
            "reconciliation_attempt": reconciliation_attempt,
            "helper_container": helper_name,
            "helper_sha256": receipt["helper_sha256"],
        }.items()):
            raise _fail("Unknown activation terminal differs; recovery will not overwrite it")
        if existing_terminal.get("inputs") != receipt.get("inputs"):
            raise _fail("Unknown activation terminal inputs differ; recovery will not overwrite it")
        terminal_helper_state = existing_terminal.get("helper_state")
        if terminal_helper_state == "absent-confirmed":
            if (existing_terminal.get("helper_id") is not None
                    or existing_terminal.get("helper_absence_probe_sha256") != helper_absence_probe_sha256):
                raise _fail("Existing activation terminal helper absence differs")
            activation_terminal_raw = existing_activation_terminal
        elif terminal_helper_state == "running":
            terminal_helper_id = _container(existing_terminal.get("helper_id"), "existing activation helper")
            if (unresolved is not None and unresolved.get("helper_state", "running") == "running"
                    and terminal_helper_id != unresolved.get("helper_id")):
                raise _fail("Existing activation terminal helper identity differs")
            activation_terminal_replace_sha256 = hashlib.sha256(existing_activation_terminal).hexdigest()
        else:
            raise _fail("Existing activation terminal has an invalid helper state")

    _run_absent_helper_reconciliation(
        control,
        activation_attempt=activation_attempt,
        reconciliation_attempt=reconciliation_attempt,
        backend_id=backend_id,
        stop_journal_sha256=native["journal_sha256"],
        terminal_process_sha256=terminal_process_sha256,
        active_raw=active_raw,
        receipt_raw=receipt_raw,
        unresolved_raw=unresolved_for_helper,
        unresolved_payload=unresolved_payload,
        reconciliation_payload=final_raw,
        reconciliation_replace_sha256=reconciliation_replace_sha256,
        reconciliation_terminal_payload=final_raw,
        reconciliation_current_payload=final_raw,
        activation_terminal_payload=activation_terminal_raw,
        activation_terminal_replace_sha256=activation_terminal_replace_sha256,
    )
    if _control_bytes(control, "active", optional=True) is not None:
        raise _fail("Managed reconciliation completed but active marker remains")
    committed_unresolved = _read_json(control, "activation/unresolved.json")
    _validate_unresolved_activation(control, committed_unresolved, expected={**common_expected,
        "helper_state": "absent-confirmed",
        "helper_absence_probe_sha256": helper_absence_probe_sha256,
    })
    committed = _read_json(control, reconciliation_root + "/receipt.json")
    validated = _validate_reconciliation_receipt(
        control,
        committed,
        reconciliation_attempt=reconciliation_attempt,
        activation_attempt=activation_attempt,
        expected={
            "activation_receipt_sha256": receipt_sha256,
            "backend_container": backend_id,
            "image_id": image_id,
            "development_attempt": common_expected["development_attempt"],
            "config_sha256": config_sha256,
            "source_root": selected_source,
            "native_stop_journal_sha256": native["journal_sha256"],
        },
    )
    if (validated.get("state") != "failed-confirmed"
            or validated.get("helper_id") is not None
            or validated.get("helper_state") != "absent-confirmed"
            or validated.get("helper_absence_probe_sha256") != helper_absence_probe_sha256):
        raise _fail("Managed reconciliation did not commit the helper absence proof")
    return validated


def _finalize_reconciling_without_active(
    control: BuildControl,
    *,
    unresolved: Mapping[str, object],
    selected_source: str,
    config_sha256: str,
    image_id: str,
    backend_id: str,
) -> dict[str, object]:
    """Finish a live-helper receipt after its lease was already removed.

    The live helper removes ``active`` only after it observes the technical
    activation terminal.  If the host exits before writing the final
    reconciliation receipt, that durable terminal is enough to finish the
    bookkeeping, while the original unknown activation remains untouched.
    """
    activation_attempt = _attempt(unresolved.get("activation_attempt"), "quarantined activation attempt")
    development_attempt = _attempt(unresolved.get("development_attempt"), "quarantined development attempt")
    reconciliation_attempt = _attempt(unresolved.get("reconciliation_attempt"), "quarantined reconciliation attempt")
    unresolved_raw = _control_bytes(control, "activation/unresolved.json")
    if _json(unresolved_raw, "unresolved activation quarantine") != dict(unresolved):
        raise _fail("Unresolved activation quarantine changed during technical finalization")
    helper_name = _text(unresolved.get("helper_container"), "quarantined activation helper")
    helper_state = unresolved.get("helper_state", "running")
    if helper_state == "running":
        helper_absence_probe_sha256 = _probe_helper_absence(helper_name)
        if helper_absence_probe_sha256 is None:
            raise _fail("Activation helper is still live; finalization will not guess its outcome")
    elif helper_state == "absent-confirmed":
        if unresolved.get("helper_id") is not None:
            raise _fail("Absent activation helper quarantine retains a container identity")
        helper_absence_probe_sha256 = _hash(
            unresolved.get("helper_absence_probe_sha256"),
            "helper absence probe digest",
        )
        observed_absence_probe = _probe_helper_absence(helper_name)
        if observed_absence_probe != helper_absence_probe_sha256:
            raise _fail("Activation helper absence proof changed during finalization")
    else:
        raise _fail("Activation helper quarantine has an invalid finalization state")
    receipt_raw = _control_bytes(
        control, "activation/attempts/" + activation_attempt + "/receipt.json",
    )
    if hashlib.sha256(receipt_raw).hexdigest() != unresolved.get("activation_receipt_sha256"):
        raise _fail("Retained activation receipt changed during technical finalization")
    receipt = _json(receipt_raw, "retained activation receipt")
    _validate_activation_receipt(
        control,
        activation_attempt=activation_attempt,
        development_attempt=development_attempt,
        config_sha256=config_sha256,
        source_root=selected_source,
        image_id=image_id,
        backend_id=backend_id,
    )
    reconciliation_root = "activation-reconciliation/attempts/" + reconciliation_attempt
    reconciliation_raw = _control_bytes(control, reconciliation_root + "/receipt.json")
    reconciliation = _json(reconciliation_raw, "activation reconciliation receipt")
    reconciliation_state = reconciliation.get("state")
    if reconciliation_state not in {"reconciling", "failed-confirmed"}:
        raise _fail("Activation reconciliation receipt is not finalizable")
    _validate_reconciliation_receipt(
        control,
        reconciliation,
        reconciliation_attempt=reconciliation_attempt,
        activation_attempt=activation_attempt,
        expected={
            "state": reconciliation_state,
            "activation_receipt_sha256": unresolved["activation_receipt_sha256"],
            "backend_container": backend_id,
            "image_id": image_id,
            "development_attempt": development_attempt,
            "config_sha256": config_sha256,
            "source_root": selected_source,
            "native_stop_journal_sha256": unresolved["native_stop_journal_sha256"],
        },
    )
    if reconciliation.get("helper_container") != unresolved["helper_container"]:
        raise _fail("Activation reconciliation helper identity differs")
    reconciliation_helper_state = reconciliation.get("helper_state")
    if reconciliation_state == "reconciling":
        if reconciliation_helper_state != "running":
            raise _fail("Reconciling activation helper identity differs")
        reconciliation_helper_id = reconciliation.get("helper_id")
        _container(reconciliation_helper_id, "reconciling activation helper")
        if (helper_state == "running"
                and reconciliation_helper_id != unresolved.get("helper_id")):
            raise _fail("Reconciling activation helper identity differs")
    elif reconciliation_helper_state == "absent-confirmed":
        if (reconciliation.get("helper_id") is not None
                or reconciliation.get("helper_absence_probe_sha256") != helper_absence_probe_sha256):
            raise _fail("Terminal activation helper absence differs")
    elif reconciliation_helper_state == "running":
        helper_id = reconciliation.get("helper_id")
        _container(helper_id, "reconciling activation helper")
        if helper_state == "running" and helper_id != unresolved.get("helper_id"):
            raise _fail("Terminal activation helper identity differs")
    else:
        raise _fail("Activation reconciliation has no helper lifecycle state")
    activation_terminal_raw = _control_bytes(
        control,
        "activation/attempts/" + activation_attempt + "/terminal.json",
        optional=True,
    )
    if activation_terminal_raw is None:
        raise _fail("Active lease is gone without a durable technical activation terminal")
    activation_terminal = _json(activation_terminal_raw, "technical activation terminal")
    required_terminal = {
        "schema": OPERATION_SCHEMA,
        "phase": "activation",
        "attempt": activation_attempt,
        "compose_project": control.project,
        "control_volume": control.volume,
        "state": "failed-confirmed",
        "activation_outcome": UNKNOWN_STATE,
        "reason": UNKNOWN_REASON,
        "reconciliation_attempt": reconciliation_attempt,
        "helper_container": unresolved["helper_container"],
        "helper_sha256": receipt.get("helper_sha256"),
    }
    if any(activation_terminal.get(key) != value for key, value in required_terminal.items()):
        raise _fail("Technical activation terminal does not match the retained reconciliation")
    terminal_helper_state = activation_terminal.get("helper_state")
    terminal_helper_id = activation_terminal.get("helper_id")
    if terminal_helper_state == "running":
        if helper_state == "running" and terminal_helper_id != unresolved.get("helper_id"):
            raise _fail("Technical activation terminal helper identity differs")
    elif terminal_helper_state == "absent-confirmed":
        if terminal_helper_id is not None or activation_terminal.get("helper_absence_probe_sha256") != helper_absence_probe_sha256:
            raise _fail("Technical activation terminal helper absence differs")
    else:
        raise _fail("Technical activation terminal has no helper lifecycle state")
    if activation_terminal.get("inputs") != receipt.get("inputs"):
        raise _fail("Technical activation terminal inputs differ from the retained receipt")
    if not isinstance(activation_terminal.get("finished_at"), (int, float)) \
            or isinstance(activation_terminal.get("finished_at"), bool):
        raise _fail("Technical activation terminal has no valid completion timestamp")
    if reconciliation_state == "failed-confirmed" and reconciliation.get("helper_state") == "absent-confirmed":
        # The receipt itself is already the exact final payload.  A prior
        # helper may have crashed after this first atomic publish; never mint
        # a second timestamp or alter its bytes while filling the siblings.
        final = dict(reconciliation)
    else:
        final = {
            **reconciliation,
            "state": "failed-confirmed",
            "helper_id": None,
            "helper_state": "absent-confirmed",
            "helper_absence_probe_sha256": helper_absence_probe_sha256,
            # The technical terminal is the durable completion event. Reusing
            # its timestamp makes this payload stable across a crash/replay.
            "finished_at": activation_terminal["finished_at"],
        }
    if reconciliation_state == "failed-confirmed" and reconciliation.get("helper_state") == "absent-confirmed":
        final_raw = reconciliation_raw
    else:
        final_raw, _, _ = _payload(final)
    final_unresolved = {
        **unresolved,
        "helper_id": None,
        "helper_state": "absent-confirmed",
        "helper_absence_probe_sha256": helper_absence_probe_sha256,
    }
    unresolved_final_raw, _, _ = _payload(final_unresolved)
    if helper_state == "absent-confirmed" and unresolved_final_raw != unresolved_raw:
        raise _fail("Absent activation quarantine is not canonical")
    if helper_state == "absent-confirmed":
        unresolved_final_raw = unresolved_raw
    final_activation_terminal = {
        **activation_terminal,
        "helper_id": None,
        "helper_state": "absent-confirmed",
        "helper_absence_probe_sha256": helper_absence_probe_sha256,
    }
    activation_terminal_final_raw, _, _ = _payload(final_activation_terminal)
    if terminal_helper_state == "absent-confirmed":
        activation_terminal_final_raw = activation_terminal_raw
    for relative in (
        reconciliation_root + "/terminal.json",
        "activation-reconciliation/current.json",
    ):
        existing = _control_bytes(control, relative, optional=True)
        if existing is not None and hashlib.sha256(existing).hexdigest() != hashlib.sha256(final_raw).hexdigest():
            raise _fail("Existing reconciliation final record differs during replay")
    _run_reconciliation_finalization(
        control,
        activation_attempt=activation_attempt,
        reconciliation_attempt=reconciliation_attempt,
        unresolved_raw=unresolved_raw,
        unresolved_final_raw=unresolved_final_raw,
        activation_receipt_raw=receipt_raw,
        activation_terminal_raw=activation_terminal_raw,
        activation_terminal_final_raw=activation_terminal_final_raw,
        reconciling_raw=reconciliation_raw,
        final_raw=final_raw,
    )
    committed_raw = _control_bytes(control, reconciliation_root + "/receipt.json")
    committed = _json(committed_raw, "final activation reconciliation receipt")
    validated = _validate_reconciliation_receipt(
        control,
        committed,
        reconciliation_attempt=reconciliation_attempt,
        activation_attempt=activation_attempt,
        expected={
            "activation_receipt_sha256": unresolved["activation_receipt_sha256"],
            "backend_container": backend_id,
            "image_id": image_id,
            "development_attempt": development_attempt,
            "config_sha256": config_sha256,
            "source_root": selected_source,
            "native_stop_journal_sha256": unresolved["native_stop_journal_sha256"],
        },
    )
    if (validated.get("state") != "failed-confirmed"
            or validated.get("helper_id") is not None
            or validated.get("helper_state") != "absent-confirmed"
            or validated.get("helper_absence_probe_sha256") != helper_absence_probe_sha256):
        raise _fail("Final activation reconciliation did not retain the helper absence proof")
    return validated


def reconcile_unknown_activation(
    control: BuildControl,
    *,
    previous: Mapping[str, object],
    document: Mapping[str, object],
    selected_source: str,
    config_sha256: str,
    image_id: str,
    backend_id: str,
    native_restart_metadata: Mapping[str, object] | None,
    fresh_state: bool = False,
) -> dict[str, object] | None:
    """Reconcile the exact active helper after a verified backend stop.

    ``None`` means that this development group has no active unknown
    activation.  A quarantine without an active helper is intentionally left
    intact; it is a permanent admission fence until a later canonical route
    proves the activation outcome.
    """
    active_raw = _control_bytes(control, "active", optional=True)
    unresolved = _read_json(control, "activation/unresolved.json", optional=True)
    if active_raw is None:
        if unresolved is None:
            return None
        if fresh_state:
            raise _fail("Unknown activation cannot be finalized with fresh session storage")
        _validate_unresolved_activation(control, unresolved)
        recon_attempt = unresolved.get("reconciliation_attempt")
        if not isinstance(recon_attempt, str) or ATTEMPT_RE.fullmatch(recon_attempt) is None:
            raise _fail("Unresolved activation has no valid reconciliation reference")
        receipt = _read_json(
            control,
            "activation-reconciliation/attempts/" + recon_attempt + "/receipt.json",
            optional=True,
        )
        if receipt is None:
            raise _fail("Unresolved activation is retained without a completed reconciliation")
        if receipt.get("state") == "reconciling":
            return _finalize_reconciling_without_active(
                control,
                unresolved=unresolved,
                selected_source=selected_source,
                config_sha256=config_sha256,
                image_id=image_id,
                backend_id=backend_id,
            )
        if receipt.get("state") != "failed-confirmed":
            raise _fail("Unresolved activation is retained without a completed reconciliation")
        final_raw = _control_bytes(
            control,
            "activation-reconciliation/attempts/" + recon_attempt + "/receipt.json",
        )
        complete = True
        for relative in (
            "activation-reconciliation/attempts/" + recon_attempt + "/terminal.json",
            "activation-reconciliation/current.json",
        ):
            sibling = _control_bytes(control, relative, optional=True)
            if sibling is None or sibling != final_raw:
                complete = False
                break
        activation_terminal = _read_json(
            control,
            "activation/attempts/" + str(unresolved["activation_attempt"]) + "/terminal.json",
            optional=True,
        )
        if not isinstance(activation_terminal, Mapping):
            complete = False
        elif (activation_terminal.get("helper_state") != "absent-confirmed"
              or activation_terminal.get("helper_id") is not None
              or activation_terminal.get("helper_absence_probe_sha256")
              != unresolved.get("helper_absence_probe_sha256")):
            complete = False
        if not complete:
            if unresolved.get("helper_state") not in {"running", "absent-confirmed"}:
                raise _fail("Terminal activation reconciliation is incomplete")
            return _finalize_reconciling_without_active(
                control,
                unresolved=unresolved,
                selected_source=selected_source,
                config_sha256=config_sha256,
                image_id=image_id,
                backend_id=backend_id,
            )
        if (unresolved.get("helper_state") != "absent-confirmed"
                or unresolved.get("helper_id") is not None
                or receipt.get("helper_state") != "absent-confirmed"
                or receipt.get("helper_id") is not None
                or receipt.get("helper_absence_probe_sha256") != unresolved.get("helper_absence_probe_sha256")):
            return _finalize_reconciling_without_active(
                control,
                unresolved=unresolved,
                selected_source=selected_source,
                config_sha256=config_sha256,
                image_id=image_id,
                backend_id=backend_id,
            )
        validated = _validate_reconciliation_receipt(
            control,
            receipt,
            reconciliation_attempt=recon_attempt,
            activation_attempt=str(unresolved["activation_attempt"]),
            expected={
                "activation_receipt_sha256": unresolved["activation_receipt_sha256"],
                "backend_container": unresolved["backend_container"],
                "image_id": unresolved["image_id"],
                "development_attempt": unresolved["development_attempt"],
                "config_sha256": unresolved["config_sha256"],
                "source_root": unresolved["source_root"],
                "native_stop_journal_sha256": unresolved["native_stop_journal_sha256"],
            },
        )
        if not _hash(validated.get("helper_absence_probe_sha256"), "helper absence probe digest"):
            raise _fail("Completed activation reconciliation has no helper absence proof")
        return validated

    if fresh_state:
        raise _fail("Unknown activation cannot be reconciled with fresh session storage")
    try:
        active_text = active_raw.decode("utf-8").strip()
    except UnicodeDecodeError as error:
        raise _fail("Control active marker is not UTF-8") from error
    activation_attempt = _attempt(active_text, "active activation")
    if not isinstance(previous, Mapping) or not isinstance(document, Mapping):
        raise _fail("Activation reconciliation has incomplete retained development records")
    development_attempt = _attempt(previous.get("attempt"), "retained development attempt")
    if document.get("name") != control.project or hashlib.sha256(canonical(document)).hexdigest() != config_sha256:
        raise _fail("Activation reconciliation Compose/config pin differs")
    previous_inputs = previous.get("inputs")
    if not isinstance(previous_inputs, Mapping) or previous_inputs.get("source_root") != selected_source:
        raise _fail("Activation reconciliation source differs")
    if previous_inputs.get("image_id") != image_id:
        raise _fail("Activation reconciliation image differs")
    _attempt(development_attempt, "retained development attempt")
    _hash(config_sha256, "reconciliation config digest")
    _image(image_id, "reconciliation image")
    _container(backend_id, "reconciliation backend")
    native = _validate_native_restart_metadata(
        native_restart_metadata,
        backend_id=backend_id,
        image_id=image_id,
    )
    journal_raw = _control_bytes(
        control,
        "verification/stop-failed-" + backend_id + ".json",
    )
    if hashlib.sha256(journal_raw).hexdigest() != native["journal_sha256"]:
        raise _fail("Native stop journal differs from retained restart metadata")
    journal = _json(journal_raw, "native failed-stop journal")
    if journal.get("failure_mode") != native.get("failure_mode"):
        raise _fail("Native stop journal failure mode differs from restart metadata")
    if (journal.get("schema") != "fullmag.stop-failed-admission.v1"
            or journal.get("state") != "stopped-confirmed"
            or journal.get("container_id") != backend_id
            or journal.get("image_id") != image_id):
        raise _fail("Native stop journal is not the exact stopped backend proof")
    terminal_process_raw = _control_bytes(control, "runtime-control/runtime-service/process-tree.json")
    terminal_process_sha256 = hashlib.sha256(terminal_process_raw).hexdigest()
    if terminal_process_sha256 != native["terminal_process_receipt_sha256"]:
        raise _fail("Native terminal process receipt differs from retained restart metadata")
    terminal_process = _json(terminal_process_raw, "native terminal process receipt")
    namespace_relative = _namespace_attestation_path(backend_id)
    namespace_raw = _control_bytes(control, namespace_relative, optional=True)
    namespace_attestation = None
    if namespace_raw is not None:
        owner_raw = _control_bytes(control, "runtime-control/runtime-services/OWNER.json")
        owner = _json(owner_raw, "native terminal failed owner")
        namespace_attestation = _validate_namespace_attestation(
            control,
            _json(namespace_raw, "stopped namespace attestation"),
            backend_id=backend_id,
            image_id=image_id,
            journal_raw=journal_raw,
            journal=journal,
            terminal_raw=terminal_process_raw,
            terminal=terminal_process,
            owner_raw=owner_raw,
            owner=owner,
            selected_source=selected_source,
        )
    if not isinstance(journal.get("container_state"), Mapping):
        if namespace_attestation is None:
            raise _fail("Legacy native stop journal requires a fresh namespace attestation")
    else:
        _validate_stopped_backend(control, backend_id, image_id, journal=journal)
    if namespace_attestation is not None:
        native["namespace_attestation_path"] = namespace_relative
        native["namespace_attestation_sha256"] = hashlib.sha256(namespace_raw).hexdigest()

    helper_name = "fullmag-control-" + activation_attempt
    receipt, receipt_raw, activation_inputs = _validate_activation_receipt(
        control,
        activation_attempt=activation_attempt,
        development_attempt=development_attempt,
        config_sha256=config_sha256,
        source_root=selected_source,
        image_id=image_id,
        backend_id=backend_id,
    )
    helper_absence_probe_sha256 = _probe_helper_absence(helper_name)
    if helper_absence_probe_sha256 is not None:
        return _reconcile_absent_helper(
            control,
            active_raw=active_raw,
            unresolved=unresolved,
            previous=previous,
            document=document,
            selected_source=selected_source,
            config_sha256=config_sha256,
            image_id=image_id,
            backend_id=backend_id,
            native=native,
            terminal_process_sha256=terminal_process_sha256,
            receipt=receipt,
            receipt_raw=receipt_raw,
            activation_inputs=activation_inputs,
            helper_name=helper_name,
            helper_absence_probe_sha256=helper_absence_probe_sha256,
        )
    if _read_json(control, "activation/attempts/" + activation_attempt + "/terminal.json", optional=True) is not None:
        raise _fail("Unknown activation already has a terminal record; recovery will not overwrite it")
    helper_document, helper_id = _validate_helper(control, helper_name, activation_attempt)
    helper_log = _validate_helper_logged(helper_id)
    reconciliation_attempt = _activation_reconciliation_token(activation_attempt)
    reconciliation_root = "activation-reconciliation/attempts/" + reconciliation_attempt
    existing_receipt = _read_json(control, reconciliation_root + "/receipt.json", optional=True)
    if existing_receipt is not None:
        _validate_reconciliation_receipt(
            control,
            existing_receipt,
            reconciliation_attempt=reconciliation_attempt,
            activation_attempt=activation_attempt,
            expected={
                "activation_receipt_sha256": hashlib.sha256(receipt_raw).hexdigest(),
                "backend_container": backend_id,
                "image_id": image_id,
                "development_attempt": development_attempt,
                "config_sha256": config_sha256,
                "source_root": selected_source,
                "native_stop_journal_sha256": native["journal_sha256"],
            },
        )
        if existing_receipt.get("state") == "failed-confirmed":
            raise _fail("Activation reconciliation is already terminal while its helper is active")

    unresolved_record = {
        "schema": ACTIVATION_UNRESOLVED_SCHEMA,
        "state": UNKNOWN_STATE,
        "phase": "activation",
        "activation_outcome": UNKNOWN_STATE,
        "reason": UNKNOWN_REASON,
        "compose_project": control.project,
        "control_volume": control.volume,
        "activation_attempt": activation_attempt,
        "development_attempt": development_attempt,
        "config_sha256": config_sha256,
        "source_root": selected_source,
        "image_id": image_id,
        "backend_container": backend_id,
        "source_relative": activation_inputs["source_relative"],
        "source_sha256": activation_inputs["source_sha256"],
        "request_id": activation_inputs["request_id"],
        "provenance_sha256": activation_inputs["provenance_sha256"],
        "activation_receipt_key": activation_inputs["activation_receipt_key"],
        "activation_receipt_path": activation_inputs["activation_receipt_path"],
        "activation_receipt_sha256": hashlib.sha256(receipt_raw).hexdigest(),
        "helper_container": helper_name,
        "helper_id": helper_id,
        "helper_state": "running",
        "helper_sha256": receipt["helper_sha256"],
        "native_stop_journal_sha256": native["journal_sha256"],
        "reconciliation_attempt": reconciliation_attempt,
        "created_at": time.time(),
    }
    if unresolved is not None:
        _validate_unresolved_activation(control, unresolved)
        if any(unresolved.get(key) != value for key, value in unresolved_record.items()
               if key != "created_at"):
            raise _fail("Existing unresolved activation quarantine differs")
    else:
        _validate_unresolved_activation(control, unresolved_record)

    initial_receipt = {
        "schema": OPERATION_SCHEMA,
        "phase": "activation-reconciliation",
        "state": "reconciling",
        "attempt": reconciliation_attempt,
        "compose_project": control.project,
        "control_volume": control.volume,
        "reconciled_activation_attempt": activation_attempt,
        "activation_receipt_sha256": unresolved_record["activation_receipt_sha256"],
        "helper_container": helper_name,
        "helper_id": helper_id,
        "helper_state": "running",
        "helper_image": control.image,
        "helper_sha256": receipt["helper_sha256"],
        "backend_container": backend_id,
        "image_id": image_id,
        "development_attempt": development_attempt,
        "config_sha256": config_sha256,
        "source_root": selected_source,
        "native_stop_journal_sha256": native["journal_sha256"],
        "activation_outcome": UNKNOWN_STATE,
        "reason": UNKNOWN_REASON,
        "helper_log_tail": helper_log,
        "started_at": time.time(),
    }
    if native.get("namespace_attestation_path") is not None:
        initial_receipt.update(
            namespace_attestation_path=native["namespace_attestation_path"],
            namespace_attestation_sha256=native["namespace_attestation_sha256"],
        )
    control.write(reconciliation_root + "/receipt.json", initial_receipt)
    if unresolved is None:
        control.write("activation/unresolved.json", unresolved_record)

    # This terminal file is intentionally technical: it releases only the
    # helper's control lease. The original receipt and image-owned activation
    # marker remain untouched, and the quarantine remains an admission fence.
    helper_terminal = {
        **receipt,
        "state": "failed-confirmed",
        "activation_outcome": UNKNOWN_STATE,
        "reason": UNKNOWN_REASON,
        "reconciliation_attempt": reconciliation_attempt,
        "helper_container": helper_name,
        "helper_id": helper_id,
        "helper_state": "running",
        "finished_at": time.time(),
    }
    control.write("activation/attempts/" + activation_attempt + "/terminal.json", helper_terminal)
    _wait_for_helper_exit(helper_id)
    return _finalize_reconciling_without_active(
        control,
        unresolved=unresolved if unresolved is not None else unresolved_record,
        selected_source=selected_source,
        config_sha256=config_sha256,
        image_id=image_id,
        backend_id=backend_id,
    )
