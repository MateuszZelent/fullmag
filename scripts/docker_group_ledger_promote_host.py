"""Preview/publish a relocated group's pinned package through its backend service."""
from __future__ import annotations

import argparse
from copy import deepcopy
import json
from pathlib import Path
import re
import time

import docker_group_ledger_bootstrap_host as common
import docker_group_ledger_bootstrap as bootstrap
import docker_group_ledger_promote as promotion
import docker_group_ledger_relocation as relocation

PHASE = "group-ledger-promote"


def semantic_record(control, relative, expected):
    common.require(isinstance(relative, str) and not Path(relative).is_absolute() and ".." not in Path(relative).parts,
                   "Evidence path escapes control volume")
    value = bootstrap.strict_json(control.read_bytes(relative))
    common.require(bootstrap.sha(expected) and bootstrap.digest(common.canonical(value)) == expected,
                   "Evidence semantic CAS differs")
    return value


def predecessor(control, args, selected):
    common.require(re.fullmatch(r"[0-9a-f]{32}", args.bootstrap_attempt), "Invalid bootstrap attempt")
    root = "group-ledger-bootstrap/attempts/" + args.bootstrap_attempt
    terminal = semantic_record(control, root + "/terminal.json", args.bootstrap_sha256)
    common.require(terminal.get("schema") == "fullmag.docker-build-operation.v1" and terminal.get("phase") == "group-ledger-bootstrap"
        and terminal.get("state") == "succeeded" and terminal.get("compose_project") == control.project
        and terminal.get("inputs", {}).get("source_root") == str(selected)
        and terminal.get("image_id") == args.image_id and terminal.get("bootstrap_exit_code") == 0,
        "Bootstrap terminal authority differs")
    result = semantic_record(control, root + "/result.json", terminal["result_sha256"])
    original_raw = control.read_bytes(root + "/request.json")
    original = bootstrap.validate_request(bootstrap.strict_json(original_raw))
    common.require(original_raw == bootstrap.canonical(original) + b"\n"
        and bootstrap.digest(original_raw) == terminal["request_sha256"], "Original bootstrap request CAS differs")
    document = control.read(root + "/compose.json")
    common.require(bootstrap.digest(common.canonical(document)) == terminal["config_sha256"], "Bootstrap Compose CAS differs")
    backend = common.container(terminal["bootstrap_backend_container"])
    common.require(backend["State"].get("Running") is False and backend["State"].get("ExitCode") == 0
        and backend["State"].get("OOMKilled") is False
        and backend["State"].get("StartedAt") == terminal["bootstrap_started_at"]
        and backend.get("Image") == args.image_id, "Bootstrap backend incarnation is not stopped successfully")
    common.validate_source_labels(backend, control.identity)
    common._validate_retained_service(document, backend, "backend", common.image(args.image_id)["Config"])
    old = bootstrap.strict_json(control.read_bytes(original["records"]["containers"]["path"].removeprefix("/opt/fullmag/control/")))
    frontend = common.container(old["frontend"]["Id"])
    common.require(frontend.get("Image") == old["frontend"]["Image"]
        and frontend["State"].get("StartedAt") == old["frontend"]["State"]["StartedAt"]
        and frontend["State"].get("Running") is False, "Frontend predecessor changed")
    return terminal, result, original, document, backend, frontend


def configured_document(document, request_path, request_sha256, control, target_subpath):
    result = deepcopy(document)
    backend = result["services"]["backend"]
    controls = [row for row in backend["volumes"] if row["target"] == "/opt/fullmag/control"]
    ledgers = [row for row in backend["volumes"] if row["target"] == "/host-ledger"]
    common.require(len(controls) == len(ledgers) == 1
        and result["volumes"][controls[0]["source"]]["name"] == control.volume
        and target_subpath == "private/ledger", "Target ledger mount binding differs")
    ledgers[0].update(type="volume", source=controls[0]["source"], read_only=True,
                     volume={"nocopy": True, "subpath": target_subpath})
    backend["entrypoint"] = ["/usr/local/bin/python3", "-B", "/opt/fullmag/source/scripts/docker_group_ledger_promote.py"]
    backend["command"] = ["--request", request_path, "--request-sha256", request_sha256]
    backend["restart"] = "no"
    backend["healthcheck"] = {"disable": True}
    return result


def wait(control, operation, document, predecessor_id, frontend, request, timeout=300):
    identifier = common.compose_capture(document, "ps", "--all", "--quiet", "backend").decode().strip()
    common.require(bootstrap.sha(identifier) and identifier != predecessor_id, "Promotion backend was not recreated")
    deadline = time.monotonic() + timeout
    while True:
        row = common.container(identifier)
        old_frontend = common.container(frontend["Id"])
        common.require(old_frontend["State"].get("Running") is False
            and old_frontend["State"].get("StartedAt") == frontend["State"]["StartedAt"], "Frontend changed during promotion")
        common.require(row.get("Image") == document["services"]["backend"]["image"], "Promotion image changed")
        if row["State"].get("Running") is False:
            operation["daemon_pending"] = False
            control.write(operation["root"] + "/promotion-container.json", row)
            common.require(row["State"].get("ExitCode") == 0 and row["State"].get("OOMKilled") is False,
                           "Promotion failed; package journal and backups retained")
            common._validate_retained_service(document, row, "backend", common.image(row["Image"])["Config"])
            result = bootstrap.strict_json(control.read_bytes(request["result_path"].removeprefix("/opt/fullmag/control/")))
            common.require(result.get("schema") == promotion.SCHEMA and result.get("state") == "promoted"
                and result.get("request_sha256") == bootstrap.digest(common.canonical(request))
                and result.get("package_promoted") is True and result.get("runtime_started") is False
                and result.get("solve_started") is False, "Promotion result differs")
            logs = common.docker_capture("logs", identifier)
            operation["logger"].stdin.write(logs.stdout + logs.stderr)
            operation["logger"].stdin.flush()
            return row, result
        common.require(time.monotonic() < deadline, "Promotion observation timed out; resources retained")
        time.sleep(1)


def run(args):
    common.require_host()
    selected, layout = common._select_source(Path(args.repo_root).resolve(strict=True), args.source_root)
    control = common.BuildControl(common._compose_identity(layout), args.image_id)
    terminal, result, original, document, backend, frontend = predecessor(control, args, selected)
    common.require(isinstance(args.relocation_receipt, str) and re.fullmatch(
        r"group-ledger-relocation/attempts/[0-9a-f]{32}/relocation\.json", args.relocation_receipt),
        "Relocation receipt is outside its operation")
    receipt = semantic_record(control, args.relocation_receipt, args.relocation_receipt_sha256)
    common.require(receipt.get("schema") == relocation.SCHEMA and receipt.get("state") == "verified",
                   "Ledger relocation is not verified")
    relocation.validate_request(control, receipt["request"])
    binding = receipt["request"]["bootstrap"]
    common.require(binding["terminal_path"] == "group-ledger-bootstrap/attempts/" + args.bootstrap_attempt + "/terminal.json"
        and binding["terminal_sha256"] == args.bootstrap_sha256
        and binding["container_id"] == backend["Id"] and binding["started_at"] == backend["State"]["StartedAt"]
        and result.get("candidate") == receipt["request"]["native_program"]["candidate"], "Relocation/bootstrap binding differs")
    common.verify_bootstrap_image(control, selected, args.image_id, backend)
    relocation.assert_no_consumers(receipt["request"], relocation._live_consumers())
    preview = {"schema": "fullmag.group-ledger-promote-preview.v1", "compose_project": control.project,
        "bootstrap_attempt": args.bootstrap_attempt, "bootstrap_sha256": args.bootstrap_sha256,
        "relocation_receipt": args.relocation_receipt, "relocation_receipt_sha256": args.relocation_receipt_sha256,
        "candidate": result["candidate"], "backend_container": backend["Id"], "image_id": args.image_id, "apply": bool(args.apply)}
    if not args.apply:
        return preview
    control.prepare()
    with control.operation(PHASE, {"source_root": str(selected), "bootstrap_attempt": args.bootstrap_attempt,
            "bootstrap_sha256": args.bootstrap_sha256, "relocation_receipt": args.relocation_receipt,
            "relocation_receipt_sha256": args.relocation_receipt_sha256, "image_id": args.image_id}) as operation:
        fresh = predecessor(control, args, selected)
        common.require(fresh == (terminal, result, original, document, backend, frontend), "Promotion predecessor changed under lease")
        relocation.assert_no_consumers(receipt["request"], relocation._live_consumers(), (operation["helper_container_id"],))
        common.verify_bootstrap_image(control, selected, args.image_id, backend)
        common.require(semantic_record(control, args.relocation_receipt, args.relocation_receipt_sha256) == receipt,
                       "Relocation changed under lease")
        root = "group-ledger-promote/attempts/" + operation["receipt"]["attempt"]
        request = promotion.validate_request({"schema": promotion.SCHEMA, "request_id": operation["receipt"]["attempt"],
            "compose_project": control.project, "control_volume": control.volume, "source_root": str(selected),
            "bootstrap_request": {"path": "/opt/fullmag/control/group-ledger-bootstrap/attempts/" + args.bootstrap_attempt + "/request.json",
                                  "sha256": terminal["request_sha256"]},
            "relocation_receipt": {"path": "/opt/fullmag/control/" + args.relocation_receipt, "sha256": args.relocation_receipt_sha256},
            "provenance_sha256": bootstrap.digest(control.read_bytes("backend/runtime-provenance.json")),
            "promote_script_sha256": bootstrap.digest(bootstrap.regular(selected / "scripts/docker_group_ledger_promote.py")),
            "result_path": "/opt/fullmag/control/" + root + "/result.json"})
        raw = common.canonical(request)
        control.write_bytes(root + "/request.json", raw)
        control.write(root + "/preview.json", preview)
        configured = configured_document(document, "/opt/fullmag/control/" + root + "/request.json", bootstrap.digest(raw),
                                         control, receipt["request"]["target_subpath"])
        control.write(root + "/compose.json", configured)
        operation["daemon_pending"] = True
        common.compose_capture(configured, "up", "--detach", "--no-build", "--no-deps", "--force-recreate", "backend", timeout=120)
        row, published = wait(control, operation, configured, backend["Id"], frontend, request)
        operation["receipt"].update(state="succeeded", promotion_backend_container=row["Id"],
            promotion_started_at=row["State"]["StartedAt"], promotion_exit_code=row["State"]["ExitCode"],
            image_id=args.image_id, request_sha256=bootstrap.digest(raw), result_sha256=bootstrap.digest(common.canonical(published)),
            config_sha256=bootstrap.digest(common.canonical(configured)), relocation_receipt=args.relocation_receipt,
            relocation_receipt_sha256=args.relocation_receipt_sha256, bootstrap_sha256=args.bootstrap_sha256,
            package_receipt_sha256=published["package_receipt_sha256"], cli_sha256=published["cli_sha256"],
            provenance_sha256=published["provenance_sha256"], rollback_package=published["rollback_package"],
            package_promoted=True, runtime_started=False, solve_started=False)
        return operation["receipt"]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--source-root", required=True)
    parser.add_argument("--bootstrap-attempt", required=True)
    parser.add_argument("--bootstrap-sha256", required=True)
    parser.add_argument("--image-id", required=True)
    parser.add_argument("--relocation-receipt", required=True)
    parser.add_argument("--relocation-receipt-sha256", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
    print(json.dumps(run(args), sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
