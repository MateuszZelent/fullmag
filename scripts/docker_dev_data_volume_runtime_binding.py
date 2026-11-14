"""Qualify an existing group's current endpoint without moving or stopping data.

Default is read-only. Publication creates one immutable v1 binding and a
managed operational receipt. Neither grants admission, drain or copy authority.
"""
from __future__ import annotations

import argparse
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import re
import stat
from types import SimpleNamespace

from bootstrap_docker_toolchain import control_volume_name
from docker_build_control import BuildControl, docker_capture
from docker_compose_identity import compose_project_identity
from docker_development_inputs import select_checkout
from docker_dev_data_volume import _decode, _migration_bind_identity, _require_existing_control
from docker_volume_dev import _validate_retained_service
from docker_volume_reconcile import fingerprint
from fullmag_data_volume_guard import _open_directory_nofollow, verify_registered_volume
from fullmag_data_volume_pending import read_pending
import fullmag_data_volume_runtime_binding as model
import fullmag_storage as storage
import linux_native_host as native
from linux_data_volume_format import _exclusive
from linux_data_volume_provision import _read, require
from docker_data_volume_runtime_binding_evidence import qualify_witnesses


PHASES = {"stop": "iteration", "recreation": "recreate-services", "development": "development"}
COMPONENTS = ("docker_dev_data_volume_runtime_binding.py", "docker_data_volume_runtime_binding_evidence.py",
              "fullmag_data_volume_runtime_binding.py")
NATIVE_OBSERVATION = r'''from pathlib import Path
import hashlib,json,os,sys
sys.path.insert(0,'/opt/fullmag')
from linux_native_probe import validate_host
root=Path('/state');sha=lambda raw:hashlib.sha256(raw).hexdigest()
cert,raw,payload=validate_host(require_restart=True);metadata=root.stat()
print(json.dumps({'root_device':metadata.st_dev,'root_inode':metadata.st_ino,
 'mount_namespace_inode':Path('/proc/self/ns/mnt').stat().st_ino,
 'certificate_sha256':sha(raw),
 'runtime_certificate_sha256':sha(Path('/run/fullmag/linux-native-host.json').read_bytes()),
 'owner_marker_sha256':sha((root/'.fullmag-linux-native-owner.json').read_bytes()),
 'probe_sha256':sha((root/'.linux-native-probe.json').read_bytes()),
 'engine_digest':os.environ.get('FULLMAG_DOCKER_HOST_ID'),
 'image_id':os.environ.get('FULLMAG_RUNTIME_IMAGE_ID'),
 'sentinel_matches':(root/'.linux-native-sentinel').read_bytes()==payload,
 'restart_matches':(root/'.linux-native-restart').read_bytes()==payload}))
'''


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2, allow_nan=False) + "\n").encode()


def _source_pins(source):
    return {name: _sha((Path(source) / "scripts" / name).read_bytes()) for name in COMPONENTS}


def _references(value):
    require(type(value) is dict and set(value) == set(PHASES), "Exact three witness references required")
    for role, phase in PHASES.items():
        reference = value[role]
        require(type(reference) is dict and set(reference) == {"path", "sha256"} and
                model.sha_field(reference["sha256"]) and type(reference["path"]) is str and
                re.fullmatch(phase + r"/attempts/[0-9a-f]{32}/terminal\.json", reference["path"]),
                "Bounded witness reference required: " + role)
    return deepcopy(value)


def _documents(control, witnesses):
    paths = [reference["path"] for reference in witnesses.values()]
    paths += [witnesses["stop"]["path"].replace("terminal.json", "idle-stop-containers.json"),
              witnesses["recreation"]["path"].replace("terminal.json", "retained-containers.json"),
              witnesses["development"]["path"].replace("terminal.json", "compose.json")]
    result = {}
    for path in paths:
        raw = control.read_bytes(path)
        result[path] = {"sha256": _sha(raw), "value": _decode(raw)}
    return result


def _managed_state(control, owned_operation):
    active = control.read_bytes("active", optional=True)
    if owned_operation is None:
        require(active is None, "Another managed operation is active")
    else:
        require(control._active_operation is owned_operation and
                owned_operation.get("daemon_pending") is False and
                active == (owned_operation["receipt"]["attempt"] + "\n").encode(),
                "The exact live publication lease is required")


def _docker(*args):
    return _decode(docker_capture(*args).stdout)


def _live_services(source, identity, plan, qualified, development):
    pins = qualified["runtime_pins"]
    actual = _docker("inspect", pins["backend"], pins["frontend"])
    require(type(actual) is list and len(actual) == 2, "Exact current service pair required")
    images = _docker("image", "inspect", pins["image_id"])
    require(len(images) == 1 and images[0]["Id"] == pins["image_id"], "Current immutable image differs")
    services = {}
    backend = None
    for container in actual:
        labels = container.get("Config", {}).get("Labels") or {}
        role = labels.get("com.docker.compose.service")
        state = container.get("State", {})
        require(role in ("backend", "frontend") and role not in services and
                container.get("Id") == pins[role] and container.get("Image") == pins["image_id"] and
                labels.get("com.docker.compose.project") == identity["project_name"] and
                labels.get("org.fullmag.source.worktree-id") == identity["worktree_id"] and
                state.get("Running") is True and state.get("Status") == "running" and
                state.get("Health", {}).get("Status") == "healthy" and state.get("OOMKilled") is False and
                all(state.get(key) is False for key in ("Paused", "Restarting", "Dead")) and
                state.get("StartedAt") == development[role + "_started_at"],
                "Live service incarnation differs from its exact development")
        _validate_retained_service(qualified["compose"], container, role, images[0]["Config"])
        services[role] = {"id": container["Id"], "fingerprint": fingerprint(container),
                          "pid": state["Pid"], "started_at": state["StartedAt"],
                          "nano_cpus": container["HostConfig"]["NanoCpus"],
                          "memory_bytes": container["HostConfig"]["Memory"]}
        if role == "backend":
            backend = container
    require(set(services) == {"backend", "frontend"}, "Ambiguous current service pair")
    mounts = {mount["Destination"]: mount for mount in backend["Mounts"]}
    for target, path in (("/state", pins["state_root"]),
                         ("/user-data", plan["observation"]["datasets"]["user_data"]["canonical_root"]),
                         ("/opt/fullmag/source", str(source))):
        mount = mounts.get(target, {})
        require(mount.get("Type") == "bind" and mount.get("RW") is (target != "/opt/fullmag/source") and
                _migration_bind_identity(mount["Source"])[0] == Path(path),
                "Current physical bind differs: " + target)
    for pin in plan["observation"]["datasets"].values():
        descriptor = _open_directory_nofollow(Path(pin["canonical_root"]))
        try:
            metadata = os.fstat(descriptor)
            require((metadata.st_dev, metadata.st_ino) == (pin["device"], pin["inode"]),
                    "Original dataset physical identity changed")
        finally:
            os.close(descriptor)
    return services


def _admission(plan, pins):
    state = Path(pins["state_root"])
    cert_raw = native.read_owned_regular(state / native.CERTIFICATE_NAME)
    owner_raw = native.read_owned_regular(state / native.OWNER_NAME)
    probe_raw = native.read_owned_regular(state / ".linux-native-probe.json")
    certificate, probe = _decode(cert_raw), _decode(probe_raw)
    state_pin = plan["observation"]["datasets"]["state"]
    require(cert_raw == owner_raw and certificate.get("schema") == native.HOST_SCHEMA and
            certificate.get("storage_profile") == native.PROFILE and certificate.get("owner_scope") == "docker-linux" and
            certificate.get("role") == "session" and type(certificate.get("owner_token")) is str and
            re.fullmatch(r"[0-9a-f]{32}", certificate["owner_token"]) and
            type(certificate.get("engine_id")) is str and bool(certificate["engine_id"]) and
            certificate.get("restart_verified") is True and certificate.get("image_id") == pins["image_id"] and
            certificate.get("host_root") == str(state) and certificate.get("host_device") == state_pin["device"] and
            certificate.get("host_inode") == state_pin["inode"] and
            certificate.get("engine_id") == plan["observation"]["engine_id"],
            "Current native certificate/owner differs from the unchanged original scope")
    engine = docker_capture("info", "--format", "{{.ID}}").stdout.decode().strip()
    require(engine == certificate["engine_id"], "Current Docker engine changed")
    guest = _decode(docker_capture("exec", pins["backend"], "/usr/local/bin/python3", "-I", "-B", "-c",
                                  NATIVE_OBSERVATION).stdout)
    hashes = {"certificate_sha256": _sha(cert_raw), "owner_marker_sha256": _sha(owner_raw),
              "probe_sha256": _sha(probe_raw)}
    payload = (certificate["owner_token"] + ":" + certificate["image_id"]).encode()
    require(guest["certificate_sha256"] == guest["runtime_certificate_sha256"] == hashes["certificate_sha256"] and
            guest["owner_marker_sha256"] == hashes["owner_marker_sha256"] and
            guest["probe_sha256"] == hashes["probe_sha256"] and
            guest["engine_digest"] == _sha(engine.encode()) and guest["image_id"] == pins["image_id"] and
            guest["sentinel_matches"] is True and guest["restart_matches"] is True and
            certificate["restart_expected_sha256"] == _sha(payload),
            "Current backend admission/restart differs from host evidence")
    require(probe.get("schema") == "fullmag.linux-native-probe.v1" and
            probe.get("storage_profile") == native.PROFILE and probe.get("owner_token") == certificate["owner_token"] and
            probe.get("image_id") == pins["image_id"] and
            probe.get("host_attestation_sha256") == hashes["certificate_sha256"] and
            probe.get("root_inode") == guest["root_inode"] == certificate["host_inode"] and
            probe.get("root_device") == guest["root_device"] and
            probe.get("mount_namespace_inode") == guest["mount_namespace_inode"] and
            type(probe.get("checks")) is dict and set(probe["checks"]) == native.CHECKS and
            all(value is True for value in probe["checks"].values()),
            "Current native probe is not bound to this backend namespace")
    return {**hashes, "owner_token_sha256": _sha(certificate["owner_token"].encode()), "engine_id": engine}


def _collect(source, layout, control, *, volume_id, plan_sha256, witnesses, backend, image_id,
             owned_operation=None):
    require(Path(__file__).resolve() == source / "scripts" / Path(__file__).name and
            storage.resolve_layout(source, profile="docker-all-gpu") == layout,
            "Selected producer checkout/configuration changed")
    identity = compose_project_identity(layout)
    operation_root = Path(layout["storage_root"]) / "migrations/data-volumes" / volume_id
    raw, plan = _read(operation_root / "plan.json", plan_sha256)
    require(all(plan.get(key) == identity[field] for key, field in (
        ("project_id", "project_id"), ("worktree_id", "worktree_id"), ("compose_project", "project_name"))) and
        plan.get("source_root") == str(source) and plan.get("storage_root") == layout["storage_root"] and
        plan.get("runtime_root") == layout["runtime_root"] and plan.get("volume_id") == volume_id,
        "Original plan belongs to another selected scope")
    require(read_pending(layout, control.project) is None and
            verify_registered_volume(layout, control.project) is None and
            not any(os.path.lexists(operation_root / name) for name in ("linux-copy-started.json", "linux-bind-started.json")),
            "Migration or registration already started; reconcile without rebinding")
    _managed_state(control, owned_operation)
    records = _documents(control, witnesses)
    qualified = qualify_witnesses(plan, compose_project=control.project, control_volume=control.volume,
                                  source_root=str(source), witnesses=witnesses, records=records)
    pins = qualified["runtime_pins"]
    require(pins["backend"] == backend and pins["image_id"] == image_id,
            "Current witness differs from the pinned evidence reader")
    development = records[witnesses["development"]["path"]]["value"]
    body = {key: plan[key] for key in ("volume_id", "project_id", "worktree_id", "compose_project",
                                      "source_root", "storage_root", "runtime_root")}
    body.update(schema=model.SCHEMA, state="qualified-runtime-successor-only", plan_sha256=plan_sha256,
                previous_runtime_pins=model.runtime_pins(plan["runtime_pins"]), runtime_pins=pins,
                source_roots=deepcopy(plan["observation"]["datasets"]),
                services=_live_services(source, identity, plan, qualified, development),
                witnesses=deepcopy(witnesses), admission=_admission(plan, pins),
                runtime_source=qualified["runtime_source"], loader_sha256=_sha(Path(model.__file__).read_bytes()),
                relationship="diamond-by-common-stop", historical_owner_continuity="not-proven",
                namespace_admitted=False, data_migrated=False)
    body = model.validate_binding(body, plan, _sha(raw))
    _managed_state(control, owned_operation)
    return {"operation_root": operation_root, "binding": body}


def _publish_binding(parent, digest, raw):
    if not os.path.lexists(parent):
        parent.mkdir(mode=0o755)
    descriptor = _open_directory_nofollow(parent)
    try:
        metadata = os.fstat(descriptor)
        require(metadata.st_uid == os.geteuid() and not stat.S_IMODE(metadata.st_mode) & 0o022,
                "Runtime binding directory has a foreign writer")
        _exclusive(descriptor, digest + ".json", raw)
        after = parent.stat(follow_symlinks=False)
        require((after.st_dev, after.st_ino) == (metadata.st_dev, metadata.st_ino),
                "Runtime binding directory changed during publication")
    finally:
        os.close(descriptor)


def qualify_runtime_successor(source_root, *, volume_id, plan_sha256, witnesses, backend, image_id, publish=False):
    require(type(volume_id) is str and re.fullmatch(r"[0-9a-f]{32}", volume_id) and volume_id != "0" * 32 and
            model.sha_field(plan_sha256) and model.sha_field(backend) and type(image_id) is str and
            re.fullmatch(r"sha256:[0-9a-f]{64}", image_id) and type(publish) is bool,
            "Exact original plan, live backend/image and publication policy required")
    witnesses = _references(witnesses)
    source = select_checkout(Path(source_root), str(source_root))
    layout = storage.resolve_layout(source, profile="docker-all-gpu")
    identity = compose_project_identity(layout)
    # BuildControl resolves namespace metadata in its constructor. Prove the
    # selected volume/backend already exist before permitting that first read.
    _require_existing_control(SimpleNamespace(volume=control_volume_name(identity["project_name"])),
                              {"backend": backend, "image_id": image_id})
    control = BuildControl(identity, image_id)
    require(control.namespace == "", "Runtime binding requires the retained root control namespace")
    arguments = dict(volume_id=volume_id, plan_sha256=plan_sha256, witnesses=witnesses,
                     backend=backend, image_id=image_id)
    with storage.build_lock(layout):
        components = _source_pins(source)
        initial = _collect(source, layout, control, **arguments)
        body = initial["binding"]
        raw = _encoded(body)
        digest = _sha(raw)
        parent = initial["operation_root"] / "runtime-bindings"
        path = parent / (digest + ".json")
        result = {"state": "qualified-read-only", "binding_sha256": digest, "path": str(path),
                  "runtime_pins": body["runtime_pins"], "relationship": body["relationship"],
                  "historical_owner_continuity": "not-proven", "namespace_admitted": False,
                  "data_migrated": False, "UI_stopped": False}
        if not publish:
            return result
        require(not os.path.lexists(path), "Binding already exists; inspect it without replay or overwrite")
        inputs = {"source_root": str(source), "volume_id": volume_id, "plan_sha256": plan_sha256,
                  "binding_sha256": digest, "producer_components": components, "runtime_binding_only": True}
        with control.operation("data-volume-migration", inputs) as operation:
            require(_source_pins(source) == components and
                    _collect(source, layout, control, owned_operation=operation, **arguments) == initial,
                    "Runtime/admission changed before binding publication")
            _publish_binding(parent, digest, raw)
            require(_source_pins(source) == components and
                    _collect(source, layout, control, owned_operation=operation, **arguments) == initial,
                    "Runtime/admission changed after binding publication; retain all resources")
            control.write(operation["root"] + "/runtime-binding.json", {
                "binding_sha256": digest, "path": str(path), "plan_sha256": plan_sha256,
                "namespace_admitted": False, "data_migrated": False})
            operation["receipt"].update(state="succeeded", runtime_binding_sha256=digest,
                                        runtime_binding_only=True, namespace_admitted=False, data_migrated=False)
        return {**result, "state": "published-runtime-successor-only", "control_attempt": operation["receipt"]["attempt"]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", required=True)
    parser.add_argument("--volume-id", required=True)
    parser.add_argument("--plan-sha256", required=True)
    parser.add_argument("--witnesses-file", type=Path, required=True)
    parser.add_argument("--witnesses-sha256", required=True)
    parser.add_argument("--backend", required=True)
    parser.add_argument("--image-id", required=True)
    parser.add_argument("--publish", action="store_true")
    args = parser.parse_args(argv)
    _, witnesses = _read(args.witnesses_file, args.witnesses_sha256)
    print(json.dumps(qualify_runtime_successor(args.source_root, volume_id=args.volume_id,
        plan_sha256=args.plan_sha256, witnesses=witnesses, backend=args.backend,
        image_id=args.image_id, publish=args.publish), sort_keys=True))


if __name__ == "__main__":
    main()
