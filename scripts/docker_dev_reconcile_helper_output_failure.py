"""Reconcile exact pre-admission helper-output failures while preserving runs.

Preview is read-only. Apply requires the preview digest, an empty live workspace,
a terminal/released SessionStore, and proof that the failed request has no
RunIntent. Only the original control helper releases its own activation lease.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import shlex
import sys
import time

from docker_build_control import BuildControlError, canonical, docker_capture
from docker_control_namespace import _raw
from docker_dev_release_unknown_activation import validate_drained, validate_stopped_backend
from docker_dev_up import _selected_context
from docker_volume_activate import _linked_runtime_terminals, _validate_running_group
from docker_volume_activation_reconcile import _validate_activation_receipt, _validate_helper, _validate_helper_logged
from docker_volume_offline_reconcile import _inventory_store, _read_store_file


FAILURE = (
    "Python helper log inspection failed: 500 Internal Server Error: "
    "Python helper output exceeded the 1048576 byte combined log limit"
)
# Pinned to the historical SceneStudyState deny_unknown_fields schema at
# 1c5c6c0a09faf499040b720bb2f6f5b962ee8ea0, which emitted the retained API
# error before compute_resources was supported. A schema or serde diagnostic
# change must fail closed until requalified.
SCENE_STUDY_STATE_FIELDS = (
    "backend", "requested_backend", "requested_device", "requested_precision", "requested_mode",
    "requested_cpu_threads", "parallel_execution", "pbc", "fem_demag_solver_policy",
    "fem_demag_accuracy_contract", "exchange_enabled", "demag_enabled", "demag_realization",
    "fdm", "external_field", "thermal_noise", "rotated_interfacial_dmi",
    "rotated_interfacial_dmi_object_ids", "solver", "universe_mesh", "shared_domain_mesh",
    "fem_domain_mesh", "mesh_defaults", "mesh_interfaces", "stages", "study_pipeline",
    "table_autosave", "output_storage", "execution_profile", "execution_layers", "initial_state",
    "visualization_hint",
)
SCENE_DESERIALIZATION_FAILURE = (
    "failed to deserialize SceneDocument response: unknown field `compute_resources`, expected one of "
    + ", ".join(f"`{field}`" for field in SCENE_STUDY_STATE_FIELDS)
    + " at line 1 column 12321"
)
LEGACY_FAILURE_VARIANT = "combined-helper-output-limit"
SCHEMA = "fullmag.docker-pre-admission-output-reconciliation.v1"


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def failure_variant(response: object) -> str:
    """Classify only the original overflow or the exact SceneStudyState error."""
    if not isinstance(response, dict) or response.get("code") != "internal_error":
        raise BuildControlError("Not a known pre-admission helper-output failure")
    message = response.get("message")
    if message == FAILURE:
        # Preserve the original, exact combined-output-limit predicate.
        return "combined-helper-output-limit"
    if message == SCENE_DESERIALIZATION_FAILURE and response.get("error") == SCENE_DESERIALIZATION_FAILURE:
        # docker_startup::activate_current_live_startup loads and deserializes
        # SceneDocument before publishing the temporary live owner or accepting
        # a RunIntent. Require both serialized error fields to match exactly.
        return "scene-study-compute-resources-unknown-field"
    raise BuildControlError("Not an exact pre-admission helper-output failure")


def failure_response(error: object) -> dict:
    match = re.search(r"startup activation returned HTTP 500: (\{[^\n]+\})\Z", error) if isinstance(error, str) else None
    response = json.loads(match[1]) if match else None
    failure_variant(response)
    return response


def validate_terminal_proof_variant(proof: object, variant: str) -> None:
    """Keep old overflow proofs readable; require new proofs to name the variant."""
    if not isinstance(proof, dict):
        raise BuildControlError("Terminal history proof is malformed")
    # Proofs written before the SceneDocument variant existed have no tag.
    # Only the original combined-output-limit route may resume those proofs.
    recorded = proof.get("failure_variant", LEGACY_FAILURE_VARIANT)
    if recorded != variant:
        raise BuildControlError("Terminal proof failure variant differs")


def request_absent(store: Path, runs: list[dict], request_id: str, source_sha256: str) -> None:
    """Inspect every retained RunIntent; any matching request identity refuses release."""
    key = "live-http-" + sha(request_id.encode())
    session_id = "docker-startup-" + sha((request_id + "\0" + source_sha256).encode())
    for run in runs:
        raw, _ = _read_store_file(store, "runs/" + run["run_id"] + "/run_intent.json")
        intent = json.loads(raw)
        if not isinstance(intent, dict) or intent.get("schema_version") != "run_intent.v1" or intent.get("run_id") != run["run_id"]:
            raise BuildControlError("RunIntent identity/schema is not proven")
        specification = intent.get("specification")
        if not isinstance(specification, dict) or not isinstance(specification.get("parameters"), dict):
            raise BuildControlError("RunIntent parameters are malformed")
        workspace = specification["parameters"].get("live_workspace")
        if workspace is not None and not isinstance(workspace, dict):
            raise BuildControlError("RunIntent workspace identity is malformed")
        workspace = workspace or {}
        command = workspace.get("command") or {}
        if not isinstance(command, dict):
            raise BuildControlError("RunIntent command identity is malformed")
        identities = (
            intent.get("idempotency_key") == key,
            workspace.get("session_id") == session_id,
            workspace.get("command_id") == request_id,
            workspace.get("request_idempotency_key") == request_id,
            command.get("request_id") == request_id,
        )
        if any(identities):
            raise BuildControlError("Failed startup request already has a retained RunIntent")


def protected_runs_digest(store: Path) -> str:
    """Protect all historical run payloads by path/stat identity across drain."""
    rows = []
    for path in sorted((store / "runs").rglob("*")):
        info = path.lstat()
        if path.is_symlink():
            raise BuildControlError("Linked historical run entry")
        rows.append((path.relative_to(store).as_posix(), info.st_mode, info.st_size, info.st_mtime_ns))
    return sha(canonical(rows))


def retained_plan(intent: object, bindings: dict, started_at: str) -> tuple[dict, str]:
    if not isinstance(intent, dict) or intent.get("schema") != SCHEMA:
        raise BuildControlError("Retained drain intent is malformed")
    plan = intent.get("plan")
    if not isinstance(plan, dict) or any(plan.get(k) != v for k, v in bindings.items()):
        raise BuildControlError("Retained drain intent pins differ")
    digest = sha(canonical(plan))
    if intent.get("plan_sha256") != digest or plan.get("backend_started_at") != started_at:
        raise BuildControlError("Retained drain plan or backend incarnation changed")
    if not re.fullmatch(r"[0-9a-f]{64}", str(plan.get("protected_runs_sha256", ""))):
        raise BuildControlError("Retained run preservation digest is invalid")
    return plan, digest


def publication_guards(control, files: tuple[tuple[str, str], ...]) -> list[str]:
    commands = []
    for relative, expected in files:
        path = shlex.quote(control.path(relative))
        # Each test must be a standalone command: `test ... && test ...`
        # exempts the first failure from Bash errexit and can skip the CAS.
        commands.extend([f"test ! -L {path}", f'test "$(sha256sum {path} | cut -d" " -f1)" = {shlex.quote(expected)}'])
    return commands


def reconcile(args) -> dict:
    _, selected, _, identity, control = _selected_context(args)
    if not re.fullmatch(r"[0-9a-f]{32}", args.activation):
        raise BuildControlError("Exact activation identity required")
    previous = control.read("development/current.json")
    if previous.get("state") != "succeeded":
        raise BuildControlError("Qualified development receipt required")
    document = control.read("development/attempts/" + previous["attempt"] + "/compose.json")
    image = previous["inputs"]["image_id"]
    backend = previous["backend_container"]
    receipt, raw, inputs = _validate_activation_receipt(
        control, activation_attempt=args.activation, development_attempt=previous["attempt"],
        config_sha256=previous["config_sha256"], source_root=str(selected), image_id=image, backend_id=backend,
    )
    if receipt.get("retirement_phase") != "startup":
        raise BuildControlError("Failure did not occur in startup phase")
    response = failure_response(receipt.get("error"))
    variant = failure_variant(response)
    root = "activation/attempts/" + args.activation
    marker_relative = inputs["activation_receipt_path"].removeprefix("/opt/fullmag/control/")
    marker_raw = _raw(control, marker_relative)
    marker = json.loads(marker_raw)
    if marker.get("state") != "started" or any(marker.get(k) != inputs[k] for k in ("request_id", "source_sha256", "provenance_sha256")):
        raise BuildControlError("Original startup marker does not match")
    bindings = {"schema": SCHEMA, "activation": args.activation, "backend": backend,
                "receipt_sha256": sha(raw), "marker_sha256": sha(marker_raw),
                "config_sha256": previous["config_sha256"], "source_root": str(selected),
                "request_id": inputs["request_id"], "source_sha256": inputs["source_sha256"], "response": response}
    active = _raw(control, "active", optional=True)
    completed = control.read(root + "/terminal.json", optional=True)
    if completed is not None:
        proof = control.read(root + "/terminal-history-output-proof.json")
        if (not isinstance(proof, dict)
                or completed.get("state") != "failed-confirmed" or completed.get("activation_state") != "not-admitted"
                or completed.get("reconciliation") != "pre-admission-output-terminal-history"
                or completed.get("inputs") != receipt.get("inputs")
                or completed.get("release_proof_sha256") != sha(canonical(proof))):
            raise BuildControlError("Existing terminal is not this authenticated reconciliation")
        validate_terminal_proof_variant(proof, variant)
        retained_plan(proof, bindings, proof["plan"]["backend_started_at"])
        if active is not None:
            raise BuildControlError("Terminal was published; original helper release still requires observation")
        return {"state": "not-admitted-confirmed", "activation": args.activation, "replayed": False, "already_completed": True}
    _, helper = _validate_helper(control, receipt["helper_container"], args.activation)
    _validate_helper_logged(helper)
    if active is None or active.decode().strip() != args.activation or control.read("activation/unresolved.json", optional=True):
        raise BuildControlError("Activation ownership/quarantine differs")
    store = Path(previous["state_root"]) / "runs/docker-all/session-store"
    row = json.loads(docker_capture("inspect", backend).stdout)[0]
    intent_path = root + "/terminal-history-output-intent.json"
    intent = control.read(intent_path, optional=True)
    if intent is not None:
        plan, digest = retained_plan(intent, bindings, row["State"]["StartedAt"])
    else:
        terminals = _linked_runtime_terminals(control, previous["attempt"], previous, source_root=str(selected), image=image, config_sha256=previous["config_sha256"])
        errors = []
        for terminal in terminals:
            try:
                observed, _ = _validate_running_group(control, identity, document, terminal, image, source_root=str(selected))
                if observed != backend:
                    raise BuildControlError("Backend changed")
                break
            except BuildControlError as error:
                errors.append(str(error))
        else:
            raise BuildControlError("No validated running group: " + "; ".join(errors))
        health_script = "import json,urllib.request; print(json.dumps(json.load(urllib.request.urlopen('http://127.0.0.1:8081/v2/platform/health',timeout=5))))"
        health = json.loads(docker_capture("exec", backend, "python3", "-c", health_script).stdout)
        if health.get("status") != "ok" or health.get("active_session") is not False:
            raise BuildControlError("Live workspace is not empty")
        inventory = _inventory_store(store)
        request_absent(store, inventory["runs"], inputs["request_id"], inputs["source_sha256"])
        plan = {**bindings, "backend_started_at": row["State"]["StartedAt"],
                "protected_runs_sha256": protected_runs_digest(store), "run_count": len(inventory["runs"])}
        digest = sha(canonical(plan))
    protected = plan["protected_runs_sha256"]
    if not args.apply:
        return {"state": "preview", "failure_variant": variant, "plan_sha256": digest, "plan": plan}
    if args.plan_sha256 != digest:
        raise BuildControlError("Exact unchanged preview plan SHA256 required")

    if intent is None:
        control.write(intent_path, {"schema": SCHEMA, "plan": plan, "plan_sha256": digest})
    retained_plan(control.read(intent_path), bindings, row["State"]["StartedAt"])
    # SIGTERM only: a slow drain is retained for observation, never force-killed.
    if row["State"].get("Running") is not False:
        # A durable intent may precede an interruption before SIGTERM. A new
        # session must never be stopped just because an old plan still exists.
        health_script = "import json,urllib.request; print(json.dumps(json.load(urllib.request.urlopen('http://127.0.0.1:8081/v2/platform/health',timeout=5))))"
        health = json.loads(docker_capture("exec", backend, "python3", "-c", health_script).stdout)
        if health.get("status") != "ok" or health.get("active_session") is not False:
            raise BuildControlError("Live workspace is no longer empty; backend was not stopped")
        current_inventory = _inventory_store(store)
        request_absent(store, current_inventory["runs"], inputs["request_id"], inputs["source_sha256"])
        if protected_runs_digest(store) != protected:
            raise BuildControlError("Historical runs changed before drain; backend was not stopped")
        docker_capture("kill", "--signal", "SIGTERM", backend, timeout=15)
    deadline = time.monotonic() + 55
    while True:
        row = json.loads(docker_capture("inspect", backend).stdout)[0]
        if row["State"].get("Running") is False:
            break
        if time.monotonic() >= deadline:
            raise BuildControlError("Backend drain remains in progress; activation lease retained")
        time.sleep(1)
    validate_stopped_backend(row, backend=backend, project=control.project, receipt=receipt)
    process_raw = _raw(control, "runtime-control/runtime-service/process-tree.json")
    from docker_dev_release_unknown_activation import docker_time
    validate_drained(json.loads(process_raw), started_at=docker_time(row["State"]["StartedAt"]))
    after = _inventory_store(store)
    request_absent(store, after["runs"], inputs["request_id"], inputs["source_sha256"])
    if protected_runs_digest(store) != protected:
        raise BuildControlError("Historical run data changed during drain; lease retained")
    if control.read("development/current.json") != previous:
        raise BuildControlError("Development identity changed during drain")
    _validate_helper(control, receipt["helper_container"], args.activation)
    proof = {"schema": SCHEMA, "plan": plan, "plan_sha256": digest, "failure_variant": variant,
             "process_tree_sha256": sha(process_raw), "preserved_store": after,
             "outcome": "not-admitted", "old_request_replay": "forbidden"}
    control.write(root + "/terminal-history-output-proof.json", proof)
    terminal = {**receipt, "state": "failed-confirmed", "activation_state": "not-admitted",
                "reconciliation": "pre-admission-output-terminal-history",
                "release_proof_sha256": sha(canonical(proof)), "finished_at": time.time()}
    encoded = base64.b64encode(canonical(terminal) + b"\n").decode()
    commands = ["set -euo pipefail", "umask 027"]
    commands.extend(publication_guards(control, (("active", sha(active)), (root + "/receipt.json", sha(raw)), (marker_relative, sha(marker_raw)))))
    for relative in ("activation/current.json", root + "/terminal.json"):
        path = shlex.quote(control.path(relative))
        commands.append(f'test ! -L {path}; t=$(mktemp {shlex.quote(control.path(root))}/.output-proof.XXXXXX); printf %s {shlex.quote(encoded)} | base64 -d > "$t"; sync "$t"; mv -T "$t" {path}')
    commands.extend(["sync /control", 'printf "RECONCILED\\n"'])
    result = docker_capture("exec", helper, "/bin/bash", "-c", "; ".join(commands))
    if result.stdout.strip() != b"RECONCILED":
        raise BuildControlError("Terminal publication not acknowledged; retain evidence")
    for _ in range(10):
        if _raw(control, "active", optional=True) is None:
            return {"state": "not-admitted-confirmed", "activation": args.activation,
                    "failure_variant": variant, "preserved_runs": len(after["runs"]), "replayed": False}
        time.sleep(1)
    raise BuildControlError("Original helper has not released its lease; retain evidence")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--activation", required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--plan-sha256")
    try:
        print(json.dumps(reconcile(parser.parse_args()), indent=2)); return 0
    except (BuildControlError, OSError, ValueError, KeyError) as error:
        print("reconcile-helper-output: " + str(error), file=sys.stderr); return 1


if __name__ == "__main__":
    raise SystemExit(main())
