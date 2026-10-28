"""Prepare exact abrupt-stop recovery evidence without starting an application."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys

from docker_build_control import BuildControl, BuildControlError, canonical, toolchain_configuration
from docker_compose_identity import compose_project_identity
from docker_development_inputs import select_checkout
import docker_volume_container_recovery as recovery
import fullmag_storage as storage


MAX_INPUT_BYTES = 1024 * 1024


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise BuildControlError("Recovery preparation input has a duplicate JSON key")
        value[key] = item
    return value


def _read_input(path):
    # Use the platform's existing no-follow bounded evidence reader.
    from docker_volume_dev import _session_host
    raw = _session_host().read_owned_regular(Path(path).absolute(), MAX_INPUT_BYTES)
    value = json.loads(raw, object_pairs_hook=_unique_object)
    if not isinstance(value, dict):
        raise BuildControlError("Recovery preparation pins must be an object")
    return value


def _publish_once(control, relative, raw):
    existing = control.read_bytes(relative, optional=True)
    if existing is not None:
        if existing != raw:
            raise BuildControlError("Recovery preparation destination already contains different evidence: " + relative)
        return
    control.write_bytes(relative, raw)
    if control.read_bytes(relative) != raw:
        raise BuildControlError("Recovery preparation readback differs: " + relative)


def _read_retained_run_inputs(terminal_path, held_path):
    if held_path is not None and terminal_path is None:
        raise BuildControlError("--retained-held-manual-runs requires --retained-terminal-runs")
    if terminal_path is None:
        return None, None
    from docker_volume_dev import _session_host
    host = _session_host()
    def read_array(path, label):
        raw = host.read_owned_regular(path.absolute(), MAX_INPUT_BYTES)
        value = json.loads(raw, object_pairs_hook=_unique_object)
        if not isinstance(value, list):
            raise BuildControlError(label + " input must be an array")
        return value
    terminal = read_array(terminal_path, "Retained terminal run")
    held = read_array(held_path, "Retained held-manual run") if held_path is not None else None
    return terminal, held


def prepare(
    control, pins, compose, *,
    retained_terminal_runs=None, retained_held_manual_runs=None, retained_attempt_histories=None, publish=False
):
    """Return proof/auth references; publish only after a second frozen read."""
    if retained_held_manual_runs is not None and retained_terminal_runs is None:
        raise BuildControlError("V4 held-manual pins require --retained-terminal-runs, including an empty array")
    if retained_attempt_histories is not None and retained_held_manual_runs is None:
        raise BuildControlError("V5 attempt history requires both retained-run arrays")
    proof = recovery.prepare_abrupt_stop_proof(
        control, pins, compose, retained_terminal_runs=retained_terminal_runs,
        retained_held_manual_runs=retained_held_manual_runs,
        **({"retained_attempt_histories": retained_attempt_histories} if retained_attempt_histories is not None else {}),
    )
    proof_raw = recovery._canonical(proof)
    root = recovery.RECOVERY_RELATIVE_ROOT + "/" + pins["request_id"]
    proof_path = root + "/abrupt-stop-proof.json"
    operator_path = root + "/operator.json"
    operator = {
        "schema_version": recovery.ABRUPT_OPERATOR_SCHEMA,
        **pins,
        "abrupt_stop_proof": proof_path,
        "abrupt_stop_proof_sha256": hashlib.sha256(proof_raw).hexdigest(),
    }
    authorization = recovery.validate_operator_authorization(operator)
    operator_raw = recovery._canonical(operator)
    result = {
        "schema": "fullmag.container-recovery-preparation-result.v1",
        "state": "validated-read-only",
        "compose_project": control.project,
        "proof_path": proof_path,
        "proof_sha256": hashlib.sha256(proof_raw).hexdigest(),
        "operator_authorization_path": operator_path,
        "operator_authorization_sha256": hashlib.sha256(operator_raw).hexdigest(),
        "application_started": False,
        "compute_started": False,
    }
    if not publish:
        return result
    control.prepare()
    with control.operation("container-recovery-preparation", {
        "source_root": pins["source_root"],
        "development_attempt": pins["development_attempt"],
        "request_id": pins["request_id"],
        "proof_sha256": result["proof_sha256"],
        "operator_authorization_sha256": result["operator_authorization_sha256"],
    }) as operation:
        # Both Docker and raw native documents can change while admission is
        # acquired. Rebuild every observation under the group lease.
        fresh = recovery.prepare_abrupt_stop_proof(
            control, pins, compose, retained_terminal_runs=retained_terminal_runs,
            retained_held_manual_runs=retained_held_manual_runs,
            **({"retained_attempt_histories": retained_attempt_histories} if retained_attempt_histories is not None else {}),
        )
        if recovery._canonical(fresh) != proof_raw:
            raise BuildControlError("Abrupt-stop evidence changed before publication")
        recovery.validate_abrupt_stop_proof(fresh, authorization, control=control, compose=compose)
        # Evidence is durable before the operator capability becomes visible.
        _publish_once(control, proof_path, proof_raw)
        _publish_once(control, operator_path, operator_raw)
        result.update(state="prepared-awaiting-explicit-start", operation_attempt=operation["receipt"]["attempt"])
        _publish_once(control, operation["root"] + "/result.json", canonical(result))
        operation["receipt"].update(state="succeeded", preparation=result)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", required=True, type=Path)
    parser.add_argument("--source-root", required=True, type=Path)
    parser.add_argument("--operator-pins", required=True, type=Path)
    parser.add_argument("--retained-terminal-runs", type=Path)
    parser.add_argument("--retained-held-manual-runs", type=Path)
    parser.add_argument("--retained-attempt-histories", type=Path)
    parser.add_argument("--publish", action="store_true", help="Publish evidence and operator capability under the group lease; never start services")
    args = parser.parse_args(argv)
    terminal_pins, held_pins = _read_retained_run_inputs(
        args.retained_terminal_runs, args.retained_held_manual_runs
    )
    history_pins = None
    if args.retained_attempt_histories is not None:
        if held_pins is None:
            raise BuildControlError("--retained-attempt-histories requires both retained-run arrays")
        from docker_volume_dev import _session_host
        raw = _session_host().read_owned_regular(args.retained_attempt_histories.absolute(), MAX_INPUT_BYTES)
        history_pins = json.loads(raw, object_pairs_hook=_unique_object)
        if not isinstance(history_pins, list):
            raise BuildControlError("Retained attempt histories input must be an array")
    source = select_checkout(args.repo_root.resolve(strict=True), args.source_root).resolve(strict=True)
    layout = storage.resolve_layout(source)
    identity = compose_project_identity(layout)
    configured = toolchain_configuration(source, identity)
    control = BuildControl(identity, configured["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"])
    pins = _read_input(args.operator_pins)
    if pins.get("source_root") != str(source) or pins.get("compose_project") != control.project:
        raise BuildControlError("Operator pins do not select the registered source/group")
    attempt = pins.get("development_attempt")
    if not isinstance(attempt, str) or recovery.ATTEMPT_RE.fullmatch(attempt) is None:
        raise BuildControlError("Recovery preparation requires an exact development attempt")
    compose = control.read("development/attempts/" + attempt + "/compose.json")
    if hashlib.sha256(recovery._canonical(compose)).hexdigest() != pins.get("compose_config_sha256"):
        raise BuildControlError("Retained Compose bytes differ from the operator pin")
    print(json.dumps(prepare(control, pins, compose, retained_terminal_runs=terminal_pins,
                             retained_held_manual_runs=held_pins, retained_attempt_histories=history_pins, publish=args.publish), indent=2))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (BuildControlError, ValueError, OSError) as error:
        print("container recovery preparation refused: " + str(error), file=sys.stderr)
        sys.exit(1)
