"""Build only the owned ring QA session's mesh through the typed v2 client.

Run inside the selected Compose group, with its fullmag Python package on
PYTHONPATH. The receipt must be in that group's Docker volume. No Solve.
Docker may accept a Study to prepare its domain;
the postcondition requires its Compute gate and all stages to remain pending.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
from pathlib import Path
from urllib.parse import urlencode

from fullmag.client import Client

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--session-id", required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
if args.output.exists():
    raise RuntimeError("A receipt already exists; inspect the accepted command instead of replaying it")
root = Path("/opt/fullmag/control/verification").resolve(strict=True)
args.output = args.output.resolve(strict=False)
if root not in args.output.parents or not args.output.parent.is_dir():
    raise RuntimeError("Receipt must be in an existing managed control verification directory")
record = {"schema": "fullmag.viewport-ring-mesh-qa.v1", "state": "preflight"}
receipt_owned = False


def save() -> None:
    global receipt_owned
    data = (json.dumps(record, indent=2) + "\n").encode()
    temporary = None
    if not receipt_owned:
        descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    else:
        descriptor, temporary = tempfile.mkstemp(dir=args.output.parent, prefix=".ring-mesh-")
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        if temporary is not None:
            os.replace(temporary, args.output)
        directory = os.open(args.output.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        receipt_owned = True
    finally:
        if temporary is not None and os.path.exists(temporary):
            os.unlink(temporary)


with Client("http://backend:8081", timeout=30, retry_budget_s=0) as client:
    before = client.sessions.status()
    identity_keys = ("session_id", "session_epoch", "request_scope_epoch")
    identity = {key: before["session"][key] for key in identity_keys}
    if identity["session_id"] != args.session_id:
        raise RuntimeError("Current session differs from the explicitly pinned QA session")
    client.session_scope = urlencode({"session": identity["session_id"],
        "epoch": identity["session_epoch"], "request_scope_epoch": identity["request_scope_epoch"]})
    scene = client.model.scene()
    if (scene.get("scene", {}).get("name") != "permalloy_layer_cofeb_rings_relax_300nm"
            or sorted(obj.get("name", "") for obj in scene["objects"])
            != ["cofeb_top_ring", "permalloy_layer"]):
        raise RuntimeError("Current model is not the expected two-object ring fixture")
    lane = before.get("capabilities", {}).get("active_lane", {})
    requested = lane.get("requested", {})
    resolved = lane.get("resolved", {})
    for field in ("backend", "device", "precision", "mode"):
        if (requested.get(field) != scene["study"].get("requested_" + field)
                or resolved.get(field) != requested.get(field)):
            raise RuntimeError("Session execution differs from authored strict intent; refuse mesh submission")
    if before["run"] is not None:
        raise RuntimeError("Mesh-only QA requires an authoring session without an accepted run")
    queue = client.commands.queue()
    if queue["commands"]:
        raise RuntimeError("Mesh-only QA requires an empty command journal")
    if before["domain"]["cell_count"] != 0:
        raise RuntimeError("Primitive-stage precondition failed: this session already has a mesh")
    record.update(session=identity, scene_revision=scene["revision"], before_domain=before["domain"],
        before_resources=before["resources"], client_intent_id="viewport-depth-mesh-" +
        hashlib.sha256((client.session_scope + ":" + str(scene["revision"])).encode()).hexdigest()[:24], state="submitting")
    save()
    try:
        # Admission compares journal length; queue.revision also advances on completion.
        handle = client.commands.submit("mesh_build", client_intent_id=record["client_intent_id"],
            reason="viewport_depth_qa", mesh_reason="shared-domain", mesh_target={"kind": "study_domain"},
            precondition={"scene_revision": scene["revision"], "command_revision": len(queue["commands"])})
        record.update(state="accepted", command_id=handle.command_id)
        save()
        terminal = handle.wait(timeout=600)
        record.update(state="terminal", terminal=terminal)
        save()
        after = client.sessions.status()
        after_identity = {key: after["session"][key] for key in identity_keys}
        if after_identity != identity or after["domain"]["cell_count"] <= 0:
            raise RuntimeError("Mesh completion did not publish a non-empty domain in the pinned session")
        if after["resources"].get("mesh_build_revision", 0) <= before["resources"].get("mesh_build_revision", 0):
            raise RuntimeError("Mesh command did not advance its owning resource revision")
        run = client.call_json("simulation_get_sessions_current_simulation_runs_current")
        stages = client.call_json("simulation_get_sessions_current_simulation_stages_execution")
        if (run["run_id"] != terminal.get("run_id")
                or run["status"] not in {"waiting_for_solve", "waiting_for_compute"}
                or after["run"]["run_id"] != run["run_id"] or after["run"]["solver_time"] != 0
                or any(run.get(prefix + field) != scene["study"]["requested_" + field]
                       for prefix in ("requested_", "resolved_")
                       for field in ("backend", "device", "precision", "mode"))
                or any(after.get("capabilities", {}).get("active_lane", {}).get(lane, {}).get(field)
                       != scene["study"]["requested_" + field]
                       for lane in ("requested", "resolved")
                       for field in ("backend", "device", "precision", "mode"))
                or stages["run_id"] != run["run_id"] or stages["completed_stage_indexes"] != []
                or not stages["stage_statuses"]
                or any(status != "pending" for status in stages["stage_statuses"])):
            raise RuntimeError("Mesh-only command released or executed the prepared Study")
        config = json.loads(Path(os.environ["FULLMAG_RUNTIME_SERVICE_CONFIG"]).read_text())
        run_root = Path(config["store_root"]) / "runs" / run["run_id"]
        intent = json.loads((run_root / "run_intent.json").read_text())
        policy = intent["specification"]["parameters"]["fullmag.accepted_run_start"]
        if (policy != {"schema_version": "accepted_run_start_policy.v1", "mode": "manual"}
                or (run_root / "start_release.json").exists()):
            raise RuntimeError("Mesh-only command did not retain an unreleased manual Compute gate")
        record.update(accepted_run=run, stage_execution=stages, compute_not_started=True,
                      compute_gate_policy=policy, compute_release_exists=False)
        record.update(state="passed", after_domain=after["domain"], after_resources=after["resources"],
            requested_execution=terminal.get("requested_execution"), resolved_execution=terminal.get("resolved_execution"))
        save()
        print(json.dumps({key: record[key] for key in ("state", "command_id", "after_domain")}))
    except BaseException as error:
        record.update(state="failed-or-outcome-unknown", error=str(error))
        save()
        raise
