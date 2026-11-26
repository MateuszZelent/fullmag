"""Managed request factory and native-fenced relocation for one stopped DEV group."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re

from docker_build_control import BuildControl, canonical, docker_capture
from docker_dev import _compose_identity, _select_source
from docker_dev_host import require_host
import docker_group_ledger_relocation as relocation


def factory(control, attempt, terminal_sha256, image_id):
    relocation.require(re.fullmatch(r"[0-9a-f]{32}", attempt) and relocation._HEX.fullmatch(terminal_sha256),
                       "Exact bootstrap attempt and terminal SHA are required")
    root = "group-ledger-bootstrap/attempts/" + attempt
    terminal = control.read(root + "/terminal.json")
    result = control.read(root + "/result.json")
    relocation.require(relocation.sha(canonical(terminal)) == terminal_sha256
        and terminal.get("state") == "succeeded" and terminal.get("image_id") == image_id,
        "Bootstrap terminal pin or image differs")
    pin = terminal["native_program"]
    source = terminal["source_group_ledger"]
    engine = docker_capture("info", "--format", "{{.ID}}").stdout.decode().strip()
    relocation.require(engine and engine == terminal.get("docker_engine_id"), "Bootstrap Docker daemon changed")
    volumes = {}
    for name in (source["volume_name"], control.volume):
        rows = json.loads(docker_capture("volume", "inspect", name).stdout)
        relocation.require(len(rows) == 1 and rows[0].get("Name") == name, "Ambiguous relocation volume")
        volumes[name] = relocation.sha(canonical(rows[0]))
    request = {"schema": relocation.SCHEMA, "compose_project": control.project,
        "control_volume": control.volume, "source_root": control.identity["source_root"],
        "source_commit": terminal["source"], "daemon_id_sha256": relocation.sha(engine.encode()),
        "host_id": source["host_id"], "source_volume": source["volume_name"],
        "target_subpath": "private/ledger", "logical_root": relocation.LOGICAL_ROOT,
        "native_program": {"image_id": image_id, "package_volume": pin["package_mount"]["volume"],
            "package_subpath": pin["package_mount"]["subpath"], "candidate": result["candidate"],
            "receipt_sha256": pin["candidate_receipt_sha256"], "cli_sha256": pin["sha256"]},
        "bootstrap": {"terminal_path": root + "/terminal.json", "terminal_sha256": terminal_sha256,
            "result_path": root + "/result.json", "result_sha256": relocation.sha(canonical(result)),
            "container_id": terminal["bootstrap_backend_container"], "started_at": terminal["bootstrap_started_at"]},
        "copy_script_sha256": relocation.sha(Path(relocation.__file__).with_name("docker_group_ledger_relocation_copy.py").read_bytes()),
        "expected_inspection": None, "source_volume_sha256": volumes[source["volume_name"]],
        "target_volume_sha256": volumes[control.volume]}
    relocation.validate_request(control, request, allow_uninspected=True)
    relocation._revalidate_bootstrap(control, request)
    return request


def run(args):
    require_host()
    selected, layout = _select_source(Path(args.repo_root).resolve(strict=True), args.source_root)
    control = BuildControl(_compose_identity(layout), args.image_id)
    control.prepare()
    inputs = {"source_root": str(selected), "bootstrap_attempt": args.bootstrap_attempt,
              "bootstrap_sha256": args.bootstrap_sha256, "image_id": args.image_id}
    if args.mode == "inspect":
        relocation.require(not args.request and not args.request_sha256, "Source inspection does not accept an existing request")
        with control.operation("group-ledger-relocation-inspect", inputs) as operation:
            request = factory(control, args.bootstrap_attempt, args.bootstrap_sha256, args.image_id)
            return relocation.inspect_source(control, operation, request)
    relocation.require(isinstance(args.request, str) and re.fullmatch(
        r"group-ledger-relocation-inspect/attempts/[0-9a-f]{32}/request\.json", args.request)
        and re.fullmatch(r"[0-9a-f]{64}", args.request_sha256 or ""), "Transfer requires the pinned native inspection request")
    raw = control.read_bytes(args.request)
    relocation.require(relocation.sha(raw) == args.request_sha256, "Native inspection request CAS differs")
    request = json.loads(raw)
    relocation.require(request["bootstrap"]["terminal_path"] == "group-ledger-bootstrap/attempts/" + args.bootstrap_attempt + "/terminal.json"
        and request["bootstrap"]["terminal_sha256"] == args.bootstrap_sha256
        and request["native_program"]["image_id"] == args.image_id, "Transfer bootstrap pins differ")
    # Re-derive every non-inspection pin from current authoritative receipts.
    fresh = factory(control, args.bootstrap_attempt, args.bootstrap_sha256, args.image_id)
    relocation.require({**request, "expected_inspection": None} == fresh, "Relocation request no longer matches bootstrap authority")
    with control.operation("group-ledger-relocation", {**inputs, "request": args.request,
            "request_sha256": args.request_sha256}) as operation:
        return relocation.transfer(control, operation, request)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--source-root", required=True)
    parser.add_argument("--bootstrap-attempt", required=True)
    parser.add_argument("--bootstrap-sha256", required=True)
    parser.add_argument("--image-id", required=True)
    parser.add_argument("--mode", choices=("inspect", "transfer"), default="inspect")
    parser.add_argument("--request", default="")
    parser.add_argument("--request-sha256", default="")
    args = parser.parse_args(argv)
    print(json.dumps(run(args), sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
