"""Release one unknown activation proven to have failed before admission.

The API answered the startup POST with HTTP 500 from a step that precedes any
live state, RunIntent or catalog entry (a bounded helper deadline), so the
startup helper had to record an unknown outcome and keep the lease.  This
route authenticates that exact lease, proves that the backend has since
stopped gracefully with a drained process tree and an empty accepted-run
store, and lets the lease's own helper release it.  It never repeats the
request, never rewrites the activation marker and never touches session data;
a later ``recreate-volume --fresh-state`` starts the group again.
"""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shlex
import sys
import time

from docker_build_control import BuildControlError, canonical, docker_capture
from docker_control_namespace import _raw
from docker_dev_up import _selected_context
from docker_volume_activation_reconcile import (
    _validate_activation_receipt,
    _validate_helper,
    _validate_helper_logged,
)


ACCEPTED_STORE = "/state/runs/docker-all/session-store"
# Each entry is an API error raised only before the startup route publishes
# any state.  Anything else keeps the quarantine.
PRE_MUTATION_FAILURES = frozenset({
    ("internal_error", "Python helper exceeded the 30 second deadline"),
})
RESPONSE_RE = re.compile(r"startup activation returned HTTP 500: (\{[^\n]+\})\Z")


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def docker_time(value: object) -> float:
    """Parse Docker's RFC 3339 timestamp with nanoseconds to epoch seconds."""
    if not isinstance(value, str):
        raise BuildControlError("Container timestamp is missing")
    match = re.fullmatch(r"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?Z", value)
    if match is None:
        raise BuildControlError("Container timestamp is not UTC RFC 3339")
    base = datetime.strptime(match[1], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    return base.timestamp() + float("0." + (match[2] or "0"))


def pre_mutation_response(error: object) -> dict[str, object]:
    """Return the recorded API response only for an allowed pre-mutation 500."""
    match = RESPONSE_RE.search(error) if isinstance(error, str) else None
    if match is None:
        raise BuildControlError("Activation failure is not a recorded HTTP 500 response")
    response = json.loads(match[1])
    if (not isinstance(response, dict)
            or (response.get("code"), response.get("message")) not in PRE_MUTATION_FAILURES):
        raise BuildControlError("Recorded HTTP 500 is not a known pre-mutation failure")
    return response


def validate_stopped_backend(row: dict, *, backend: str, project: str, receipt: dict) -> None:
    labels = row.get("Config", {}).get("Labels", {})
    state = row.get("State", {})
    if (row.get("Id") != backend
            or labels.get("com.docker.compose.project") != project
            or labels.get("com.docker.compose.service") != "backend"):
        raise BuildControlError("Backend identity differs from the activation pin")
    if (state.get("Running") is not False or state.get("Restarting")
            or state.get("ExitCode") != 0 or state.get("OOMKilled") is not False):
        raise BuildControlError("Backend is not stopped gracefully")
    # The unknown outcome was recorded by this container run, which stopped
    # only afterward; a restarted backend could have admitted a later run.
    if docker_time(state.get("StartedAt")) > receipt["started_at"]:
        raise BuildControlError("Backend restarted after the activation began")
    if docker_time(state.get("FinishedAt")) < receipt["finished_at"]:
        raise BuildControlError("Backend stopped before the activation outcome was recorded")


def validate_drained(process: object, *, started_at: float) -> None:
    owner = process.get("service_owner") if isinstance(process, dict) else None
    if (not isinstance(process, dict) or process.get("state") != "drained"
            or process.get("accepted_store") != ACCEPTED_STORE
            or not isinstance(owner, dict)
            or docker_time(owner.get("acquired_at")) < started_at):
        raise BuildControlError("Native process tree of this backend run is not drained")


def accepted_runs_empty(state_root: object) -> None:
    runs = Path(str(state_root)) / "runs/docker-all/session-store/runs"
    if runs.is_symlink() or (runs.exists() and any(runs.iterdir())):
        raise BuildControlError("The accepted-run store is not empty; a run may have been admitted")


def release(args) -> dict[str, object]:
    _, _, _, identity, control = _selected_context(args)
    if not re.fullmatch("[0-9a-f]{32}", args.activation):
        raise BuildControlError("Exact activation identity required")
    previous = control.read("development/current.json")
    if previous.get("state") != "succeeded":
        raise BuildControlError("The retained development start is not qualified")
    backend = previous["backend_container"]
    receipt, raw, inputs = _validate_activation_receipt(
        control, activation_attempt=args.activation, development_attempt=previous["attempt"],
        config_sha256=previous["config_sha256"], source_root=identity["source_root"],
        image_id=previous["inputs"]["image_id"], backend_id=backend,
    )
    if receipt.get("retirement_phase") != "startup":
        raise BuildControlError("Activation did not reach its startup request")
    response = pre_mutation_response(receipt.get("error"))
    helper, helper_id = _validate_helper(control, receipt["helper_container"], args.activation)
    _validate_helper_logged(helper_id)
    active = _raw(control, "active")
    if (active.decode().strip() != args.activation
            or control.read("activation/unresolved.json", optional=True)):
        raise BuildControlError("Activation ownership or quarantine differs")
    marker_path = inputs["activation_receipt_path"]
    prefix = "/opt/fullmag/control/"
    if not marker_path.startswith(prefix):
        raise BuildControlError("Activation marker is outside control")
    marker_relative = marker_path[len(prefix):]
    marker_raw = _raw(control, marker_relative)
    marker = json.loads(marker_raw)
    if (marker.get("state") != "started" or marker.get("request_id") != inputs["request_id"]
            or marker.get("source_sha256") != inputs["source_sha256"]
            or marker.get("provenance_sha256") != inputs["provenance_sha256"]):
        raise BuildControlError("Activation marker does not match the unknown request")

    row = json.loads(docker_capture("inspect", backend).stdout)[0]
    validate_stopped_backend(row, backend=backend, project=control.project, receipt=receipt)
    process_raw = _raw(control, "runtime-control/runtime-service/process-tree.json")
    validate_drained(json.loads(process_raw), started_at=docker_time(row["State"]["StartedAt"]))
    accepted_runs_empty(previous["state_root"])

    root = "activation/attempts/" + args.activation
    proof = {
        "schema": "fullmag.docker-pre-mutation-activation-release.v1",
        "receipt_sha256": sha(raw), "marker_sha256": sha(marker_raw),
        "process_tree_sha256": sha(process_raw), "response": response,
        "backend": backend, "backend_state": {
            key: row["State"].get(key) for key in ("ExitCode", "StartedAt", "FinishedAt")
        },
        "accepted_runs": 0, "authorization": "release-requested-by-operator",
    }
    proof_raw = canonical(proof) + b"\n"
    control.write(root + "/pre-mutation-release-proof.json", proof)
    # Re-check right before publication: nothing may have restarted the backend.
    row = json.loads(docker_capture("inspect", backend).stdout)[0]
    validate_stopped_backend(row, backend=backend, project=control.project, receipt=receipt)
    _validate_helper(control, receipt["helper_container"], args.activation)
    terminal = {**receipt, "state": "failed-confirmed", "activation_state": "not-admitted",
                "reconciliation": "pre-mutation-startup-failure",
                "release_proof_sha256": sha(proof_raw), "finished_at": time.time()}
    data = canonical(terminal) + b"\n"
    script = "set -euo pipefail; umask 027; "
    for path, expected in [("active", sha(active)), (root + "/receipt.json", sha(raw)),
                           (marker_relative, sha(marker_raw))]:
        actual = shlex.quote(control.path(path))
        script += f'test ! -L {actual}; test "$(sha256sum {actual} | cut -d" " -f1)" = {shlex.quote(expected)}; '
    for path in ("activation/current.json", root + "/terminal.json"):
        destination = shlex.quote(control.path(path))
        # The original helper alone watches terminal.json and removes active.
        script += f"test ! -L {destination}; t=$(mktemp {shlex.quote(control.path(root))}/.release.XXXXXX); "
        script += f'printf %s {shlex.quote(base64.b64encode(data).decode())} | base64 -d > "$t"; sync "$t"; mv -T "$t" {destination}; '
    script += 'sync /control; printf "RELEASED\\n"'
    observed = docker_capture("exec", helper_id, "/bin/bash", "-c", script)
    if observed.stdout.strip() != b"RELEASED":
        raise BuildControlError("Release publication not acknowledged; inspect retained evidence")
    for _ in range(10):
        if _raw(control, "active", optional=True) is None:
            return {"state": "released", "activation": args.activation, "replayed": False,
                    "next": "recreate-volume --fresh-state"}
        time.sleep(1)
    raise BuildControlError("Original helper has not yet released its lease")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--activation", required=True)
    try:
        print(json.dumps(release(parser.parse_args())))
        return 0
    except (BuildControlError, OSError, ValueError, KeyError) as error:
        print("release-unknown-activation: " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
