"""Preview or explicitly stop one pinned held-retirement diagnostic backend.

The apply path is intentionally limited to the exact backend whose retained
retirement was inspected by ``docker_volume_retirement_probe``.  It preserves
the activation receipt, result, current pointer, frontend and all volumes.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import shlex
import time
from collections.abc import Mapping
from typing import Any

from docker_build_control import (
    BuildControl,
    BuildControlError,
    ControlOutcomeUnknown,
    bounded_capture,
    canonical,
    docker_capture,
    toolchain_configuration,
)
from docker_dev_browser_qa import _resolve_selected
from docker_volume_activate import (
    _read_control_bytes,
    _retained_retirement_context,
    _validate_running_group,
    _wait_retirement_lease_release,
)
from docker_volume_activation_reconcile import _validate_helper
from docker_volume_retirement_probe import inspect_retirement
from docker_volume_stop_diagnostic import _validate_resume_terminal
from docker_volume_stop_unadmitted import (
    _owner_identity_key,
    _preflight_terminal_process_receipt,
    _read_terminal_process_receipt,
)


ATTEMPT_RE = re.compile(r"^[0-9a-f]{32}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
CONTAINER_RE = re.compile(r"^[0-9a-f]{64}$")
IMAGE_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
PROCESS_RECEIPT_SCHEMA = "fullmag.docker-process-tree.v1"
JOURNAL_SCHEMA = "fullmag.held-retirement-stop-journal.v1"
PLAN_SCHEMA = "fullmag.held-retirement-stop-plan.v1"
ABORTED_ACTIVATION_STATE = "operator-aborted-retirement-after-confirmed-drain"
MAX_RECEIPT_BYTES = 8 * 1024 * 1024
MAX_ORIGINAL_PROCESS_RECEIPT_BYTES = 512 * 1024


class HeldRetirementStopError(BuildControlError):
    """The exact held-retirement stop proof is absent or inconsistent."""


def _fail(message: str) -> HeldRetirementStopError:
    return HeldRetirementStopError(message)


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _object(raw: bytes, label: str) -> dict[str, Any]:
    if len(raw) > MAX_RECEIPT_BYTES:
        raise _fail(f"{label} exceeds its byte bound")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise _fail(f"{label} is not valid JSON") from error
    if not isinstance(value, dict):
        raise _fail(f"{label} is not a JSON object")
    return value


def _identity_digest(owner: Mapping[str, object], label: str) -> str:
    identity = _owner_identity_key(owner, label)
    normalized = [list(identity[0]), [list(item) for item in identity[1]]]
    return _sha256(canonical(normalized))


def _validate_proof(proof: Mapping[str, object]) -> None:
    if (proof.get("schema") != "fullmag.held-retirement-inspection.v1"
            or proof.get("state") != "observed"):
        raise _fail("fresh held-retirement inspection is not the expected proof")
    for key in ("development_attempt", "iteration_attempt", "activation_attempt"):
        if not isinstance(proof.get(key), str) or ATTEMPT_RE.fullmatch(str(proof[key])) is None:
            raise _fail("held-retirement proof has an invalid " + key)
    for key in ("config_sha256", "unknown_receipt_sha256", "proof_sha256"):
        if not isinstance(proof.get(key), str) or SHA256_RE.fullmatch(str(proof[key])) is None:
            raise _fail("held-retirement proof has an invalid " + key)
    for key in ("backend_container", "frontend_container", "helper_container_id"):
        if not isinstance(proof.get(key), str) or CONTAINER_RE.fullmatch(str(proof[key])) is None:
            raise _fail("held-retirement proof has an invalid " + key)
    if not isinstance(proof.get("image_id"), str) or IMAGE_RE.fullmatch(str(proof["image_id"])) is None:
        raise _fail("held-retirement proof has an invalid image identity")
    if not isinstance(proof.get("backend_started_at"), str) or not proof["backend_started_at"]:
        raise _fail("held-retirement proof has no backend incarnation pin")
    probe = proof.get("probe")
    if not isinstance(probe, Mapping):
        raise _fail("held-retirement proof has no read-only runtime probe")
    if (probe.get("schema") != "fullmag.held-retirement-read-only-probe.v1"
            or probe.get("task_lifecycle") != "failed"
            or probe.get("archive_present") is not False
            or probe.get("successor_marker_present") is not False
            or proof.get("execution_authorized") is not False
            or proof.get("full_ui_checkpoint") is not False):
        raise _fail("held-retirement proof does not establish the required non-archived failed task")


def plan(proof: Mapping[str, object]) -> dict[str, object]:
    """Return a timestamp-free, canonical plan for the exact reviewed proof."""
    _validate_proof(proof)
    activation_attempt = str(proof["activation_attempt"])
    body: dict[str, object] = {
        "schema": PLAN_SCHEMA,
        "state": "ready-for-explicit-apply",
        "proof_sha256": str(proof["proof_sha256"]),
        "proof": dict(proof),
        "journal_path": f"verification/held-retirement-stop-{activation_attempt}.json",
        "target": {
            "compose_project": proof["compose_project"],
            "development_attempt": proof["development_attempt"],
            "iteration_attempt": proof["iteration_attempt"],
            "activation_attempt": activation_attempt,
            "backend_container_id": proof["backend_container"],
            "frontend_container_id": proof["frontend_container"],
            "backend_image_id": proof["image_id"],
            "backend_started_at": proof["backend_started_at"],
            "original_helper_container_id": proof["helper_container_id"],
            "unknown_receipt_sha256": proof["unknown_receipt_sha256"],
        },
        "pre_stop": [
            "revalidate the original helper, active activation lease, raw receipt, and backend incarnation",
            "confirm the original failed diagnostic process receipt still matches the inspection SHA-256",
            "preflight authenticated terminal process-receipt readback",
        ],
        "stop": {
            "command": ["docker", "stop", "--time", "60", str(proof["backend_container"])],
            "scope": "the exact pinned backend container only",
        },
        "post_stop": [
            "require the same stopped container ID, StartedAt, and image, with no OOM",
            "accept the diagnostic entrypoint exit code 1 only with the pinned failed receipt and authenticated drain",
            "require drained terminal_service_owner identity to match the original Ready owner and all native children to be exited_success",
            "persist the operation journal before publishing the original helper terminal",
            "wait for the original helper to remove its own active lease",
        ],
        "preserved": [
            "frontend container and state",
            "original activation receipt and result",
            "activation current pointer",
            "all Docker volumes and run/session data",
        ],
        "claims": {
            "archive_present": False,
            "execution_authorized": False,
            "full_ui_checkpoint": False,
            "solve_or_retry": False,
            "backend_restart": False,
            "frontend_stop_or_restart": False,
            "volume_removal": False,
        },
    }
    return {**body, "plan_sha256": _sha256(canonical(body))}


def _control_context(args: argparse.Namespace) -> tuple[Any, Mapping[str, object], BuildControl]:
    selected, _, identity = _resolve_selected(args)
    configured = toolchain_configuration(selected, identity)
    try:
        helper_image = configured["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"]
    except (KeyError, TypeError) as error:
        raise _fail("canonical Docker control helper image is unavailable") from error
    return selected, identity, BuildControl(identity, helper_image)


def _read_original_process_receipt(backend_id: str) -> tuple[bytes, dict[str, Any]]:
    """Read the current process receipt from the exact still-running backend."""
    script = r'''import os,stat,sys
sys.path.insert(0,'/opt/fullmag')
import runtime_service as service
paths=service.canonical_paths()
path=service.process_receipt_path(paths)
for parent in (path,*path.parents):
    if parent.is_symlink(): raise RuntimeError('process receipt path contains a symlink')
fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
with os.fdopen(fd,'rb') as source:
    if not stat.S_ISREG(os.fstat(source.fileno()).st_mode): raise RuntimeError('process receipt is not regular')
    raw=source.read(8*1024*1024+1)
if len(raw)>8*1024*1024: raise RuntimeError('process receipt exceeds its bound')
sys.stdout.buffer.write(raw)
'''
    result = docker_capture(
        "exec", backend_id, "/usr/local/bin/python3", "-B", "-c", script, timeout=30,
    )
    if result.returncode:
        raise _fail("original process receipt could not be read from the pinned backend")
    raw = bytes(result.stdout)
    return raw, _object(raw, "original process receipt")


def _read_attempt_pins(
    args: argparse.Namespace,
    selected: Any,
    identity: Mapping[str, object],
    control: BuildControl,
    proof: Mapping[str, object],
    *,
    allow_stopped_backend: bool,
) -> dict[str, Any]:
    development_root = "development/attempts/" + args.attempt
    previous = control.read(development_root + "/terminal.json")
    compose = control.read(development_root + "/compose.json")
    if not isinstance(previous, Mapping) or not isinstance(compose, Mapping):
        raise _fail("retained development terminal or Compose document is missing")
    if _sha256(canonical(dict(compose))) != args.config_sha256:
        raise _fail("retained Compose digest changed")
    pin = _validate_resume_terminal(
        control,
        args.iteration_attempt,
        development_attempt=args.attempt,
        config_sha256=args.config_sha256,
        previous=previous,
        phase="iteration",
    )
    if (pin.get("backend_container") != proof.get("backend_container")
            or pin.get("backend_started_at") != proof.get("backend_started_at")
            or pin.get("frontend_container") != proof.get("frontend_container")):
        raise _fail("retained service incarnation differs from the reviewed proof")

    target = docker_capture("inspect", str(proof["backend_container"]), timeout=60)
    rows = json.loads(target.stdout)
    if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], Mapping):
        raise _fail("exact backend inspection is ambiguous")
    backend = dict(rows[0])
    state = backend.get("State")
    if (backend.get("Id") != proof.get("backend_container")
            or backend.get("Image") != proof.get("image_id")
            or not isinstance(state, Mapping)
            or state.get("StartedAt") != proof.get("backend_started_at")):
        raise _fail("backend ID, image, or StartedAt differs from the reviewed incarnation")
    if allow_stopped_backend:
        if state.get("Running") is not False:
            raise _fail("a journaled stop is resumable only after the exact backend is stopped")
    elif state.get("Running") is not True:
        raise _fail("backend is no longer running before its authorized stop")

    if allow_stopped_backend:
        terminal_existing = _read_control_bytes(
            control,
            "activation/attempts/" + args.activation_attempt + "/terminal.json",
            optional=True,
        )
        if terminal_existing is not None:
            raise ControlOutcomeUnknown(
                "operator-aborted terminal already exists; authenticate its journal and helper lease manually"
            )

    retained = _retained_retirement_context(
        control,
        development_attempt=args.attempt,
        config_sha256=args.config_sha256,
        source_root=str(selected),
        image_id=str(proof["image_id"]),
        backend_id=str(proof["backend_container"]),
    )
    if retained is None:
        raise _fail("original activation lease is no longer present")
    receipt, context, receipt_raw = retained
    retirement = context.get("retirement")
    if (context.get("operation_id") != args.activation_attempt
            or context.get("phase") != "retirement"
            or context.get("archive_sha256") is not None
            or context.get("terminal") is not None
            or not isinstance(retirement, Mapping)
            or retirement.get("state") != "pending"):
        raise _fail("retirement is no longer the selected pending pre-publication operation")
    receipt_sha = _sha256(receipt_raw)
    if receipt_sha != proof.get("unknown_receipt_sha256"):
        raise _fail("original unknown activation receipt bytes changed")

    active_raw = _read_control_bytes(control, "active", optional=True, maximum=256)
    if active_raw is None or active_raw.strip() != args.activation_attempt.encode("ascii"):
        raise _fail("original activation helper no longer owns the active lease")
    _, helper_id = _validate_helper(control, receipt["helper_container"], args.activation_attempt)
    if helper_id != proof.get("helper_container_id"):
        raise _fail("original activation helper incarnation changed")

    result_path = "activation/attempts/" + args.activation_attempt + "/result.json"
    terminal_path = "activation/attempts/" + args.activation_attempt + "/terminal.json"
    result_raw = _read_control_bytes(control, result_path, optional=True)
    terminal_raw = _read_control_bytes(control, terminal_path, optional=True)
    if terminal_raw is not None:
        raise _fail("original activation terminal already exists outside this stop journal")
    current_raw = _read_control_bytes(control, "activation/current.json", optional=True)
    if allow_stopped_backend and (active_raw is None or helper_id != proof.get("helper_container_id")):
        raise _fail("stopped-backend resume lost its original helper lease")
    _preflight_terminal_process_receipt(backend, control)

    probe = proof.get("probe")
    observed_probe = probe if isinstance(probe, Mapping) else None
    expected_process_sha = (
        observed_probe.get("process_receipt_sha256")
        if isinstance(observed_probe, Mapping) else None
    )
    if not isinstance(expected_process_sha, str) or SHA256_RE.fullmatch(expected_process_sha) is None:
        raise _fail("read-only probe has no original process receipt digest")
    original_process_raw: bytes | None = None
    original_process: dict[str, Any] | None = None
    if not allow_stopped_backend:
        original_process_raw, original_process = _read_original_process_receipt(str(proof["backend_container"]))
        if _sha256(original_process_raw) != expected_process_sha:
            raise _fail("original raw process receipt SHA-256 differs from the read-only probe")
        if len(original_process_raw) > MAX_ORIGINAL_PROCESS_RECEIPT_BYTES:
            raise _fail("original process receipt is too large to retain in the bounded stop journal")
        if (original_process.get("schema") != PROCESS_RECEIPT_SCHEMA
                or original_process.get("state") != "failed_outcome_retained"
                or original_process.get("api_diagnostic_only") is not True
                or not isinstance(original_process.get("service_owner"), Mapping)):
            raise _fail("original process receipt is not the pinned diagnostic-only failed state")

    if not allow_stopped_backend:
        effective = dict(previous, backend_container=pin["backend_container"],
                         frontend_container=pin["frontend_container"])
        running_backend, running_frontend = _validate_running_group(
            control,
            identity,
            compose,
            effective,
            str(proof["image_id"]),
            source_root=str(selected),
            require_healthy=False,
        )
        if (running_backend != proof["backend_container"]
                or running_frontend != proof["frontend_container"]):
            raise _fail("live Compose group differs from the exact reviewed service identities")

    return {
        "backend": backend,
        "compose": dict(compose),
        "pin": pin,
        "receipt": dict(receipt),
        "context": dict(context),
        "receipt_raw": receipt_raw,
        "receipt_sha256": receipt_sha,
        "helper_id": helper_id,
        "active_raw": active_raw,
        "result_raw": result_raw,
        "current_raw": current_raw,
        "result_sha256": _sha256(result_raw) if result_raw is not None else None,
        "current_sha256": _sha256(current_raw) if current_raw is not None else None,
        "original_process_raw": original_process_raw,
        "original_process": original_process,
        "original_process_sha256": expected_process_sha,
        "original_owner": original_process.get("service_owner") if original_process else None,
        "terminal_path": terminal_path,
    }


def _journal_path(activation_attempt: str) -> str:
    if ATTEMPT_RE.fullmatch(activation_attempt) is None:
        raise _fail("activation attempt is not canonical")
    return f"verification/held-retirement-stop-{activation_attempt}.json"


def _restore_original_process_receipt(
    proof: Mapping[str, object], journal: Mapping[str, object], pins: dict[str, Any]
) -> None:
    if (journal.get("original_unknown_receipt_sha256") != pins.get("receipt_sha256")
            or journal.get("original_result_sha256") != pins.get("result_sha256")
            or journal.get("original_current_sha256") != pins.get("current_sha256")
            or journal.get("original_helper_container_id") != pins.get("helper_id")
            or journal.get("original_active_sha256") != _sha256(pins.get("active_raw") or b"")):
        raise _fail("original receipt, result, current pointer, or helper differs from the stop journal")
    encoded = journal.get("original_process_receipt_b64")
    if not isinstance(encoded, str):
        raise _fail("stop journal does not preserve the original raw process receipt")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, base64.binascii.Error) as error:
        raise _fail("stop journal original process receipt encoding is invalid") from error
    probe = proof.get("probe")
    expected_sha = probe.get("process_receipt_sha256") if isinstance(probe, Mapping) else None
    if (not isinstance(expected_sha, str) or SHA256_RE.fullmatch(expected_sha) is None
            or len(raw) > MAX_ORIGINAL_PROCESS_RECEIPT_BYTES
            or _sha256(raw) != expected_sha
            or journal.get("original_process_receipt_sha256") != expected_sha):
        raise _fail("journaled original raw process receipt does not match the inspected SHA-256")
    process = _object(raw, "journaled original process receipt")
    owner = process.get("service_owner")
    if (process.get("schema") != PROCESS_RECEIPT_SCHEMA
            or process.get("state") != "failed_outcome_retained"
            or process.get("api_diagnostic_only") is not True
            or not isinstance(owner, Mapping)):
        raise _fail("journaled original process receipt is not the pinned diagnostic-only failure")
    owner_sha = _identity_digest(owner, "journaled original Ready service owner")
    if owner_sha != journal.get("ready_owner_identity_sha256"):
        raise _fail("journaled Ready owner identity differs from the preserved original receipt")
    pins["original_process_raw"] = raw
    pins["original_process"] = process
    pins["original_process_sha256"] = expected_sha
    pins["original_owner"] = owner


def _publish_journal(
    control: BuildControl,
    relative: str,
    document: Mapping[str, object],
    *,
    expected_raw: bytes | None,
) -> bytes:
    """Publish one journal generation under a control-volume flock/CAS."""
    path = control.path(relative)
    parent = path.rsplit("/", 1)[0]
    lock_path = control.path("verification/.held-retirement-stop-journal.lock")
    new_raw = canonical(dict(document)) + b"\n"
    expected_sha = "ABSENT" if expected_raw is None else _sha256(expected_raw)
    new_sha = _sha256(new_raw)
    script = (
        "set -euo pipefail; umask 027; "
        f"mkdir -p {shlex.quote(parent)}; test \"$(readlink -f {shlex.quote(parent)})\" = {shlex.quote(parent)}; "
        f"test ! -L {shlex.quote(lock_path)}; exec 9>{shlex.quote(lock_path)}; flock -x 9; "
        f"test ! -L {shlex.quote(path)}; "
        f"if test -e {shlex.quote(path)}; then test -f {shlex.quote(path)}; "
        f"test \"$(stat -c %h {shlex.quote(path)})\" = 1; "
        f"current=$(sha256sum {shlex.quote(path)} | cut -d ' ' -f 1); "
        f"if test \"$current\" = '{new_sha}'; then printf 'SAME\\n'; exit 0; fi; "
        f"test '{expected_sha}' != ABSENT; test \"$current\" = '{expected_sha}'; "
        f"else test '{expected_sha}' = ABSENT; fi; "
        f"t=$(mktemp {shlex.quote(parent + '/.held-retirement-stop.XXXXXXXX')}); "
        "trap 'rm -f -- \"$t\"' EXIT; cat > \"$t\"; sync \"$t\"; "
        f"test \"$(sha256sum \"$t\" | cut -d ' ' -f 1)\" = '{new_sha}'; "
        f"if test '{expected_sha}' = ABSENT; then "
        f"if ln -- \"$t\" {shlex.quote(path)}; then rm -- \"$t\"; sync {shlex.quote(parent)}; printf 'PUBLISHED\\n'; "
        f"else test -f {shlex.quote(path)}; test ! -L {shlex.quote(path)}; "
        f"test \"$(sha256sum {shlex.quote(path)} | cut -d ' ' -f 1)\" = '{new_sha}'; "
        "printf 'SAME\\n'; fi; "
        f"else mv -T -- \"$t\" {shlex.quote(path)}; sync {shlex.quote(parent)}; printf 'PUBLISHED\\n'; fi"
    )
    result = bounded_capture(control.helper_args(script), data=new_raw, timeout=90)
    if result.returncode:
        raise ControlOutcomeUnknown(
            "held-retirement journal publication failed; retained journal and Docker state require inspection: "
            + result.stderr.decode("utf-8", "replace")[-1024:]
        )
    observed = _read_control_bytes(control, relative, maximum=MAX_RECEIPT_BYTES)
    if observed != new_raw:
        raise ControlOutcomeUnknown("held-retirement journal readback differs after publication")
    return new_raw


def _verify_stopped_and_drained(
    proof: Mapping[str, object],
    pins: Mapping[str, Any],
    control: BuildControl,
) -> dict[str, Any]:
    actual = json.loads(docker_capture("inspect", str(proof["backend_container"]), timeout=60).stdout)
    if not isinstance(actual, list) or len(actual) != 1 or not isinstance(actual[0], Mapping):
        raise _fail("post-stop backend inspection is ambiguous")
    stopped = dict(actual[0])
    state = stopped.get("State")
    if (stopped.get("Id") != proof.get("backend_container")
            or stopped.get("Image") != proof.get("image_id")
            or not isinstance(state, Mapping)
            or state.get("Running") is not False
            or state.get("OOMKilled") is not False
            or type(state.get("ExitCode")) is not int
            or state.get("ExitCode") != 1
            or state.get("StartedAt") != proof.get("backend_started_at")):
        raise _fail("backend stop outcome differs from the exact pinned diagnostic incarnation")
    raw, drained = _read_terminal_process_receipt(stopped, control)
    if (drained.get("schema") != PROCESS_RECEIPT_SCHEMA
            or drained.get("state") != "drained"
            or drained.get("api_diagnostic_only") is not True
            or not isinstance(drained.get("service_owner"), Mapping)
            or not isinstance(drained.get("terminal_service_owner"), Mapping)):
        raise _fail("post-stop process receipt is not the canonical authenticated diagnostic drain")
    original_owner = pins.get("original_owner")
    if not isinstance(original_owner, Mapping):
        raise _fail("authenticated original process receipt has no Ready service owner")
    ready_identity = _owner_identity_key(original_owner, "original Ready service owner")
    current_identity = _owner_identity_key(drained["service_owner"], "drained receipt Ready owner")
    terminal_identity = _owner_identity_key(drained["terminal_service_owner"], "terminal drained owner")
    if ready_identity != current_identity or ready_identity != terminal_identity:
        raise _fail("authenticated terminal owner identity differs from the original Ready owner")
    children = drained["terminal_service_owner"].get("children")
    if (not isinstance(children, list) or not children
            or any(not isinstance(child, Mapping) or child.get("status") != "exited_success"
                   for child in children)):
        raise _fail("authenticated native drain has a child that did not exit successfully")
    return {
        "backend_id": stopped["Id"],
        "backend_image_id": stopped["Image"],
        "backend_started_at": state["StartedAt"],
        "backend_finished_at": state.get("FinishedAt"),
        "backend_exit_code": state["ExitCode"],
        "docker_oom_killed": state["OOMKilled"],
        "docker_stop_command_exit_code": 0,
        "drained_process_receipt_sha256": _sha256(raw),
        "drained_process_receipt": drained,
        "ready_owner_identity_sha256": _identity_digest(original_owner, "original Ready service owner"),
        "terminal_owner_identity_sha256": _identity_digest(
            drained["terminal_service_owner"], "terminal drained owner"
        ),
        "native_children_exit_status": "exited_success",
    }


def _terminal_document(
    receipt: Mapping[str, object],
    *,
    journal_sha256: str,
    proof: Mapping[str, object],
    drained: Mapping[str, object],
) -> dict[str, object]:
    terminal = dict(receipt)
    terminal.update(
        state="failed-confirmed",
        activation_state=ABORTED_ACTIVATION_STATE,
        retirement_resume_state="operator-aborted-after-confirmed-drain",
        stop_journal_sha256=journal_sha256,
        original_unknown_receipt_sha256=proof["unknown_receipt_sha256"],
        terminal_process_receipt_sha256=drained["drained_process_receipt_sha256"],
        backend_container_id=proof["backend_container"],
        backend_image_id=proof["image_id"],
        backend_started_at=proof["backend_started_at"],
        backend_exit_code=drained["backend_exit_code"],
        archive_present=False,
        successor_marker_present=False,
        execution_authorized=False,
        full_ui_checkpoint=False,
    )
    return terminal


def _preserve_original_records(
    control: BuildControl,
    activation_attempt: str,
    pins: Mapping[str, Any],
) -> None:
    root = "activation/attempts/" + activation_attempt
    receipt_now = _read_control_bytes(control, root + "/receipt.json")
    result_now = _read_control_bytes(control, root + "/result.json", optional=True)
    current_now = _read_control_bytes(control, "activation/current.json", optional=True)
    if receipt_now != pins["receipt_raw"]:
        raise ControlOutcomeUnknown("original activation receipt changed during confirmed stop")
    if result_now != pins["result_raw"]:
        raise ControlOutcomeUnknown("original activation result changed during confirmed stop")
    if current_now != pins["current_raw"]:
        raise ControlOutcomeUnknown("activation current pointer changed during confirmed stop")


def _finish_from_drain(
    args: argparse.Namespace,
    proof: Mapping[str, object],
    journal: dict[str, Any],
    journal_raw: bytes,
    pins: Mapping[str, Any],
    control: BuildControl,
) -> dict[str, object]:
    _preserve_original_records(control, args.activation_attempt, pins)
    active_raw = _read_control_bytes(control, "active", optional=True, maximum=256)
    if (active_raw is None or active_raw != pins.get("active_raw")
            or active_raw.strip() != args.activation_attempt.encode("ascii")):
        raise ControlOutcomeUnknown("original activation helper no longer owns the active lease before terminal")
    receipt_now = _read_control_bytes(
        control, "activation/attempts/" + args.activation_attempt + "/receipt.json",
    )
    if receipt_now != pins["receipt_raw"]:
        raise ControlOutcomeUnknown("original activation receipt changed before terminal publication")
    _, helper_id = _validate_helper(
        control, pins["receipt"]["helper_container"], args.activation_attempt,
    )
    if helper_id != pins["helper_id"]:
        raise ControlOutcomeUnknown("original live helper incarnation changed before terminal publication")
    journal_sha = _sha256(journal_raw)
    terminal = _terminal_document(
        pins["receipt"],
        journal_sha256=journal_sha,
        proof=proof,
        drained=journal["drain"],
    )
    terminal_path = pins["terminal_path"]
    terminal_raw = _publish_journal(
        control,
        terminal_path,
        terminal,
        expected_raw=None,
    )
    if not _wait_retirement_lease_release(control, operation_id=args.activation_attempt):
        raise ControlOutcomeUnknown(
            "confirmed drain terminal was published, but the original helper has not released its active lease"
        )
    _preserve_original_records(control, args.activation_attempt, pins)
    expected_terminal_raw = canonical(terminal) + b"\n"
    if terminal_raw != expected_terminal_raw:
        raise ControlOutcomeUnknown("published operator-aborted terminal differs from the journal-bound record")
    return {
        "schema": JOURNAL_SCHEMA,
        "state": "failed-confirmed",
        "activation_state": ABORTED_ACTIVATION_STATE,
        "journal_path": _journal_path(args.activation_attempt),
        "journal_sha256": journal_sha,
        "terminal_sha256": _sha256(terminal_raw),
        "original_unknown_receipt_sha256": proof["unknown_receipt_sha256"],
        "backend_container_id": proof["backend_container"],
        "backend_exit_code": journal["drain"]["backend_exit_code"],
        "archive_present": False,
        "execution_authorized": False,
        "full_ui_checkpoint": False,
        "active_lease_released": True,
    }


def apply(args: argparse.Namespace) -> dict[str, object]:
    if args.allow_ui_reset is not True:
        raise _fail("apply requires the explicit --allow-ui-reset acknowledgement")
    if not isinstance(args.expected_plan_sha256, str) or SHA256_RE.fullmatch(args.expected_plan_sha256) is None:
        raise _fail("apply requires --expected-plan-sha256 with the reviewed plan digest")

    selected, identity, control = _control_context(args)
    journal_rel = _journal_path(args.activation_attempt)
    existing_journal_raw = _read_control_bytes(control, journal_rel, optional=True)

    if existing_journal_raw is None:
        proof = inspect_retirement(args)
        fresh_plan = plan(proof)
        if args.expected_plan_sha256 != fresh_plan["plan_sha256"]:
            raise _fail("reviewed plan SHA-256 does not match the fresh canonical plan")
        pins = _read_attempt_pins(
            args, selected, identity, control, proof, allow_stopped_backend=False,
        )
        initial = {
            "schema": JOURNAL_SCHEMA,
            "state": "stop-started",
            "plan_sha256": fresh_plan["plan_sha256"],
            "proof": dict(proof),
            "journal_path": journal_rel,
            "development_attempt": args.attempt,
            "iteration_attempt": args.iteration_attempt,
            "activation_attempt": args.activation_attempt,
            "compose_project": control.project,
            "control_namespace": control.namespace,
            "backend_container_id": proof["backend_container"],
            "backend_image_id": proof["image_id"],
            "backend_started_at": proof["backend_started_at"],
            "frontend_container_id": proof["frontend_container"],
            "original_helper_container_id": pins["helper_id"],
            "original_unknown_receipt_sha256": pins["receipt_sha256"],
            "original_process_receipt_sha256": pins["original_process_sha256"],
            "original_process_receipt_b64": base64.b64encode(
                pins["original_process_raw"]
            ).decode("ascii"),
            "original_result_sha256": pins["result_sha256"],
            "original_current_sha256": pins["current_sha256"],
            "original_active_sha256": _sha256(pins["active_raw"]),
            "ready_owner_identity_sha256": _identity_digest(
                pins["original_owner"], "original Ready service owner"
            ),
            "archive_present": False,
            "execution_authorized": False,
            "full_ui_checkpoint": False,
            "created_at": time.time(),
            "stop_command": ["docker", "stop", "--time", "60", str(proof["backend_container"])],
        }
        journal_raw = _publish_journal(control, journal_rel, initial, expected_raw=None)
        # Recheck the lease, helper, original raw receipt, live group and
        # diagnostic process receipt after journal creation and immediately
        # before targeting Docker.
        barrier_pins = _read_attempt_pins(
            args, selected, identity, control, proof, allow_stopped_backend=False,
        )
        for key in (
            "receipt_raw", "active_raw", "helper_id", "original_process_sha256", "result_raw", "current_raw",
        ):
            if barrier_pins.get(key) != pins.get(key):
                raise ControlOutcomeUnknown("held-retirement pins changed at the immediate pre-stop barrier")
        try:
            stopped = docker_capture(
                "stop", "--time", "60", str(proof["backend_container"]), timeout=90,
            )
        except BaseException as error:
            # Leave the pre-stop journal intact; Docker may have completed a
            # stop even when this client lost its response.
            raise ControlOutcomeUnknown(
                "backend stop outcome is unknown; journal retained for stopped-state drain recovery"
            ) from error
        if stopped.returncode != 0:
            raise ControlOutcomeUnknown(
                "managed Docker stop returned nonzero; journal retained and no terminal was published"
            )
        initial = dict(initial, docker_stop_command_return_code=stopped.returncode)
        journal_raw = _publish_journal(
            control, journal_rel, initial, expected_raw=journal_raw,
        )
    else:
        journal_doc = _object(existing_journal_raw, "held-retirement stop journal")
        if journal_doc.get("schema") != JOURNAL_SCHEMA or journal_doc.get("journal_path") != journal_rel:
            raise _fail("existing stop journal is not bound to this activation attempt")
        proof_value = journal_doc.get("proof")
        if not isinstance(proof_value, Mapping):
            raise _fail("existing stop journal has no original inspection proof")
        proof = dict(proof_value)
        _validate_proof(proof)
        saved_plan = plan(proof)
        if (journal_doc.get("plan_sha256") != saved_plan["plan_sha256"]
                or args.expected_plan_sha256 != saved_plan["plan_sha256"]):
            raise _fail("existing journal does not match the reviewed canonical plan")
        if journal_doc.get("state") not in {"stop-started", "drain-confirmed"}:
            raise _fail("existing stop journal is not resumable from a pinned stopped backend")
        if any(journal_doc.get(key) != expected for key, expected in {
            "development_attempt": args.attempt,
            "iteration_attempt": args.iteration_attempt,
            "activation_attempt": args.activation_attempt,
            "compose_project": control.project,
            "control_namespace": control.namespace,
            "backend_container_id": proof["backend_container"],
            "backend_image_id": proof["image_id"],
            "backend_started_at": proof["backend_started_at"],
            "frontend_container_id": proof["frontend_container"],
            "original_unknown_receipt_sha256": proof["unknown_receipt_sha256"],
            "original_process_receipt_sha256": proof["probe"]["process_receipt_sha256"],
            "archive_present": False,
            "execution_authorized": False,
            "full_ui_checkpoint": False,
        }.items()):
            raise _fail("existing stop journal belongs to another control identity")
        if journal_doc.get("docker_stop_command_return_code") != 0:
            raise ControlOutcomeUnknown(
                "journal has no successful Docker stop response; manual recovery is required"
            )
        backend_rows = json.loads(docker_capture("inspect", str(proof["backend_container"]), timeout=60).stdout)
        if (not isinstance(backend_rows, list) or len(backend_rows) != 1
                or not isinstance(backend_rows[0], Mapping)
                or backend_rows[0].get("State", {}).get("Running") is not False):
            raise _fail("existing stop journal is resumable only for its exact stopped backend")
        pins = _read_attempt_pins(
            args, selected, identity, control, proof, allow_stopped_backend=True,
        )
        journal = dict(journal_doc)
        journal_raw = existing_journal_raw
        _restore_original_process_receipt(proof, journal, pins)
        if (journal.get("original_helper_container_id") != pins["helper_id"]
                or journal.get("original_unknown_receipt_sha256") != pins["receipt_sha256"]
                or journal.get("original_result_sha256") != pins["result_sha256"]
                or journal.get("original_current_sha256") != pins["current_sha256"]):
            raise _fail("retained activation helper, receipt, result, or current pointer differs from the journal")

    if existing_journal_raw is None:
        journal = initial
        # The command response alone is not drain proof. Re-read the exact
        # stopped incarnation and authenticate the image-owned drain receipt.
        pins = _read_attempt_pins(
            args, selected, identity, control, proof, allow_stopped_backend=True,
        )
        _restore_original_process_receipt(proof, journal, pins)

    if journal.get("docker_stop_command_return_code") != 0:
        raise ControlOutcomeUnknown(
            "stop journal has no successful Docker command response; preserve it for manual recovery"
        )

    drain = _verify_stopped_and_drained(proof, pins, control)
    if (drain.get("backend_exit_code") != 1
            or pins["original_process"].get("state") != "failed_outcome_retained"
            or pins["original_process"].get("api_diagnostic_only") is not True):
        raise _fail("exit code 1 is accepted only for the pinned failed diagnostic-only process receipt")
    prior_drain = journal.get("drain")
    if prior_drain is not None:
        if not isinstance(prior_drain, Mapping) or dict(prior_drain) != drain:
            raise ControlOutcomeUnknown("drained backend or authenticated receipt differs from the retained journal")
        final_journal_raw = journal_raw
    else:
        journal.update(state="drain-confirmed", drain=drain, drain_confirmed_at=time.time())
        final_journal_raw = _publish_journal(
            control, journal_rel, journal, expected_raw=journal_raw,
        )
    return _finish_from_drain(args, proof, journal, final_journal_raw, pins, control)
