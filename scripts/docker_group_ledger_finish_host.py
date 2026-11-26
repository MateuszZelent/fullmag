"""Finish one approved ledger migration, then reuse the canonical healthy restart."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import shlex

import docker_group_ledger_bootstrap_host as common
import docker_group_ledger_bootstrap as bootstrap
import docker_group_ledger_promote_host as promoted
import docker_group_ledger_relocation as relocation
import docker_volume_dev as development

PHASE = "group-ledger-finish"
SCHEMA = "fullmag.group-ledger-finish.v1"


def record(control, path, digest):
    return promoted.semantic_record(control, path, digest)


def completed_archive(control, args, promotion, original, stopped, state):
    values = [getattr(args, name, "") for name in ("completed_finish", "completed_finish_sha256",
        "failed_development", "failed_development_sha256")]
    if not any(values):
        return None
    token, digest, failed_token, failed_digest = values
    common.require(re.fullmatch(r"[0-9a-f]{32}", token) and bootstrap.sha(digest)
        and re.fullmatch(r"[0-9a-f]{32}", failed_token) and bootstrap.sha(failed_digest),
        "Completed finish continuation requires all exact evidence pins")
    root = PHASE + "/attempts/" + token
    done = record(control, root + "/terminal.json", digest)
    expected_ids = {"backend": promotion["promotion_backend_container"], "frontend": stopped["frontend"]["Id"]}
    common.require(done.get("schema") == "fullmag.docker-build-operation.v1" and done.get("phase") == PHASE
        and done.get("state") == "succeeded" and done.get("compose_project") == control.project
        and done.get("control_volume") == control.volume and done.get("removed_containers") == expected_ids
        and done.get("retained_state_root") == str(state)
        and done.get("runtime_started") is False and done.get("solve_started") is False
        and done.get("inputs") == {"source_root": str(args.source_root), "promotion_attempt": args.promotion_attempt,
            "promotion_sha256": args.promotion_sha256, "image_id": args.image_id},
        "Completed finish authority differs")
    failed_root = "development/attempts/" + failed_token
    failed = record(control, failed_root + "/terminal.json", failed_digest)
    common.require(control.read("development/current.json") == failed
        and failed.get("schema") == "fullmag.docker-build-operation.v1" and failed.get("phase") == "development"
        and failed.get("state") == "failed-confirmed" and failed.get("attempt") == failed_token
        and failed.get("compose_project") == control.project and failed.get("control_volume") == control.volume
        and failed.get("state_root") == str(state) and failed.get("started_at", 0) >= done["finished_at"]
        and failed.get("inputs", {}).get("source_root") == str(args.source_root)
        and failed["inputs"].get("image_id") == args.image_id
        and failed["inputs"].get("previous_config_sha256") == original["records"]["config"]["sha256"]
        and not any(key in failed for key in ("backend_container", "frontend_container", "config_sha256",
            "backend_volumes", "ledger_profile", "container_recovery", "activation")),
        "Continuation requires the exact failed preallocation start")
    for name in ("compose.json", "backend-cache.json", "private-group-storage.json", "group-ledger.json",
                 "runtime-config.json", "storage-host-certificate.json"):
        common.require(control.read_bytes(failed_root + "/" + name, optional=True) is None,
            "Failed start already published state; preallocation continuation refused")
    identifiers = set(common.docker_capture("ps", "--all", "--no-trunc", "--quiet").stdout.decode().split())
    common.require(not identifiers.intersection(expected_ids.values()), "Completed finish service still exists")
    archives = {key: common.normalize_container(control.read(root + "/" + key + "-container.json"))
        for key in ("backend", "frontend")}
    common.require(all(archives[key].get("Id") == expected_ids[key] for key in archives), "Removed service archive differs")
    return {"pins": dict(zip(("completed_finish", "completed_finish_sha256", "failed_development",
        "failed_development_sha256"), values)), "archives": archives}


def authority(control, args, selected, layout):
    common.require(re.fullmatch(r"[0-9a-f]{32}", args.promotion_attempt), "Exact promotion attempt is required")
    root = "group-ledger-promote/attempts/" + args.promotion_attempt
    terminal = record(control, root + "/terminal.json", args.promotion_sha256)
    common.require(terminal.get("schema") == "fullmag.docker-build-operation.v1"
        and terminal.get("phase") == "group-ledger-promote" and terminal.get("state") == "succeeded"
        and terminal.get("compose_project") == control.project and terminal.get("control_volume") == control.volume
        and terminal.get("image_id") == args.image_id and terminal.get("promotion_exit_code") == 0
        and terminal.get("inputs", {}).get("source_root") == str(selected)
        and terminal.get("package_promoted") is True and terminal.get("runtime_started") is False
        and terminal.get("solve_started") is False, "Promotion has no successful same-group terminal authority")
    raw = control.read_bytes(root + "/request.json")
    request = bootstrap.strict_json(raw)
    common.require(raw == common.canonical(request) and bootstrap.digest(raw) == terminal["request_sha256"],
                   "Promotion request CAS differs")
    result = record(control, root + "/result.json", terminal["result_sha256"])
    common.require(result.get("state") == "promoted" and result.get("package_promoted") is True
        and result.get("runtime_started") is False and result.get("solve_started") is False
        and result.get("request_sha256") == bootstrap.digest(raw)
        and all(result.get(key) == terminal.get(key) for key in
                ("package_receipt_sha256", "cli_sha256", "provenance_sha256")), "Promotion result differs")
    boot_path = request["bootstrap_request"]["path"].removeprefix("/opt/fullmag/control/")
    boot_raw = control.read_bytes(boot_path)
    original = bootstrap.validate_request(bootstrap.strict_json(boot_raw))
    common.require(boot_raw == bootstrap.canonical(original) + b"\n"
        and bootstrap.digest(boot_raw) == request["bootstrap_request"]["sha256"]
        and original["source_root"] == str(selected) and original["compose_project"] == control.project
        and original["control_volume"] == control.volume, "Bootstrap request changed")
    boot_root = str(Path(boot_path).parent)
    boot = record(control, boot_root + "/terminal.json", terminal["bootstrap_sha256"])
    common.require(boot.get("state") == "succeeded" and boot.get("source") == original["source_commit"]
        and boot.get("inputs", {}).get("source_root") == str(selected)
        and boot.get("image_id") == args.image_id and boot.get("request_sha256") == bootstrap.digest(boot_raw),
        "Bootstrap lineage changed")
    relocation_receipt = record(control, terminal["relocation_receipt"], terminal["relocation_receipt_sha256"])
    relocation.validate_request(control, relocation_receipt["request"])
    common.require(relocation_receipt.get("state") == "verified"
        and relocation_receipt["request"]["bootstrap"]["terminal_path"] == boot_root + "/terminal.json"
        and relocation_receipt["request"]["bootstrap"]["terminal_sha256"] == terminal["bootstrap_sha256"],
        "Relocation lineage differs")
    ledger_request = relocation_receipt["request"]
    engine = common.docker_capture("info", "--format", "{{.ID}}").stdout.decode().strip()
    common.require(bootstrap.digest(engine.encode()) == ledger_request["daemon_id_sha256"], "Migration Docker daemon changed")
    for name, expected in ((ledger_request["source_volume"], ledger_request["source_volume_sha256"]),
                           (control.volume, ledger_request["target_volume_sha256"])):
        volumes = bootstrap.strict_json(common.docker_capture("volume", "inspect", name).stdout)
        common.require(isinstance(volumes, list) and len(volumes) == 1
            and volumes[0].get("Name") == name and volumes[0].get("Driver") == "local"
            and volumes[0].get("Options") in (None, {})
            and bootstrap.digest(common.canonical(volumes[0])) == expected, "Migration volume backing changed")
    pointer = relocation.read_relocation_pointer(control)
    common.require(pointer == {"schema": relocation.SCHEMA, "receipt_path": terminal["relocation_receipt"],
        "receipt_sha256": terminal["relocation_receipt_sha256"]}, "Current relocation pointer changed")
    old_root = "development/attempts/" + original["development_attempt"]
    previous = control.read(old_root + "/terminal.json")
    old_document = control.read(old_root + "/compose.json")
    common.require(previous.get("state") == "succeeded" and previous.get("compose_project") == control.project
        and previous.get("inputs", {}).get("source_root") == str(selected)
        and bootstrap.digest(common.canonical(old_document)) == original["config_sha256"],
        "Original healthy development authority differs")
    state = development.storage.validate_path(Path(previous["state_root"]), layout["runtime_root"], "retained session storage")
    certificate = development._retained_certificate(state, old_document)
    stopped_raw = control.read_bytes(original["records"]["containers"]["path"].removeprefix("/opt/fullmag/control/"))
    common.require(bootstrap.digest(stopped_raw) == original["records"]["containers"]["sha256"], "Original stopped services changed")
    stopped = bootstrap.strict_json(stopped_raw)
    common.require(previous.get("backend_container") == stopped["backend"]["Id"]
        and previous.get("frontend_container") == stopped["frontend"]["Id"]
        and previous["inputs"].get("image_id") == stopped["backend"]["Image"], "Original service receipt differs")
    document = control.read(root + "/compose.json")
    common.require(bootstrap.digest(common.canonical(document)) == terminal["config_sha256"], "Promotion Compose CAS differs")
    completed = completed_archive(control, args, terminal, original, stopped, state)
    backend = completed["archives"]["backend"] if completed else common.container(terminal["promotion_backend_container"])
    frontend = completed["archives"]["frontend"] if completed else common.container(stopped["frontend"]["Id"])
    common.require(backend.get("Image") == args.image_id
        and backend["State"].get("StartedAt") == terminal["promotion_started_at"], "Promotion backend incarnation differs")
    common.assert_stopped({"backend": backend, "frontend": frontend}, {"backend": backend, "frontend": stopped["frontend"]})
    common.validate_source_labels(backend, control.identity)
    common.validate_source_labels(frontend, control.identity)
    common._validate_retained_service(document, backend, "backend", common.image(args.image_id)["Config"])
    common._validate_retained_service(old_document, frontend, "frontend", common.image(frontend["Image"])["Config"], allow_legacy_frontend=True)
    common._assert_private_restart_network({"backend": backend, "frontend": frontend},
        {"backend": backend["Id"], "frontend": frontend["Id"]}, control.project)
    operator = development._operator_probe_record_from_retained(previous, old_document)
    reuse = {"state": state, "host_certificate": development._certificate_path(state),
        "owner_marker": state / development._session_host().OWNER_NAME,
        "receipt": {"image_id": previous["inputs"]["image_id"]}, "operator_probe_environment_record": operator}
    common.require(certificate.get("image_id") == reuse["receipt"]["image_id"], "Retained certificate image changed")
    from docker_volume_cancelled_activation_guard import assert_start_allowed
    assert_start_allowed(control, reuse_state=reuse)
    return {"terminal": terminal, "request": request, "bootstrap": boot, "original": original,
        "relocation": relocation_receipt, "document": document, "old_document": old_document,
        "backend": backend, "frontend": frontend, "reuse": reuse, "completed_finish": completed,
        "device_access": development._retained_device_access(previous, old_document),
        "gpu_access": previous["inputs"]["gpu_access_requested"],
        "include_untracked": development.include_untracked_from_compose(control.read(boot_root + "/compose.json"))}


def no_extra_services(control, context, allowed=()):
    expected = (set() if context.get("completed_finish") else
        {context[key]["Id"] for key in ("backend", "frontend")}) | set(allowed)
    identifiers = set()
    for label in ("com.docker.compose.project", "org.fullmag.compose.project"):
        identifiers.update(common.docker_capture("ps", "--all", "--no-trunc", "--quiet", "--filter",
            "label=" + label + "=" + control.project).stdout.decode().split())
    common.require(identifiers == expected, "Group contains an unknown service/helper; finish refused")
    relocation.assert_no_consumers(context["relocation"]["request"], relocation._live_consumers(), allowed)


def native_preflight(control, context):
    original, terminal = context["original"], context["terminal"]
    pins = {role: original["records"][role] for role in ("process", "owner", "config")}
    code = r"""import dataclasses,hashlib,json,sys
from pathlib import Path
sys.path.insert(0,'/opt/fullmag')
import backend_dev as backend
import runtime_service as runtime
p=json.loads(sys.argv[1]);t=json.loads(sys.argv[2]);b=json.loads(sys.argv[3])
def alias(pin):return Path('/control')/Path(pin['path']).relative_to('/opt/fullmag/control')
paths=runtime.canonical_paths({})
process=alias(p['process']);owner=alias(p['owner']);config=alias(p['config'])
state_root=process
for _ in runtime.PROCESS_RECEIPT_RELATIVE.parts:state_root=state_root.parent
paths=dataclasses.replace(paths,state_root=state_root,runtime_services=owner.parent,config=config)
with runtime._authenticated_terminal_drain(paths) as unchanged:
 for pin in p.values():
  raw=backend._read_json(alias(pin),'retained native record',8*1024**2)[1]
  if hashlib.sha256(raw).hexdigest()!=pin['sha256']:raise SystemExit('native record changed')
 evidence=runtime._read_authenticated_terminal_drain(paths)
 unchanged()
 receipt,raw,_=backend._validated_package(backend.PACKAGE_ROOT,'promoted package',exclude_development_control=True)
 if hashlib.sha256(raw).hexdigest()!=t['package_receipt_sha256']:raise SystemExit('published package changed')
 if backend._sha256_file(backend.PACKAGE_ROOT/'bin/fullmag-bin','published CLI',512*1024**2,package_artifact=True)[0]!=t['cli_sha256']:raise SystemExit('published CLI changed')
 if receipt['source']['resolved_commit']!=b['source'] or receipt['native_source_identity']['source_snapshot_sha256']!=b['source_snapshot_sha256']:raise SystemExit('published source changed')
 provenance=backend._read_json(Path('/control/backend/runtime-provenance.json'),'published provenance',8*1024**2)[1]
 if hashlib.sha256(provenance).hexdigest()!=t['provenance_sha256']:raise SystemExit('published provenance changed')
 unchanged()
 print(json.dumps({'state':'drained','config_sha256':p['config']['sha256'],'package_receipt_sha256':t['package_receipt_sha256'],'provenance_sha256':t['provenance_sha256']},sort_keys=True))
"""
    command = shlex.join(["python3", "-B", "-c", code, json.dumps(pins), json.dumps(terminal), json.dumps(context["bootstrap"])])
    result = relocation.bounded_capture(relocation._helper(control, context["relocation"]["request"], command, target=True), data=b"", timeout=120)
    common.require(result.returncode == 0, "Healthy Drained/package native preflight failed: " + result.stderr.decode("utf-8", "replace"))
    drain = bootstrap.strict_json(result.stdout)
    common.require(drain.get("state") == "drained" and drain.get("config_sha256") == pins["config"]["sha256"], "Native drain evidence differs")
    exact = common.canonical(context["relocation"]["request"]["expected_inspection"])
    # The original transfer retained these exact bytes next to its receipt.
    receipt_root = str(Path(terminal["relocation_receipt"]).parent)
    inspection_path = receipt_root + "/source-inspection.json"
    common.require(control.read_bytes(inspection_path) == exact, "Retained native inspection CAS changed")
    preview = relocation.bounded_capture(relocation._helper(control, context["relocation"]["request"],
        relocation._native_script(context["relocation"]["request"], "ledger-relocation-preview",
            "--expected-inspection", control.path(inspection_path), "--expected-inspection-sha256", bootstrap.digest(exact), published=True), target=True), data=b"", timeout=120)
    common.require(preview.returncode == 0, "Native migrated ledger preflight refused preserved history")
    checked = bootstrap.strict_json(preview.stdout)
    common.require(checked.get("status") == "verified" and checked.get("inspection") == context["relocation"]["request"]["expected_inspection"], "Native migrated ledger preview differs")
    return {"drain": drain, "ledger": checked}


def start_arguments(args, context):
    from docker_dev import _parser
    environment = context["old_document"]["services"]["frontend"]["ports"]
    ports = {int(row["published"]) for row in environment if str(row.get("target")) == "8080" and row.get("host_ip") == "127.0.0.1"}
    common.require(len(ports) == 1, "Original frontend loopback port is ambiguous")
    parsed = _parser().parse_args(["--repo-root", str(args.repo_root), "up", "--source-root", str(args.source_root),
        "--port", str(ports.pop()), "--gpu-access", context["gpu_access"]])
    parsed.port_explicit = True
    parsed.include_untracked = context["include_untracked"]
    common.require(parsed.script is None, "Migration finish cannot activate a script")
    return parsed


def run(args):
    common.require_host()
    selected, layout = common._select_source(Path(args.repo_root).resolve(strict=True), args.source_root)
    control = common.BuildControl(common._compose_identity(layout), args.image_id)
    context = authority(control, args, selected, layout)
    no_extra_services(control, context)
    proof = native_preflight(control, context)
    parsed = start_arguments(args, context)
    preview = {"schema": SCHEMA, "promotion_attempt": args.promotion_attempt, "promotion_sha256": args.promotion_sha256,
        "containers": {key: context[key]["Id"] for key in ("backend", "frontend")},
        "state_root": str(context["reuse"]["state"]), "port": parsed.port, "native_preflight": proof,
        "solve_started": False, "apply": bool(args.apply),
        "completed_finish": context.get("completed_finish", {}).get("pins") if context.get("completed_finish") else None}
    if not args.apply:
        return preview
    control.prepare()
    with control.operation(PHASE, {"source_root": str(selected), "promotion_attempt": args.promotion_attempt,
            "promotion_sha256": args.promotion_sha256, "image_id": args.image_id,
            **(context["completed_finish"]["pins"] if context.get("completed_finish") else {})}) as operation:
        current = authority(control, args, selected, layout)
        common.require(current == context, "Migration finish authority changed under lease")
        no_extra_services(control, current, (operation["helper_container_id"],))
        common.require(native_preflight(control, current) == proof, "Native finish preflight changed under lease")
        if not current.get("completed_finish"):
            for key in ("backend", "frontend"):
                control.write(operation["root"] + "/" + key + "-container.json", current[key])
                logs = common.docker_capture("logs", current[key]["Id"])
                control.write_bytes(operation["root"] + "/" + key + ".log", logs.stdout + logs.stderr)
        # Re-read all mutable service identities immediately before controlled removal.
        common.require(authority(control, args, selected, layout) == current, "Service or history changed before finish cleanup")
        no_extra_services(control, current, (operation["helper_container_id"],))
        if not current.get("completed_finish"):
            operation["daemon_pending"] = True
            common.docker_capture("rm", *(current[key]["Id"] for key in ("backend", "frontend")))
            operation["daemon_pending"] = False
        operation["receipt"].update(state="succeeded", removed_containers={} if context.get("completed_finish") else preview["containers"],
            completed_finish=context["completed_finish"]["pins"] if context.get("completed_finish") else None,
            retained_state_root=preview["state_root"], runtime_started=False, solve_started=False,
            native_preflight=proof)
    # Existing admission owns the new development lease, certificate rotation,
    # current native profile validation and API startup. No recovery is minted.
    return development.start(parsed, reuse_state=context["reuse"],
        previous_config_sha256=context["original"]["records"]["config"]["sha256"],
        retained_device_access=context["device_access"])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--promotion-attempt", required=True)
    parser.add_argument("--promotion-sha256", required=True)
    parser.add_argument("--image-id", required=True)
    for name in ("completed-finish", "completed-finish-sha256", "failed-development", "failed-development-sha256"):
        parser.add_argument("--" + name, default="")
    parser.add_argument("--apply", action="store_true")
    print(json.dumps(run(parser.parse_args(argv)), sort_keys=True, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
