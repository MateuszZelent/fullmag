"""Managed bootstrap of one unpromoted migration package in the group's backend."""
from __future__ import annotations

import argparse
from copy import deepcopy
import json
import os
from pathlib import Path
import re
import time

from docker_build_control import (BuildControl, BuildControlError, canonical, compose_capture,
                                 docker_capture, mirror_console)
from docker_dev import _compose_identity, _select_source
from docker_dev_host import require_host
from docker_volume_dev import (_assert_private_restart_network, _validate_retained_service as _validate_service,
                               include_untracked_from_compose, stop_idle)
from docker_compose_identity import validate_source_labels
import docker_backend_volume_cache as cache_adapter
import docker_group_ledger_bootstrap as guest

PHASE = "group-ledger-bootstrap"
REQUIRED_UNTRACKED = (
    "crates/fullmag-session/src/host_resource_ledger/relocation.rs",
    "crates/fullmag-cli/src/ledger_relocation.rs",
    "scripts/docker_group_ledger_bootstrap.py",
    "scripts/test_docker_group_ledger_bootstrap.py",
    "scripts/docker_group_ledger_bootstrap_host.py",
    "scripts/test_docker_group_ledger_bootstrap_host.py",
    "scripts/docker_group_ledger_promote.py",
    "scripts/test_docker_group_ledger_promote.py",
    "scripts/docker_group_ledger_relocation.py",
    "scripts/docker_group_ledger_relocation_copy.py",
    "scripts/test_docker_group_ledger_relocation.py",
    "scripts/test_docker_group_ledger_relocation_copy.py",
    "scripts/docker_group_ledger_relocation_host.py",
    "scripts/test_docker_group_ledger_relocation_host.py",
    "scripts/docker_group_ledger_promote_host.py",
    "scripts/test_docker_group_ledger_promote_host.py",
)

# Runs only as a metadata helper after the authenticated predecessor drain.
# No application build, service startup, ledger initialization or data copying.
PREPARE_REQUEST = r"""
import argparse,hashlib,json,os,pathlib,sys
sys.path.insert(0,'/opt/fullmag/source/scripts')
sys.path.insert(0,'/opt/fullmag')
import backend_dev as backend
import runtime_service as runtime
import docker_group_ledger_bootstrap as guest
P=pathlib.Path
seed=guest.strict_json(guest.regular(P(sys.argv[1])))
paths=runtime.canonical_paths()
root=P('/opt/fullmag/control')
with guest.runtime_guards(runtime,paths), backend._runtime_build_lock(P('/build')):
 guest.no_native_processes()
 records={}
 native={'process':runtime.process_receipt_path(paths),'owner':runtime.runtime_services_root(paths)/'OWNER.json','config':paths.config}
 for role,path in {**seed['stop_records'],**native}.items():
  path=P(path)
  alias=root/'runtime-control'/path.relative_to(guest.RUNTIME_CONTROL) if path.is_relative_to(guest.RUNTIME_CONTROL) else path
  raw=guest.regular(path)
  info,other=path.stat(),alias.stat()
  guest.require((info.st_dev,info.st_ino)==(other.st_dev,other.st_ino),'Metadata alias inode differs')
  records[role]={'path':str(alias),'sha256':guest.digest(raw)}
 current=backend._validated_package(backend.PACKAGE_ROOT,'bootstrap predecessor',exclude_development_control=True)
 args=argparse.Namespace(source_root=guest.SOURCE,git_common_root=P(os.environ.get('FULLMAG_SOURCE_GIT_COMMON','/opt/fullmag/source-git')),source_tar=None)
 manifest=backend._capture_start_manifest(args,P('/build'))
 source,_=backend._read_json(manifest,'bootstrap source',64*1024**2)
 request={**seed['pins'],'records':records,'source_commit':source['resolved_commit'],
  'source_manifest_sha256':source['source_manifest_sha256'],'source_snapshot_sha256':source['source_snapshot_sha256'],
  'bootstrap_script_sha256':guest.digest(guest.regular(P('/opt/fullmag/source/scripts/docker_group_ledger_bootstrap.py'))),
  'current_package':{'receipt_sha256':guest.digest(current[1]),'inventory_sha256':guest.digest(guest.canonical(current[0]['artifacts'])),
   'cli_sha256':backend._sha256_file(backend.PACKAGE_ROOT/'bin/fullmag-bin','predecessor CLI',512*1024**2,package_artifact=True)[0]},
  'ledger_inventory_sha256':guest.digest(guest.canonical(guest.ledger_inventory()))}
 guest.validate_request(request)
 guest.read_records(request)
 guest.check_native_aliases(request,runtime,paths)
 target=P(seed['request_path'])
 guest.require(not target.exists(),'Bootstrap request already exists')
 backend._write_json(target,request,'ledger bootstrap request')
 print(json.dumps({'request_sha256':guest.digest(backend._canonical(request)),'source_commit':request['source_commit']},sort_keys=True))
"""


def require(condition, message):
    if not condition:
        raise BuildControlError(message)


def one(kind, target):
    rows = json.loads(docker_capture(kind, "inspect", target).stdout)
    require(isinstance(rows, list) and len(rows) == 1, "Ambiguous Docker identity")
    return rows[0]


def normalize_container(document):
    result = deepcopy(document)
    mounts = result.get("Mounts", [])
    require(isinstance(mounts, list) and all(isinstance(row, dict) and
        isinstance(row.get("Destination"), str) and row["Destination"] for row in mounts),
        "Invalid Docker mount inventory")
    destinations = [row["Destination"] for row in mounts]
    require(len(destinations) == len(set(destinations)), "Duplicate Docker mount destination")
    if "Mounts" in result:
        result["Mounts"] = sorted(mounts, key=lambda row: row["Destination"])
    return result


def repin_daemon_binds(document,actual):
    from docker_dev_browser_qa import (_source_mount_matches_selected,
        DESKTOP_WSL_BIND_ALIAS_RE,LOCAL_WSL_BIND_MOUNT_ROOT)
    import stat
    result=deepcopy(document)
    mounts=normalize_container(actual).get('Mounts',[])
    if len(mounts)>64:
        raise ValueError('Unexpected mount inventory size')
    authored={mount['target']:mount for mount in result['services']['backend']['volumes'] if mount['type']=='bind'}
    observed={mount['Destination']:mount for mount in mounts if mount['Type']=='bind'}
    if set(authored)!=set(observed):
        raise ValueError('Bind destination inventory differs')
    proof={}
    for target,mount in authored.items():
        source=Path(mount['source']);value=observed[target]['Source']
        if not source.is_absolute() or len(str(source))>4096 or not isinstance(value,str) or len(value)>4096:
            raise ValueError('Invalid bind source')
        match=DESKTOP_WSL_BIND_ALIAS_RE.fullmatch(value)
        local=LOCAL_WSL_BIND_MOUNT_ROOT.joinpath(*match.groups()) if match else Path(value)
        before=source.stat();alias=local.stat()
        kind=stat.S_IFMT(before.st_mode)
        if stat.S_ISDIR(before.st_mode):
            matches=_source_mount_matches_selected(value,source)
        elif target=='/run/fullmag/linux-native-host.json' and stat.S_ISREG(before.st_mode):
            matches=stat.S_ISREG(alias.st_mode) and local.samefile(source)
        else:
            raise ValueError('Unsupported authored bind type')
        after=source.stat();alias_after=local.stat()
        identity=lambda info:(info.st_dev,info.st_ino,stat.S_IFMT(info.st_mode))
        if not matches or identity(before)!=identity(alias) or identity(after)!=identity(before) or identity(alias_after)!=identity(before):
            raise ValueError('Bind source inode differs: '+target)
        proof[target]={'authored_source':str(source),'daemon_source':value,'local_alias':str(local),
            'device':before.st_dev,'inode':before.st_ino,'type':kind}
    # Match canonical managed start: pin daemon spellings only after host identity proof.
    result['services']['backend']['x-fullmag-daemon-binds']={target:mount['Source'] for target,mount in observed.items()}
    return result,proof


def _validate_retained_service(document, observed, service, image_config, **options):
    checked = document
    if service == "backend":
        checked, _ = repin_daemon_binds(document, observed)
    return _validate_service(checked, observed, service, image_config, **options)


def container(identifier):
    rows = json.loads(docker_capture("inspect", identifier).stdout)
    require(isinstance(rows, list) and len(rows) == 1 and rows[0].get("Id") == identifier,
            "Container incarnation differs")
    return normalize_container(rows[0])


def image(identifier):
    require(isinstance(identifier, str) and re.fullmatch(r"sha256:[0-9a-f]{64}", identifier),
            "An exact image ID is required")
    row = one("image", identifier)
    require(row.get("Id") == identifier, "Image identity differs")
    return row


def retained(control, args, selected):
    require(re.fullmatch(r"[0-9a-f]{32}", args.attempt) and guest.sha(args.config_sha256),
            "Retained attempt/config pins are invalid")
    root = "development/attempts/" + args.attempt
    previous, document = control.read(root + "/terminal.json"), control.read(root + "/compose.json")
    require(previous.get("state") == "succeeded" and previous.get("compose_project") == control.project
            and previous.get("inputs", {}).get("source_root") == str(selected)
            and document.get("name") == control.project
            and guest.digest(canonical(document)) == args.config_sha256,
            "Retained development identity or Compose CAS differs")
    actual = {}
    for service in ("backend", "frontend"):
        identifier = previous.get(service + "_container")
        require(guest.sha(identifier), "Missing exact predecessor container ID")
        observed = container(identifier)
        service_image = document["services"][service]["image"]
        require(observed.get("Image") == service_image, "Predecessor service image differs")
        config = image(service_image)["Config"]
        validate_source_labels(observed, control.identity)
        _validate_retained_service(document, observed, service, config, allow_legacy_frontend=True)
        actual[service] = observed
    cache = control.read(root + "/backend-cache.json")
    cache_adapter.validate_container(actual["backend"], cache)
    return previous, document, actual, cache


def verify_bootstrap_image(control, selected, identifier, backend):
    observed = image(identifier)
    receipt = control.read("image-backend/verified.json")
    require(receipt.get("state") == "succeeded" and receipt.get("compose_project") == control.project
            and receipt.get("image_id") == identifier, "Bootstrap image has no verified group receipt")
    inputs = receipt.get("inputs", {})
    base_receipt = control.read("image-dev/verified.json")
    require(base_receipt.get("state") == "succeeded" and base_receipt.get("compose_project") == control.project
            and base_receipt.get("image_id") == inputs.get("parent_image_id"), "Bootstrap image base receipt differs")
    base_inputs = base_receipt.get("inputs", {})
    require(isinstance(base_inputs.get("files"), list) and base_inputs["files"], "Bootstrap base source inventory is absent")
    for pin in base_inputs["files"]:
        path = Path(pin["path"])
        require(not path.is_absolute() and ".." not in path.parts
                and guest.digest(guest.regular(selected / path)) == pin["sha256"], "Bootstrap base helper source changed")
    base_image = image(base_receipt["image_id"])
    require(base_image.get("Config", {}).get("Labels", {}).get("org.fullmag.build.input-digest")
            == guest.digest(canonical(base_inputs)), "Bootstrap image base identity differs")
    require(isinstance(inputs.get("files"), list) and inputs["files"], "Bootstrap helper source inventory is absent")
    for pin in inputs["files"]:
        path = Path(pin["path"])
        require(not path.is_absolute() and ".." not in path.parts
                and guest.digest(guest.regular(selected / path)) == pin["sha256"], "Bootstrap image helper source changed")
    require(observed.get("Config", {}).get("Labels", {}).get("org.fullmag.build.input-digest")
            == guest.digest(canonical(inputs)), "Bootstrap image input identity differs")
    env = dict(item.split("=", 1) for item in observed["Config"].get("Env", []) if "=" in item)
    old_env = dict(item.split("=", 1) for item in backend["Config"].get("Env", []) if "=" in item)
    require(env.get("FULLMAG_TOOLCHAIN_IMAGE_ID") == old_env.get("FULLMAG_TOOLCHAIN_IMAGE_ID")
            and env.get("FULLMAG_TOOLCHAIN_IMAGE_ID"), "Bootstrap toolchain differs from retained cache")
    return observed


def mount_binding(document, backend):
    mapping = {}
    for mount in document["services"]["backend"]["volumes"]:
        if mount["type"] == "volume":
            alias = mount["source"]
            declaration = document["volumes"][alias]
            mapping[mount["target"]] = {"volume": declaration["name"],
                "subpath": mount.get("volume", {}).get("subpath", "")}
    require(set(("/build", "/host-ledger", "/opt/fullmag/control", "/opt/fullmag/package")) <= set(mapping),
            "Required retained storage mounts are absent")
    observed = {row["Destination"]: row for row in backend["Mounts"]}
    for target, binding in mapping.items():
        require(observed.get(target, {}).get("Name") == binding["volume"], "Retained volume mount differs")
    return mapping


def assert_stopped(actual, before):
    require(set(actual) == {"backend", "frontend"}, "Incomplete stopped service set")
    for service, row in actual.items():
        old = before[service]
        require(row.get("Id") == old["Id"] and row.get("Image") == old["Image"]
                and row.get("State", {}).get("StartedAt") == old["State"]["StartedAt"]
                and row["State"].get("Running") is False and row["State"].get("OOMKilled") is False
                and row["State"].get("ExitCode") == 0, "Service did not stop gracefully: " + service)


def no_cache_consumers(cache, operation_helper):
    profile = deepcopy(cache)
    documents = {name: one("volume", name) for name in set(profile["volume_names"].values())}
    profile["volume_documents"] = {role: documents[name] for role, name in profile["volume_names"].items()}
    identifiers = docker_capture("ps", "--quiet", "--no-trunc").stdout.decode().split()
    rows = [container(identifier) for identifier in identifiers if identifier != operation_helper]
    cache_adapter._assert_no_active_consumers(profile, rows)


def bootstrap_document(document, request_path, request_sha256, identifier, included):
    result = deepcopy(document)
    backend = result["services"]["backend"]
    backend["image"] = identifier
    backend.pop("build", None)
    backend["entrypoint"] = ["/usr/local/bin/python3", "-B", "/opt/fullmag/source/scripts/docker_group_ledger_bootstrap.py"]
    backend["command"] = ["--request", request_path, "--request-sha256", request_sha256]
    backend["healthcheck"] = {"disable": True}
    backend["restart"] = "no"
    backend["environment"]["FULLMAG_RUNTIME_IMAGE_ID"] = identifier
    backend["environment"]["FULLMAG_DEV_INCLUDE_UNTRACKED"] = json.dumps(included, separators=(",", ":"))
    return result


def diagnostic_document(document, identifier, seed_path, included):
    result = deepcopy(document)
    helper = result["services"]["backend"]
    for key in ("build", "ports", "expose", "networks", "depends_on", "container_name", "hostname", "gpus"):
        helper.pop(key, None)
    helper.update(image=identifier, entrypoint=["/usr/local/bin/python3", "-B"],
        command=["-c", PREPARE_REQUEST, seed_path], network_mode="none", restart="no",
        healthcheck={"disable": True}, cpus=0.5, mem_limit="1g", pids_limit=64)
    helper.pop("deploy", None)
    helper["environment"]["NVIDIA_VISIBLE_DEVICES"] = "void"
    helper["environment"]["FULLMAG_DEV_INCLUDE_UNTRACKED"] = json.dumps(included, separators=(",", ":"))
    for mount in helper["volumes"]:
        mount["read_only"] = mount["target"] not in {"/build", "/opt/fullmag/control", "/opt/fullmag/runtime-control"}
    result["services"] = {"build-control": helper}
    return result


def poll_build(control, operation, document, before, request, timeout=14400):
    raw = compose_capture(document, "ps", "--all", "--quiet", "backend").decode().strip()
    require(guest.sha(raw) and raw != before["backend"]["Id"], "Bootstrap backend was not recreated")
    identifier = raw
    last_log = operation["receipt"]["started_at"]
    deadline = time.monotonic() + timeout
    while True:
        observed = container(identifier)
        require(observed.get("Image") == document["services"]["backend"]["image"], "Bootstrap image changed")
        frontend = container(before["frontend"]["Id"])
        require(frontend["State"].get("Running") is False
                and frontend["State"].get("StartedAt") == before["frontend"]["State"]["StartedAt"],
                "Frontend changed during bootstrap")
        now = time.time()
        observed_log = docker_capture("logs", "--since", str(last_log), "--until", str(now), identifier)
        logs = observed_log.stdout + observed_log.stderr
        if logs:
            operation["logger"].stdin.write(logs)
            operation["logger"].stdin.flush()
            mirror_console(logs)
        last_log = now
        state = observed.get("State", {})
        if state.get("Running") is False:
            control.write(operation["root"] + "/bootstrap-container-terminal.json", observed)
            operation["receipt"].update(bootstrap_backend_container=identifier,
                bootstrap_exit_code=state.get("ExitCode"), bootstrap_oom_killed=state.get("OOMKilled"))
            operation["daemon_pending"] = False
            require(state.get("ExitCode") == 0 and state.get("OOMKilled") is False,
                    "Bootstrap backend failed; candidate and data retained")
            relative = request["result_path"].removeprefix("/opt/fullmag/control/")
            result_raw = control.read_bytes(relative)
            result = guest.strict_json(result_raw)
            require(result.get("schema") == guest.SCHEMA and result.get("state") == "candidate-ready"
                    and result.get("request_sha256") == guest.digest(canonical(request) + b"\n")
                    and result.get("package_promoted") is False and result.get("runtime_started") is False
                    and result.get("ledger_modified") is False, "Bootstrap terminal result differs")
            _validate_retained_service(document, observed, "backend", image(observed["Image"])["Config"])
            return observed, result, guest.digest(canonical(result))
        require(time.monotonic() < deadline, "Bootstrap observation timed out; daemon outcome retained")
        time.sleep(2)


def run(args):
    require_host()
    selected, layout = _select_source(Path(args.repo_root).resolve(strict=True), args.source_root)
    identity = _compose_identity(layout)
    control = BuildControl(identity, args.image_id)
    previous, document, before, cache = retained(control, args, selected)
    verify_bootstrap_image(control, selected, args.image_id, before["backend"])
    mounts = mount_binding(document, before["backend"])
    ledger = control.read("development/attempts/" + args.attempt + "/group-ledger.json")
    require(ledger.get("schema") == "fullmag.docker-group-ledger.v1"
            and ledger.get("compose_project") == control.project
            and ledger.get("volume_name") == mounts["/host-ledger"]["volume"]
            and guest.sha(ledger.get("host_id")), "Retained group ledger identity differs")
    source_group_ledger = {"volume_name": ledger["volume_name"], "host_id": ledger["host_id"]}
    included = sorted(set(include_untracked_from_compose(document)) | set(REQUIRED_UNTRACKED))
    for name in included:
        require((selected / name).is_file() and not (selected / name).is_symlink(), "Missing included source: " + name)
    require(all(row["State"].get("Running") is True for row in before.values())
            and before["backend"]["State"].get("Health", {}).get("Status") == "healthy",
            "Bootstrap requires the healthy current group before its idle stop")
    _assert_private_restart_network(before, {key: row["Id"] for key, row in before.items()}, control.project)
    engine = docker_capture("info", "--format", "{{.ID}}").stdout.decode().strip()
    require(engine, "Docker engine identity is absent")
    preview = {"schema": "fullmag.group-ledger-bootstrap-preview.v1", "compose_project": control.project,
        "docker_engine_id": engine,
        "development_attempt": args.attempt, "config_sha256": args.config_sha256, "image_id": args.image_id,
        "containers": {key: {"id": row["Id"], "started_at": row["State"]["StartedAt"]} for key, row in before.items()},
        "mounts": mounts, "source_group_ledger": source_group_ledger, "include_untracked": included, "apply": bool(args.apply)}
    if not args.apply:
        return preview
    # The established stop owns its own lease and all native idle/admission checks.
    # Do not nest a new BuildControl operation around it.
    stop_idle(args)
    stopped = {service: container(row["Id"]) for service, row in before.items()}
    assert_stopped(stopped, before)
    stop = control.read("iteration/current.json")
    require(stop.get("state") == "succeeded" and stop.get("idle_backend_stopped") is True
            and stop.get("backend_container") == before["backend"]["Id"]
            and stop.get("inputs", {}).get("attempt") == args.attempt
            and stop.get("config_sha256") == args.config_sha256, "Managed stop handoff differs")
    control.prepare()
    with control.operation(PHASE, {"source_root": str(selected), "attempt": args.attempt,
            "config_sha256": args.config_sha256, "image_id": args.image_id,
            "stop_attempt": stop["attempt"], "controller_sha256": guest.digest(guest.regular(Path(__file__)))}) as operation:
        assert_stopped({key: container(row["Id"]) for key, row in before.items()}, before)
        require(docker_capture("info", "--format", "{{.ID}}").stdout.decode().strip() == engine,
                "Docker engine identity changed")
        verify_bootstrap_image(control, selected, args.image_id, before["backend"])
        no_cache_consumers(cache, operation["helper_container_id"])
        token = operation["receipt"]["attempt"]
        root = "group-ledger-bootstrap/attempts/" + token
        stop_root = "/opt/fullmag/control/iteration/attempts/" + stop["attempt"]
        seed = {"pins": {"schema": guest.SCHEMA, "request_id": token, "compose_project": control.project,
            "control_volume": control.volume, "source_root": str(selected),
            "old_backend_container_id": before["backend"]["Id"], "old_backend_started_at": before["backend"]["State"]["StartedAt"],
            "development_attempt": args.attempt, "config_sha256": args.config_sha256,
            "result_path": "/opt/fullmag/control/" + root + "/result.json"},
            "stop_records": {"stop_terminal": stop_root + "/terminal.json", "backend_drain": stop_root + "/backend-drain.json",
                             "containers": stop_root + "/idle-stop-containers.json"},
            "request_path": "/opt/fullmag/control/" + root + "/request.json"}
        control.write(root + "/preview.json", preview)
        control.write(root + "/seed.json", seed)
        diagnostic = diagnostic_document(document, args.image_id, "/opt/fullmag/control/" + root + "/seed.json", included)
        control.write(root + "/diagnostic-compose.json", diagnostic)
        operation["daemon_pending"] = True
        compose_capture(diagnostic, "run", "--rm", "--no-deps", "-T", "build-control", timeout=300)
        operation["daemon_pending"] = False
        request_raw = control.read_bytes(root + "/request.json")
        request = guest.validate_request(guest.strict_json(request_raw))
        require(request_raw == guest.canonical(request) + b"\n" and request["source_root"] == str(selected)
                and request["source_commit"] == __import__("fullmag_storage").git(selected, "rev-parse", "HEAD"),
                "Prepared request source differs")
        assert_stopped({key: container(row["Id"]) for key, row in before.items()}, before)
        no_cache_consumers(cache, operation["helper_container_id"])
        configured = bootstrap_document(document, seed["request_path"], guest.digest(request_raw), args.image_id, included)
        control.write(root + "/compose.json", configured)
        operation["daemon_pending"] = True
        compose_capture(configured, "up", "--detach", "--no-build", "--no-deps", "--force-recreate", "backend", timeout=120)
        observed, result, result_sha = poll_build(control, operation, configured, before, request)
        operation["daemon_pending"] = False
        control.write(root + "/bootstrap-container.json", observed)
        operation["receipt"].update(state="succeeded", bootstrap_backend_container=observed["Id"],
            bootstrap_started_at=observed["State"]["StartedAt"], bootstrap_exit_code=observed["State"]["ExitCode"],
            request_sha256=guest.digest(request_raw), result_sha256=result_sha, candidate=result["candidate"],
            candidate_cli_sha256=result["candidate_cli_sha256"], candidate_receipt_sha256=result["candidate_receipt_sha256"],
            source=request["source_commit"], source_snapshot_sha256=request["source_snapshot_sha256"],
            source_manifest_sha256=request["source_manifest_sha256"], image_id=args.image_id,
            bootstrap_finished_at=observed["State"]["FinishedAt"], docker_engine_id=engine, preserved_mounts=mounts,
            config_sha256=guest.digest(canonical(configured)), previous_config_sha256=args.config_sha256,
            native_program={"path": result["candidate"] + "/bin/fullmag-bin", "sha256": result["candidate_cli_sha256"],
                "package_mount": mounts["/opt/fullmag/package"], "candidate_receipt_sha256": result["candidate_receipt_sha256"]},
            stop_receipt=request["records"]["stop_terminal"], records=request["records"],
            source_group_ledger=source_group_ledger,
            package_promoted=False, runtime_started=False, ledger_modified=False)
        return operation["receipt"]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--source-root", required=True)
    parser.add_argument("--attempt", required=True)
    parser.add_argument("--config-sha256", required=True)
    parser.add_argument("--image-id", required=True)
    parser.add_argument("--port", type=int, default=3203)
    parser.add_argument("--allow-prepared-session", action="store_true")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
    args.script = None
    result = run(args)
    print(json.dumps(result, sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
