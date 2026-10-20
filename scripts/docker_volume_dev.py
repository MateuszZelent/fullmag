"""Volume-only orchestration for the existing fixed DEV backend/frontend."""
from __future__ import annotations

import base64
from contextlib import nullcontext
import hashlib
import json
import os
from collections.abc import Mapping
from pathlib import Path, PurePosixPath
import re
import sys
import time

import fullmag_storage as storage
from docker_build_control import (BuildControl, BuildControlError, canonical, control_read_script, docker_capture,
                                  compose_capture, build_volume_toolchain, build_volume_runtime_images, bounded_capture,
                                  mirror_console)
from docker_dev_host import docker_argv, require_host, local_volume, validate_host_path


def _session_host():
    if os.name == "nt":
        import windows_folder_host as host
    else:
        import linux_native_host as host
    return host


def _certificate_path(state):
    return Path(state) / Path(_session_host().HOST_CERT_PATH).name


def _retained_certificate(state, document):
    host = _session_host()
    certificate = json.loads(host.read_owned_regular(_certificate_path(state)))
    if (certificate.get("schema") != host.HOST_SCHEMA
            or certificate.get("storage_profile") != document["services"]["backend"]["environment"]["FULLMAG_SESSION_STORAGE_PROFILE"]
            or certificate != json.loads(host.read_owned_regular(Path(state) / host.OWNER_NAME))):
        raise BuildControlError("Retained session storage profile/ownership differs")
    if os.name != "nt":
        if (certificate.get("host_inode") != Path(state).stat().st_ino
                or certificate.get("engine_id") != docker_text("info", "--format", "{{.ID}}").strip()
                or any(certificate.get(key) != value for key, value in local_volume(state).items())):
            raise BuildControlError("Retained Linux host directory/engine identity differs")
    return certificate



_PROCESS_RECEIPT_PROBE = """import json,pathlib,sys
sys.path.insert(0,'/opt/fullmag')
import runtime_service
try:
 raw=runtime_service._bounded_regular(runtime_service.process_receipt_path(runtime_service.canonical_paths()),'process receipt')
except FileNotFoundError:
 print(json.dumps({'state':'not-published'}))
else:
 print(raw.decode('utf-8'))
"""
BACKEND_PROCESS_RECEIPT_SCRIPT = _PROCESS_RECEIPT_PROBE

_NEW_WINDOWS_RUNTIME_STATE_DIRECTORIES = (
    Path("runs"),
    Path("runs/docker-all"),
    Path("runs/docker-all/session-store"),
    Path("runs/docker-all/session-store/runtime-services"),
)

_RECOVERY_ENVIRONMENT_NAME = re.compile(r"FULLMAG_CONTAINER_RECOVERY_[A-Z0-9_]+\Z")
_RECOVERY_ATTEMPT = re.compile(r"[0-9a-f]{32}\Z")
_MAX_RECOVERY_METADATA_BYTES = 256 * 1024
_MAX_CANCELLED_ACTIVATION_RECORD_BYTES = 8 * 1024 * 1024
_CANCELLED_ACTIVATION_SCHEMA = "fullmag.docker-activation-accepted-then-cancelled.v1"
_CANCELLED_ACTIVATION_ATTEMPT = re.compile(r"[0-9a-f]{32}\Z")
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_NATIVE_STOP_JOURNAL_SCHEMA = "fullmag.stop-failed-admission.v1"
_NATIVE_STOP_RECREATE_METADATA_SCHEMA = "fullmag.docker-native-failed-stop-recreate.v1"
_MAX_RUNTIME_CONFIG_BYTES = 256 * 1024
_ACCEPTED_REATTACH_ENVIRONMENT_KEYS = frozenset({
    "FULLMAG_ACCEPTED_REATTACH_REQUEST",
    "FULLMAG_ACCEPTED_REATTACH_REQUEST_SHA256",
})


def _validate_recovery_environment(values):
    """Validate recovery-only environment injected from the control volume.

    Recovery callers must construct this mapping from authenticated control
    volume data.  Restricting names to the recovery namespace prevents a
    caller from replacing the source, storage, GPU, or Compose identity that
    ``start`` derives from the selected checkout.
    """

    if values is None:
        return {}
    if not isinstance(values, Mapping):
        raise BuildControlError("Recovery environment must be a mapping")
    result = {}
    for name, value in values.items():
        if not isinstance(name, str) or not _RECOVERY_ENVIRONMENT_NAME.fullmatch(name):
            raise BuildControlError("Recovery environment contains an unsupported variable name")
        if not isinstance(value, str) or "\x00" in value or len(value) > 8192:
            raise BuildControlError("Recovery environment contains an invalid value")
        result[name] = value
    if len(canonical(result)) > _MAX_RECOVERY_METADATA_BYTES:
        raise BuildControlError("Recovery environment exceeds the metadata budget")
    return result


def _validate_recovery_metadata(value):
    """Accept only bounded JSON metadata already authenticated by the caller."""

    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise BuildControlError("Recovery metadata must be a mapping")
    try:
        encoded = canonical(value)
    except (TypeError, ValueError) as error:
        raise BuildControlError("Recovery metadata is not canonical JSON") from error
    if len(encoded) > _MAX_RECOVERY_METADATA_BYTES:
        raise BuildControlError("Recovery metadata exceeds the metadata budget")
    return dict(value)


def _validate_accepted_reattach_environment(value):
    """Validate the two private controls passed to the API reattach bridge."""

    if value is None:
        return {}
    if not isinstance(value, Mapping) or set(value) != _ACCEPTED_REATTACH_ENVIRONMENT_KEYS:
        raise BuildControlError(
            "Accepted-run reattach requires exactly its request path and digest controls"
        )
    relative = value["FULLMAG_ACCEPTED_REATTACH_REQUEST"]
    if (not isinstance(relative, str) or not relative
            or len(relative) > 1024 or relative.startswith("/")
            or "\\" in relative or ":" in relative):
        raise BuildControlError("Accepted-run reattach request path is not relative")
    path = PurePosixPath(relative)
    if (str(path) != relative or path.is_absolute() or ".." in path.parts
            or any(part in {"", "."} for part in path.parts)
            or not relative.startswith("accepted-run-reattach/")):
        raise BuildControlError("Accepted-run reattach request path escapes runtime control")
    digest = value["FULLMAG_ACCEPTED_REATTACH_REQUEST_SHA256"]
    if not isinstance(digest, str) or _SHA256.fullmatch(digest) is None:
        raise BuildControlError("Accepted-run reattach request digest is invalid")
    return {key: str(item) for key, item in value.items()}


def _validate_accepted_reattach_metadata(value, environment):
    """Keep the producer's immutable pins in the next development receipt."""

    if value is None:
        if environment:
            raise BuildControlError("Accepted-run reattach pins are missing")
        return None
    validated = _validate_recovery_metadata(value)
    if not environment:
        raise BuildControlError("Accepted-run reattach pins have no environment controls")
    if validated.get("schema") != "fullmag.docker-accepted-run-reattach-producer.v1":
        raise BuildControlError("Accepted-run reattach pins have an unsupported schema")
    if validated.get("state") != "prepared":
        raise BuildControlError("Accepted-run reattach pins are not prepared")
    request_sha = validated.get("request_sha256")
    proof_sha = validated.get("proof_sha256")
    if (_SHA256.fullmatch(request_sha or "") is None
            or _SHA256.fullmatch(proof_sha or "") is None):
        raise BuildControlError("Accepted-run reattach pins have invalid record digests")
    if environment["FULLMAG_ACCEPTED_REATTACH_REQUEST_SHA256"] != request_sha:
        raise BuildControlError("Accepted-run reattach environment differs from its pins")
    for key, item in validated.items():
        if key.endswith("_sha256") and _SHA256.fullmatch(item or "") is None:
            raise BuildControlError("Accepted-run reattach pin has an invalid " + key)
    return validated


def _validate_existing_development_operation(control, operation, selected, identity):
    """Validate an already-held development lease before reusing it.

    The recovery path must never open a second BuildControl operation.  This
    check binds the supplied operation to the selected source and Compose
    group, and rejects an operation from another phase or attempt root.
    """

    if not isinstance(control, BuildControl):
        raise BuildControlError("Existing development context has no BuildControl")
    if not isinstance(operation, Mapping) or operation.get("lease_ready") is not True:
        raise BuildControlError("Existing development context has no active lease")
    receipt = operation.get("receipt")
    if not isinstance(receipt, Mapping):
        raise BuildControlError("Existing development context has no operation receipt")
    if receipt.get("phase") != "development":
        raise BuildControlError("Recovery operation must use the development phase")
    attempt = receipt.get("attempt")
    expected_root = "development/attempts/" + str(attempt)
    if not isinstance(attempt, str) or not _RECOVERY_ATTEMPT.fullmatch(attempt):
        raise BuildControlError("Recovery operation has an invalid attempt token")
    if operation.get("root") != expected_root:
        raise BuildControlError("Recovery operation root does not match its attempt")
    if receipt.get("compose_project") != control.project:
        raise BuildControlError("Recovery operation belongs to another Compose project")
    if identity.get("project_name") != control.project:
        raise BuildControlError("Selected checkout belongs to another Compose project")
    control_identity = control.identity
    for key in ("project_id", "worktree_id", "checkout_kind"):
        if control_identity.get(key) != identity.get(key):
            raise BuildControlError("Recovery operation identity differs from selected checkout")
    inputs = receipt.get("inputs")
    if not isinstance(inputs, Mapping) or inputs.get("source_root") != str(selected):
        raise BuildControlError("Recovery operation source differs from selected checkout")
    for key in ("source_project_id", "source_worktree_id", "source_checkout_kind"):
        expected = {"source_project_id": "project_id", "source_worktree_id": "worktree_id",
                    "source_checkout_kind": "checkout_kind"}[key]
        if key in inputs and inputs.get(key) != identity.get(expected):
            raise BuildControlError("Recovery operation source identity differs from selected checkout")
    return dict(receipt)


def _validate_existing_operation_inputs(receipt, expected):
    """Keep the ordinary DEV input contract immutable on a reused lease.

    Recovery owns one already-open ``BuildControl.operation``.  ``start`` may
    add recovery-only metadata, but it must not silently replace the standard
    source/image/device/operator inputs that later activate/resume commands
    use as their terminal proof.
    """

    actual = receipt.get("inputs") if isinstance(receipt, Mapping) else None
    if not isinstance(actual, Mapping):
        raise BuildControlError("Existing development operation has no standard inputs")
    required = (
        "source_root", "image_id", "source_project_id", "source_worktree_id",
        "source_checkout_kind", "gpu_access_requested", "device_access",
        "gpu_preflight", "operator_probe_environment_schema",
        "operator_probe_environment", "operator_probe_environment_sha256",
    )
    for key in required:
        if actual.get(key) != expected.get(key):
            raise BuildControlError(
                "Existing development operation input differs: " + key
            )


def _validate_prepared_start_context(prepared):
    """Validate toolchain/runtime receipts supplied by a recovery caller."""

    if not isinstance(prepared, Mapping):
        raise BuildControlError("Recovery start requires a prepared Docker context")
    toolchain = prepared.get("toolchain")
    images = prepared.get("images")
    if not isinstance(toolchain, Mapping) or not isinstance(images, Mapping):
        raise BuildControlError("Recovery start has incomplete prepared Docker context")
    toolchain_image = toolchain.get("image_id")
    backend = images.get("backend")
    image = backend.get("image_id") if isinstance(backend, Mapping) else None
    for label, value in (("toolchain", toolchain_image), ("backend", image)):
        if not isinstance(value, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", value):
            raise BuildControlError(f"Recovery {label} image is not pinned by digest")
    if not isinstance(toolchain.get("inputs"), Mapping):
        raise BuildControlError("Recovery toolchain receipt has no inputs")
    return toolchain, images


def docker_text(*args, timeout=90, combined=False):
    result = docker_capture(*args, timeout=timeout)
    return (result.stdout + (result.stderr if combined else b"")).decode("utf-8", "replace")


def consumers():
    ids = docker_text("ps", "--quiet", "--no-trunc").split()
    return json.loads(docker_text("inspect", *ids)) if ids else []


def _owned_volume(control, role, key):
    name = "fullmag-dev-" + role + "-v1-" + key[:24]
    labels = {**{k: v for k, v in control.labels.items() if k.startswith("org.fullmag.")},
              "org.fullmag.build.role": role, "org.fullmag.build.cache-key": key}
    found = docker_capture("volume", "inspect", name, allow_failure=True)
    if found.returncode:
        names = docker_text("volume", "ls", "--format", "{{.Name}}").splitlines()
        if name in names:
            raise BuildControlError("Existing data volume could not be inspected")
        arguments = ["volume", "create", "--driver", "local"]
        for label, value in labels.items():
            arguments += ["--label", label + "=" + value]
        docker_capture(*arguments, name)
        found = docker_capture("volume", "inspect", name)
    records = json.loads(found.stdout)
    if len(records) != 1:
        raise BuildControlError("Ambiguous build-data volume")
    observed = records[0]
    if (observed.get("Name") != name or observed.get("Driver") != "local"
            or observed.get("Options")
            or any((observed.get("Labels") or {}).get(k) != v for k, v in labels.items())):
        raise BuildControlError("Build-data volume ownership differs; retained")
    if any(m.get("Name") == name for c in consumers() for m in c.get("Mounts", [])):
        raise BuildControlError("Cannot initialize a build-data volume with active consumers")
    script = "test $(stat -c %u /data) = 0 -o $(stat -c %u /data) = 65532; chown 65532:65532 /data; chmod 0750 /data"
    args = control.helper_args(script, initialize=True)
    args[args.index("--entrypoint"):args.index("--entrypoint")] = ["--mount", "type=volume,src=" + name + ",dst=/data,volume-nocopy"]
    result = bounded_capture(args, data=b"", timeout=90)
    if result.returncode:
        raise BuildControlError(result.stderr.decode("utf-8", "replace"))
    return name


def _frontend(control, operation, selected, state, port, image):
    from docker_development_inputs import seed
    files = []
    inputs = seed(selected, state, port, write_file=lambda relative, data: files.append({
        "relative": relative, "data": base64.b64encode(data).decode("ascii")}))
    previous_inputs = control.read("frontend/development-inputs.json", optional=True)
    if (isinstance(previous_inputs, dict)
            and all(previous_inputs.get(key) == inputs.get(key) for key in
                ("source_root", "worktree_id", "dependency_seed_sha256", "toolpins_sha256", "host_port", "files", "live_directories"))):
        inputs = previous_inputs
    key = hashlib.sha256(canonical({"project": control.project,
        "dependencies": inputs["dependency_seed_sha256"], "tools": inputs["toolpins_sha256"]})).hexdigest()
    volume = _owned_volume(control, "frontend", key)
    operation["receipt"]["frontend_volume"] = volume
    request = canonical({"files": files, "inputs": inputs})
    if len(request) > 8 * 1024 * 1024:
        raise BuildControlError("Frontend metadata exceeds transfer budget")
    # Metadata only: the four application directories stay live readonly binds.
    script = r'''
import base64, hashlib, json, os, pathlib, stat, sys
root=pathlib.Path('/data/workspace')
request=json.load(sys.stdin)
freeze=pathlib.Path('/data/inputs-freeze.json')
if freeze.exists() or freeze.is_symlink():
    descriptor=os.open(freeze, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as stream:
        metadata=os.fstat(stream.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink!=1 or metadata.st_size>8*1024*1024:
            raise RuntimeError('Frozen frontend inputs are not one bounded regular file')
        frozen=json.loads(stream.read(8*1024*1024+1))
    original=frozen.get('manifest')
    if not isinstance(original,dict): raise RuntimeError('Frozen frontend manifest is missing')
    digest=hashlib.sha256((json.dumps(original,sort_keys=True,separators=(',',':'))+'\n').encode()).hexdigest()
    without_commit=lambda value:{k:v for k,v in value.items() if k!='source_commit'}
    if (frozen.get('schema')!='fullmag.docker-development-inputs-freeze.v1'
            or frozen.get('frozen_root')!='/state/development/frozen-inputs'
            or frozen.get('manifest_digest')!=digest
            or frozen.get('files')!=original.get('files')
            or without_commit(original)!=without_commit(request['inputs'])):
        raise RuntimeError('Frozen frontend configuration changed; cache retained')
    request['inputs']=original
root.mkdir(parents=True,exist_ok=True)
cache=pathlib.Path('/data/cache')
if cache.is_symlink(): raise RuntimeError('Frontend cache is a link')
cache.mkdir(exist_ok=True)
lock=cache/'.fullmag-frontend-runtime.lock'
if lock.is_symlink(): raise RuntimeError('Frontend runtime lock is a link')
with lock.open('ab'): pass
for record in request['files']:
    relative=pathlib.PurePosixPath(record['relative'])
    if relative.is_absolute() or '..' in relative.parts:
        raise RuntimeError('Unsafe frontend seed path')
    target=root.joinpath(*relative.parts)
    parent=root
    for part in relative.parts[:-1]:
        parent=parent/part
        if parent.is_symlink(): raise RuntimeError('Frontend parent is a link')
        parent.mkdir(exist_ok=True)
    data=base64.b64decode(record['data'],validate=True)
    if target.is_symlink(): raise RuntimeError('Frontend seed is a link')
    if target.exists():
        if target.read_bytes()!=data and record['relative'] not in ('apps/control-room/tsconfig.json','apps/control-room/next-env.d.ts'):
            raise RuntimeError('Frontend metadata changed; cache retained')
    else:
        with target.open('xb') as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
for name in ('app','src','public','scripts'):
    target=root/'apps/control-room'/name
    if target.is_symlink(): raise RuntimeError('Live directory is a link')
    target.mkdir(exist_ok=True)
print(json.dumps({'state':'seeded','files':len(request['files']),'inputs':request['inputs']}))
'''
    args = control.helper_args("exec /usr/local/bin/python3 -I -c " + __import__('shlex').quote(script))
    args[args.index("--entrypoint"):args.index("--entrypoint")] = ["--mount", "type=volume,src=" + volume + ",dst=/data,volume-nocopy"]
    args[args.index(control.image)] = image
    result = bounded_capture(args, data=request, timeout=120)
    if result.returncode:
        raise BuildControlError(result.stderr.decode("utf-8", "replace"))
    seeded = json.loads(result.stdout)
    inputs = seeded.pop("inputs")
    control.write(operation["root"] + "/frontend-seed.json", seeded)
    control.write("frontend/development-inputs.json", inputs)
    return inputs, volume


def _backend_cache(control, operation, layout, selected, image, toolchain):
    import docker_backend_volume_cache as cache
    def volume_docker(*args):
        result = docker_capture(*args, allow_failure=True)
        if result.returncode:
            if args[:2] == ("volume", "inspect") and "no such volume" in result.stderr.decode().lower():
                raise cache.VolumeNotFound(result.stderr.decode())
            raise BuildControlError(result.stderr.decode())
        return result.stdout.decode()
    relative = operation["root"] + "/backend-cache.json"
    layout = {**layout, "compose_project": control.project}
    profile = cache.prepare(layout, selected, image, layout["storage_root"], volume_docker,
        source_root=selected, toolchain_image=toolchain, active_consumers=consumers,
        control_volume_name=control.volume)
    overlay = cache.maintenance_overlay(profile)
    overlay["name"] = control.project
    control.write(operation["root"] + "/cache-maintenance-compose.json", overlay)
    output = compose_capture(overlay, "run", "--rm", "--no-deps", cache.MAINTENANCE_SERVICE, timeout=180)
    receipt = cache._read_json_output(output.decode())
    result = cache.validate(profile, profile["volume_documents"], receipt, consumers)
    control.write(relative, result)
    return result


def _verify_host_ledger_volume(control, operation, descriptor, image):
    import docker_host_ledger as ledger
    spec = ledger.host_volume_probe_spec(descriptor, image)
    service = "host-ledger-volume-probe"
    name = "fullmag-ledger-volume-" + operation["receipt"]["attempt"]
    control.write(operation["root"] + "/host-ledger-volume-probe-compose.json", spec)
    operation["receipt"]["ledger_volume_probe_container"] = name
    output = compose_capture(spec, "run", "--name", name, "--no-deps", service, timeout=90)
    observed = json.loads(docker_text("inspect", name))
    if len(observed) != 1:
        raise BuildControlError("Ledger volume probe identity is ambiguous; retained")
    actual = observed[0]
    config, isolation = actual.get("Config", {}), actual.get("HostConfig", {})
    labels = config.get("Labels", {})
    mounts = [mount for mount in actual.get("Mounts", []) if mount.get("Destination") == "/host-ledger"]
    if (actual.get("Image") != image or actual.get("State", {}).get("Running")
            or actual.get("State", {}).get("ExitCode") != 0
            or labels.get("com.docker.compose.project") != control.project
            or labels.get("com.docker.compose.service") != service
            or config.get("User") != "65532:65532" or isolation.get("Privileged")
            or not isolation.get("ReadonlyRootfs") or isolation.get("NetworkMode") != "none"
            or isolation.get("PidMode") not in {None, "", "private"}
            or len(mounts) != 1 or mounts[0].get("Type") != "volume"
            or mounts[0].get("Name") != descriptor["name"] or mounts[0].get("RW")):
        raise BuildControlError("Ledger volume probe isolation/identity/outcome differs; retained")
    proof = json.loads(output.decode().strip())
    if (proof.get("schema") != "fullmag.host-ledger-volume-probe.v1"
            or proof.get("state") != "verified" or proof.get("volume_name") != descriptor["name"]
            or proof.get("filesystem_uuid") != descriptor["filesystem_uuid"]):
        raise BuildControlError("Ledger volume probe did not verify the selected filesystem; retained")
    control.write(operation["root"] + "/host-ledger-volume-probe.json",
                  {**proof, "container_id": actual["Id"], "image_id": image,
                   "descriptor_sha256": hashlib.sha256(canonical(descriptor)).hexdigest()})
    control.write(operation["root"] + "/host-ledger-volume-probe-log.json",
                  {"log": docker_text("logs", name, combined=True)})
    docker_capture("rm", actual["Id"])


def _host_ledger(control, operation, layout, selected, image):
    import docker_host_ledger as ledger
    values = ledger._resolve_values(layout)
    daemon = ledger._daemon_info(docker_text)
    ledger._image_attestation(image, docker_text)
    helper = selected / "scripts/lib/docker_host_ledger.sh"
    helper_bytes = _session_host().read_owned_regular(helper, maximum=ledger.MAX_HELPER_BYTES)
    helper_hash = hashlib.sha256(helper_bytes).hexdigest()
    helper_relative = operation["root"] + "/docker_host_ledger.sh"
    control.write_bytes(helper_relative, helper_bytes)
    daemon_storage = ledger._daemon_path(values["storage_root"], "storage root")
    if os.name != "nt":
        from docker_wsl_bind import resolve_daemon_bind
        daemon_storage = resolve_daemon_bind(control, operation, Path(values["storage_root"]), image)
    backing = daemon_storage + "/build-volumes/" + ledger.IMAGE_NAME
    env = {
        "FULLMAG_HOST_LEDGER_PROFILE": ledger.PROFILE,
        "FULLMAG_HOST_LEDGER_PROJECT_ID": values["project_id"],
        "FULLMAG_HOST_LEDGER_STORAGE_ROOT": daemon_storage,
        "FULLMAG_HOST_LEDGER_BACKING_IMAGE": backing,
        "FULLMAG_HOST_LEDGER_MOUNT_ROOT": values["mount_root"],
        "FULLMAG_HOST_LEDGER_LOCK_PATH": backing + ".lock",
        "FULLMAG_HOST_LEDGER_OWNER_MARKER": values["owner_marker"],
        "FULLMAG_HOST_LEDGER_SIZE_BYTES": str(ledger.IMAGE_SIZE_BYTES),
        "FULLMAG_HOST_LEDGER_MOUNT_TARGET": ledger.MOUNT_TARGET,
        "FULLMAG_HOST_LEDGER_ROOT": ledger.LEDGER_ROOT,
        "FULLMAG_HOST_LEDGER_LEDGER_ROOT": values["ledger_root_daemon"],
        "FULLMAG_HOST_LEDGER_HELPER_PATH": ledger._daemon_path(helper, "readonly helper source"),
        "FULLMAG_HOST_LEDGER_HELPER_IMAGE": image,
        "FULLMAG_HOST_LEDGER_HOST_PID": "1",
        "FULLMAG_HOST_LEDGER_RUNTIME_UID": "65532", "FULLMAG_HOST_LEDGER_RUNTIME_GID": "65532",
        "FULLMAG_HOST_LEDGER_LOCK_WAIT_SECONDS": "120", "FULLMAG_DOCKER_HOST_ID": daemon["id_sha256"],
    }
    command = docker_argv("compose", "--project-name", control.project,
               "-f", "-", "-f", str(selected / "compose.host-ledger.yaml"), "--profile", "host-ledger-maintenance", "config", "--format", "json")
    result = bounded_capture(command, data=canonical({"name": control.project,
        "services": {"backend": {"image": image}}}),
        env={**os.environ, **env}, timeout=90)
    if result.returncode or len(result.stdout) > 1024 * 1024:
        raise BuildControlError("Host-ledger Compose rendering failed: " + result.stderr.decode("utf-8", "replace"))
    rendered = json.loads(result.stdout)
    service = rendered["services"]["host-ledger-maintenance"]
    service["volumes"] = [mount for mount in service["volumes"]
                          if mount["target"] != "/usr/local/sbin/docker_host_ledger.sh"]
    service["volumes"].append({"type": "volume", "source": "build-control",
        "target": "/fullmag-build-control", "read_only": True, "volume": {"nocopy": True}})
    service["entrypoint"] = ["/bin/bash", "/fullmag-build-control/" + helper_relative]
    spec = {"name": control.project, "services": {"host-ledger-maintenance": service},
            "volumes": {"build-control": {"name": control.volume, "external": True}}}
    control.write(operation["root"] + "/ledger-maintenance-compose.json", spec)
    name = "fullmag-ledger-" + operation["receipt"]["attempt"]
    output = compose_capture(spec, "run", "--name", name, "--no-deps", "host-ledger-maintenance", "ensure", timeout=360)
    observed = json.loads(docker_text("inspect", name))
    if (len(observed) != 1 or observed[0].get("Image") != image
            or observed[0].get("State", {}).get("ExitCode") != 0
            or observed[0].get("State", {}).get("Running")
            or observed[0].get("Config", {}).get("Labels", {}).get("com.docker.compose.project") != control.project):
        raise BuildControlError("Host-ledger helper identity/outcome differs; resources retained")
    if hashlib.sha256(_session_host().read_owned_regular(helper, maximum=ledger.MAX_HELPER_BYTES)).hexdigest() != helper_hash:
        raise BuildControlError("Host-ledger helper changed during maintenance")
    host_receipt = ledger._parse_json_lines(output.decode(), ledger.HOST_RECEIPT_SCHEMA)
    ledger._validate_host_receipt(host_receipt, {"project_id": values["project_id"],
        "mount_root": values["mount_root"], "backing_image": env["FULLMAG_HOST_LEDGER_BACKING_IMAGE"]})
    control.write(operation["root"] + "/host-ledger.json", host_receipt)
    control.write(operation["root"] + "/ledger-helper-log.json",
                  {"log": docker_text("logs", name, combined=True)})
    docker_capture("rm", observed[0]["Id"])
    backend = rendered["services"]["backend"]
    profile = {"profile": ledger.PROFILE, "image_id": image, "environment": env,
        "mount_root": values["mount_root"], "project_id": values["project_id"],
        "backing_image": env["FULLMAG_HOST_LEDGER_BACKING_IMAGE"], "host_receipt": host_receipt,
        "maintenance_document": spec}
    if os.name != "nt":
        descriptor = ledger.prepare_host_volume(profile, control.project, docker_text)
        _verify_host_ledger_volume(control, operation, descriptor, image)
        profile["daemon_volume"] = descriptor
        backend["volumes"] = [mount for mount in backend["volumes"]
                              if mount["target"] != ledger.MOUNT_TARGET] + [descriptor["mount"]]
        backend["x-fullmag-host-ledger-volume"] = descriptor
        control.write(operation["root"] + "/host-ledger-volume.json", descriptor)
    return backend, profile



def _startup_helper(control, selected, image):
    """Execute host admission code only when both helper bytes match the image."""
    import fullmag_docker_runtime as runtime
    names = ("docker_startup_script.py", "fullmag_storage.py")
    command = "sha256sum " + " ".join("/opt/fullmag/" + name for name in names)
    arguments = control.helper_args(command)
    arguments[arguments.index(control.image)] = image
    result = bounded_capture(arguments, data=b"", timeout=90)
    if result.returncode:
        raise BuildControlError("Image startup-helper attestation failed")
    hashes = {}
    for line in result.stdout.decode().splitlines():
        digest, path = line.split()
        if not re.fullmatch(r"[0-9a-f]{64}", digest) or path not in {"/opt/fullmag/" + name for name in names}:
            raise BuildControlError("Image startup-helper inventory differs")
        hashes[PurePosixPath(path).name] = digest
    if set(hashes) != set(names):
        raise BuildControlError("Image startup-helper inventory is incomplete")
    verified = {}
    for name in names:
        path = selected / "scripts" / name
        data, matches, _ = runtime._verified_startup_helper(path, hashes[name])
        if not matches:
            raise BuildControlError("Startup helper changed since image preparation: " + name)
        verified[name] = (path, data)
    return runtime._exec_verified_startup_helpers(verified), hashes


def _operator_probe_record(values):
    """Return the bounded operator controls with their canonical digest."""

    from docker_dev import (
        OPERATOR_PROBE_ENVIRONMENT_SCHEMA,
        _normalize_operator_probe_environment,
        _operator_probe_environment_sha256,
    )

    try:
        normalized = _normalize_operator_probe_environment(values)
        digest = _operator_probe_environment_sha256(normalized)
    except Exception as error:
        raise BuildControlError(f"Invalid operator probe environment: {error}") from error
    return {
        "operator_probe_environment_schema": OPERATOR_PROBE_ENVIRONMENT_SCHEMA,
        "operator_probe_environment": dict(normalized),
        "operator_probe_environment_sha256": digest,
    }


def _operator_probe_record_from_fields(fields, *, label):
    """Validate a previously frozen record; never replace it from host env."""

    from docker_dev import (
        OPERATOR_PROBE_ENVIRONMENT_SCHEMA,
        _normalize_operator_probe_environment,
        _operator_probe_environment_sha256,
    )

    if not isinstance(fields, Mapping):
        raise BuildControlError(f"{label} has no operator probe environment record")
    if fields.get("operator_probe_environment_schema") != OPERATOR_PROBE_ENVIRONMENT_SCHEMA:
        raise BuildControlError(f"{label} has an unsupported operator probe environment schema")
    values = fields.get("operator_probe_environment")
    try:
        normalized = _normalize_operator_probe_environment(values)
        digest = _operator_probe_environment_sha256(normalized)
    except Exception as error:
        raise BuildControlError(f"{label} has an invalid operator probe environment: {error}") from error
    if fields.get("operator_probe_environment_sha256") != digest:
        raise BuildControlError(f"{label} operator probe environment digest does not match its values")
    return {
        "operator_probe_environment_schema": OPERATOR_PROBE_ENVIRONMENT_SCHEMA,
        "operator_probe_environment": dict(normalized),
        "operator_probe_environment_sha256": digest,
    }


def _operator_probe_record_from_retained(previous, document):
    """Recover the exact controls from the retained Compose record and verify mounts."""

    record = _operator_probe_record_from_fields(previous, label="retained operation")
    backend = document.get("services", {}).get("backend", {})
    environment = backend.get("environment", {})
    if not isinstance(environment, Mapping):
        raise BuildControlError("retained backend environment is malformed")
    values = record["operator_probe_environment"]
    if any(environment.get(name) != value for name, value in values.items()):
        raise BuildControlError("retained backend operator probe environment differs from its receipt")
    if environment.get("FULLMAG_OPERATOR_PROBE_ENVIRONMENT_SHA256") != record["operator_probe_environment_sha256"]:
        raise BuildControlError("retained backend operator probe digest differs from its receipt")
    if environment.get("FULLMAG_DEVELOPMENT_INPUTS_PATH") != (
        "/opt/fullmag/control/frontend/development-inputs.json"
    ):
        raise BuildControlError("retained backend development-inputs path differs from its full control volume")
    frontend = document.get("services", {}).get("frontend", {})
    frontend_environment = frontend.get("environment", {})
    if frontend_environment.get("FULLMAG_DEVELOPMENT_INPUTS_PATH") != (
        "/opt/fullmag/control/development-inputs.json"
    ):
        raise BuildControlError("retained frontend uses an unrestricted development-inputs path")
    frontend_control_mounts = [
        mount for mount in frontend.get("volumes", [])
        if mount.get("source") == "build-control"
        and mount.get("target") == "/opt/fullmag/control"
    ]
    if (len(frontend_control_mounts) != 1
            or frontend_control_mounts[0].get("volume", {}).get("subpath") != "frontend"):
        raise BuildControlError("retained frontend does not use the restricted control-volume subpath")
    return record


def _reassert_operator_probe_environment(document, record):
    """Reapply the frozen controls after every Compose/cache environment overlay."""

    backend = document["services"]["backend"]
    backend_environment = backend["environment"]
    if not isinstance(backend_environment, dict):
        raise BuildControlError("DEV backend environment is malformed")
    backend_environment.update(record["operator_probe_environment"])
    backend_environment["FULLMAG_OPERATOR_PROBE_ENVIRONMENT_SHA256"] = record[
        "operator_probe_environment_sha256"
    ]
    backend_environment["FULLMAG_DEVELOPMENT_INPUTS_PATH"] = (
        "/opt/fullmag/control/frontend/development-inputs.json"
    )
    if any(backend_environment.get(name) != value
           for name, value in record["operator_probe_environment"].items()):
        raise BuildControlError("DEV backend operator probe environment was not reasserted")
    if backend_environment.get("FULLMAG_OPERATOR_PROBE_ENVIRONMENT_SHA256") != record[
        "operator_probe_environment_sha256"
    ]:
        raise BuildControlError("DEV backend operator probe digest was not reasserted")

    # The frontend sees only the `frontend` subpath of build-control.  Its
    # manifest path is therefore relative to that restricted mount; backend
    # keeps the full-volume path used during Compose interpolation.
    frontend_environment = document["services"]["frontend"]["environment"]
    if not isinstance(frontend_environment, dict):
        raise BuildControlError("DEV frontend environment is malformed")
    frontend_environment["FULLMAG_DEVELOPMENT_INPUTS_PATH"] = (
        "/opt/fullmag/control/development-inputs.json"
    )


def _start_compose_services(control, operation, document):
    # Reject invalid declarations before crossing the daemon-mutation boundary.
    configured = json.loads(compose_capture(document, "config", "--format", "json", timeout=60))
    if configured.get("name") != control.project or set(configured.get("services", {})) != {"backend", "frontend"}:
        raise BuildControlError("DEV Compose preflight changed the selected group or services")
    operation["receipt"]["compose_preflight"] = "PASS"
    operation["daemon_pending"] = True
    compose_capture(document, "up", "--detach", "--no-build", "--pull", "never", timeout=180)
    operation["daemon_pending"] = False


def _assert_new_windows_runtime_path(path, state):
    """Reject reparse points while inspecting a fresh Windows state tree."""

    path = Path(path)
    state = Path(state)
    current = path
    while True:
        if os.path.lexists(current) and storage.is_link(current):
            raise BuildControlError(
                "New Windows runtime state traverses a reparse point: " + str(current)
            )
        if current == state:
            return
        if current.parent == current or state not in current.parents:
            raise BuildControlError("Windows runtime state path escaped its new state root")
        current = current.parent


def _probe_new_windows_runtime_directory(directory):
    """Prove that the native Windows user can write the final runtime directory."""

    directory = Path(directory)
    if not os.access(directory, os.W_OK | os.X_OK):
        raise BuildControlError("New Windows runtime directory is not writable: " + str(directory))
    probe = directory / (
        ".fullmag-runtime-state-write-probe-"
        + str(os.getpid())
        + "-"
        + str(time.monotonic_ns())
    )
    descriptor = None
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(probe, flags, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            descriptor = None
            stream.write(b"fullmag-runtime-state-preflight\n")
            stream.flush()
            os.fsync(stream.fileno())
        if storage.is_link(probe):
            raise BuildControlError("Runtime write probe became a reparse point")
        probe.unlink()
    except BuildControlError:
        raise
    except (OSError, ValueError) as error:
        raise BuildControlError(
            "New Windows runtime directory failed the write probe: " + str(directory)
        ) from error
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if os.path.lexists(probe) and not storage.is_link(probe):
            try:
                probe.unlink()
            except OSError:
                pass
    if os.path.lexists(probe):
        raise BuildControlError("Runtime write probe was not removed safely")


def _precreate_new_windows_runtime_state(state):
    """Prepare the exact runtime namespace before Docker can create it as root.

    This is intentionally limited to a freshly-created state root. Existing
    entries are rejected rather than adopted, repaired, or recursively
    permission-changed. Build data remains in Docker volumes.
    """

    if sys.platform != "win32":
        raise BuildControlError("Windows runtime state must be prepared by native Windows")
    state = Path(state)
    if storage.is_link(state) or not state.is_dir():
        raise BuildControlError("New Windows runtime state root is missing or a reparse point")

    for relative in _NEW_WINDOWS_RUNTIME_STATE_DIRECTORIES:
        target = state / relative
        _assert_new_windows_runtime_path(target, state)
        if os.path.lexists(target):
            raise BuildControlError(
                "New Windows runtime state already contains " + relative.as_posix()
            )

    for relative in _NEW_WINDOWS_RUNTIME_STATE_DIRECTORIES:
        target = state / relative
        try:
            target.mkdir()
        except OSError as error:
            raise BuildControlError(
                "New Windows runtime state directory could not be created: " + str(target)
            ) from error
        _assert_new_windows_runtime_path(target, state)
        if not target.is_dir():
            raise BuildControlError("Windows runtime state entry is not a directory: " + str(target))

    _probe_new_windows_runtime_directory(
        state / _NEW_WINDOWS_RUNTIME_STATE_DIRECTORIES[-1]
    )
    return tuple(relative.as_posix() for relative in _NEW_WINDOWS_RUNTIME_STATE_DIRECTORIES)


def start(args, *, reuse_state=None, control=None, operation=None, prepared=None,
          recovery_environment=None, recovery_metadata=None, previous_config_sha256=None,
          native_restart_metadata=None, accepted_reattach_environment=None,
          accepted_reattach_metadata=None):
    from docker_dev import (_select_source, _compose_identity,
        _assert_no_running_fullmag, _source_git_common_directory, _workspace_state_root,
        _operator_probe_environment_from_host)
    import fullmag_docker_runtime as runtime
    provided_control = control
    provided_operation = operation
    if (provided_control is None) != (provided_operation is None):
        raise BuildControlError("Recovery start requires both control and operation")
    validated_recovery_environment = _validate_recovery_environment(recovery_environment)
    validated_recovery_metadata = _validate_recovery_metadata(recovery_metadata)
    validated_native_restart_metadata = _validate_recovery_metadata(native_restart_metadata)
    validated_accepted_reattach_environment = _validate_accepted_reattach_environment(
        accepted_reattach_environment
    )
    validated_accepted_reattach_metadata = _validate_accepted_reattach_metadata(
        accepted_reattach_metadata, validated_accepted_reattach_environment
    )
    if previous_config_sha256 is not None and _SHA256.fullmatch(str(previous_config_sha256)) is None:
        raise BuildControlError("Previous runtime configuration digest is not a lowercase SHA-256")
    require_host()
    host = _session_host()
    selected, layout = _select_source(Path(args.repo_root).resolve(strict=True), args.source_root or args.repo_root)
    validate_host_path(selected, "source checkout")
    local_volume(Path(layout["storage_root"]))
    identity = _compose_identity(layout)
    admission_context = {}
    if provided_operation is not None:
        _validate_existing_development_operation(provided_control, provided_operation, selected, identity)
        held = provided_operation["receipt"]
        admission_context["owned_control"] = {
            "name": held["helper_container"],
            "attempt": held["attempt"],
            "image": provided_control.image,
            "volume": provided_control.volume,
        }
    _assert_no_running_fullmag(identity["project_name"], identity, **admission_context)
    runtime.assert_loopback_port_available(args.port, identity["project_name"])
    if args.profile != "dev":
        raise BuildControlError("Volume DEV supports backend-dev; release uses its explicit managed recipe")
    if args.image or args.toolchain_image or args.source_manifest or args.include_untracked:
        raise BuildControlError("Volume DEV requires its attested dependency/image route; explicit overrides are not qualified")
    # Freeze the bounded operator controls before any toolchain/image/cache
    # preparation.  A service recreation reuses the exact prior record rather
    # than rereading ambient host variables.
    if reuse_state is None:
        operator_probe_record = _operator_probe_record(_operator_probe_environment_from_host())
    else:
        operator_probe_record = _operator_probe_record_from_fields(
            reuse_state.get("operator_probe_environment_record"), label="service recreation"
        )
    from docker_dev import _resolve_gpu_access, _verify_docker_gpu_access
    policy = getattr(args, "gpu_access", None) or "auto"
    device_access = _resolve_gpu_access(policy)
    if provided_operation is None:
        toolchain = build_volume_toolchain(selected)
        control = BuildControl(identity, toolchain["inputs"]["build_args"]["FULLMAG_CUDA_BASE_IMAGE"])
        images = build_volume_runtime_images(selected, control, toolchain)
    else:
        control = provided_control
        toolchain, images = _validate_prepared_start_context(prepared)
    image = images["backend"]["image_id"]
    device_access = _verify_docker_gpu_access(device_access, policy, image, control.project)
    _assert_no_running_fullmag(control.project, identity, **admission_context)
    if args.script is not None:
        if validated_accepted_reattach_environment:
            raise BuildControlError(
                "Accepted-run reattach cannot be combined with a new startup script"
            )
        # ``start --script`` enables the image entrypoint's startup POST after
        # Compose starts.  Apply the same durable unknown-activation quarantine
        # used by the explicit activation command before creating provenance
        # or admitting a new RunIntent.
        from docker_volume_activation_reconcile import assert_no_unresolved_activation
        assert_no_unresolved_activation(control)
    operation_inputs = {"source_root": str(selected), "image_id": image,
        "source_project_id": identity["project_id"],
        "source_worktree_id": identity["worktree_id"],
        "source_checkout_kind": identity["checkout_kind"],
        "gpu_access_requested": policy, "device_access": device_access,
        "gpu_preflight": "PASS" if device_access == "gpu" else "NOT_REQUIRED",
        **operator_probe_record}
    if previous_config_sha256 is not None:
        operation_inputs["previous_config_sha256"] = previous_config_sha256
    if validated_native_restart_metadata is not None:
        operation_inputs["native_failed_restart"] = validated_native_restart_metadata
    if validated_accepted_reattach_metadata is not None:
        operation_inputs["accepted_reattach"] = validated_accepted_reattach_metadata
    if provided_operation is not None:
        _validate_existing_operation_inputs(provided_operation.get("receipt", {}), operation_inputs)
    operation_context = (control.operation("development", operation_inputs)
                         if provided_operation is None
                         else nullcontext(provided_operation))
    with operation_context as operation:
        operation["receipt"].update(operator_probe_record)
        if validated_recovery_metadata is not None:
            operation["receipt"]["container_recovery"] = validated_recovery_metadata
        if validated_recovery_environment:
            operation["receipt"]["container_recovery_environment"] = sorted(
                validated_recovery_environment
            )
        if validated_accepted_reattach_metadata is not None:
            operation["receipt"]["accepted_reattach"] = validated_accepted_reattach_metadata
        token = operation["receipt"]["attempt"]
        if reuse_state is None:
            state = storage.validate_path(Path(layout["runtime_root"]) / "docker-volume-dev" / token,
                                          layout["storage_root"], "session storage")
            state.mkdir(parents=True, exist_ok=False)
            if os.name == "nt":
                operation["receipt"]["windows_runtime_directories"] = list(
                    _precreate_new_windows_runtime_state(state)
                )
                operation["receipt"]["windows_runtime_write_probe"] = "PASS"
            else:
                operation["receipt"]["linux_runtime_directories"] = list(
                    host.prepare_runtime_directories(state)
                )
            certificate_path = _certificate_path(state)
            certificate_path.touch(exist_ok=False)
        else:
            try:
                state = storage.validate_path(
                    Path(reuse_state["state"]),
                    Path(layout["runtime_root"]),
                    "retained Windows sessions",
                )
                certificate_path = storage.validate_path(
                    Path(reuse_state["host_certificate"]),
                    state,
                    "retained Windows session certificate",
                )
                owner_marker = storage.validate_path(
                    Path(reuse_state["owner_marker"]),
                    state,
                    "retained Windows session owner marker",
                )
            except (KeyError, TypeError, ValueError, storage.StorageError) as error:
                raise BuildControlError(
                    "Retained Windows session paths are outside the selected runtime root"
                ) from error
            reuse_state = dict(reuse_state)
            reuse_state["state"] = state
            reuse_state["host_certificate"] = certificate_path
            reuse_state["owner_marker"] = owner_marker
        operation["receipt"]["state_root"] = str(state)
        local_volume(state)
        cache = _backend_cache(control, operation, layout, selected, image, toolchain["image_id"])
        operation["receipt"]["backend_volumes"] = cache["volume_names"]
        frontend_inputs, frontend_volume = _frontend(control, operation, selected, state, args.port, image)
        ledger_backend, ledger_profile = _host_ledger(control, operation, layout, selected, image)
        inputs = {"image_id": image, "toolchain_image_id": toolchain["image_id"],
                  "guest_provenance_path": "/opt/fullmag/control/backend/runtime-provenance.json"}
        provisional, hashes, delegation = runtime._provisional_development_certificate(inputs, identity)
        provisional["binary_hashes"] = hashes
        engine_id = docker_text("info", "--format", "{{.ID}}").strip()
        if reuse_state is None:
            certificate = host.attest(state, provisional, engine_id, hashes, development_build=delegation)
            host.publish_evidence(certificate_path, certificate)
        else:
            reuse_certificate = runtime._reuse_host_certificate if os.name == "nt" else host.reuse_certificate
            certificate = reuse_certificate(reuse_state, provisional, engine_id,
                                                         development_build=delegation)
        startup = None
        if args.script is not None:
            startup_helper, startup_hashes = _startup_helper(control, selected, image)
            authorization = startup_helper.prepare(selected, args.script,
                request_id="docker-volume-" + token, source_commit=storage.git(selected, "rev-parse", "HEAD"))
            startup_path = state / "startup-provenance.json"
            startup_digest = startup_helper.write_provenance(startup_path, authorization)
            startup = {"authorization": authorization.as_dict(), "path": str(startup_path),
                       "provenance_sha256": startup_digest, "helper_hashes": startup_hashes}
        user_data = _workspace_state_root(layout, control.project)
        if os.name != "nt":
            host.admit_runtime_uid(user_data)
        git_common = _source_git_common_directory(selected)
        environment = {**os.environ, "FULLMAG_COMPOSE_PROJECT": control.project,
            "FULLMAG_COMPOSE_NETWORK": identity["network_name"],
            "FULLMAG_DOCKER_DEVICE_ACCESS": device_access,
            "FULLMAG_BUILD_CONTROL_VOLUME": control.volume,
            "FULLMAG_SOURCE_COMMIT": storage.git(selected, "rev-parse", "HEAD"),
            "FULLMAG_DEVELOPMENT_INPUTS_PATH": "/opt/fullmag/control/frontend/development-inputs.json",
            "FULLMAG_SOURCE_ROOT": str(selected), "FULLMAG_SOURCE_GIT_COMMON": str(git_common),
            "FULLMAG_DEV_IMAGE": image, "FULLMAG_TOOLCHAIN_IMAGE_ID": toolchain["image_id"],
            "FULLMAG_TOOLCHAIN_IMAGE": toolchain["image_id"],
            "FULLMAG_BACKEND_HOSTNAME": "fullmag-direct-backend-" + token[:12],
            "FULLMAG_STATE_ROOT": str(state), "FULLMAG_HOST_CERTIFICATE": str(certificate_path),
            "FULLMAG_PACKAGE_PROVENANCE": str(certificate_path),
            "FULLMAG_WORKSPACE_STATE_ROOT": str(user_data),
            "FULLMAG_DEVELOPMENT_INPUTS": str(certificate_path), "FULLMAG_HTTP_PORT": str(args.port),
            "FULLMAG_SOURCE_PROJECT_ID": identity["project_id"],
            "FULLMAG_SOURCE_WORKTREE_ID": identity["worktree_id"],
            "FULLMAG_SOURCE_CHECKOUT_KIND": identity["checkout_kind"]}
        # Only the two validated controls are carried into Compose.  The
        # digest is explicit so later cache/ledger overlays cannot silently
        # replace the operator's requested probe mode.
        environment.update(operator_probe_record["operator_probe_environment"])
        environment["FULLMAG_OPERATOR_PROBE_ENVIRONMENT_SHA256"] = operator_probe_record[
            "operator_probe_environment_sha256"
        ]
        configured = bounded_capture(docker_argv("compose",
            "--project-name", control.project, "-f", str(selected / "compose.dev.yaml"),
            "config", "--format", "json"), env=environment, timeout=90)
        if configured.returncode or len(configured.stdout) > 1024 * 1024:
            raise BuildControlError("DEV Compose render failed: " + configured.stderr.decode("utf-8", "replace"))
        document = json.loads(configured.stdout)
        if device_access == "gpu":
            document["services"]["backend"]["gpus"] = [{"count": "all"}]
        backend, frontend = (document["services"][name] for name in ("backend", "frontend"))
        backend["environment"]["FULLMAG_SESSION_STORAGE_PROFILE"] = certificate["storage_profile"]
        for mount in backend["volumes"]:
            if mount["target"] == "/run/fullmag/windows-folder-host.json":
                mount["target"] = host.HOST_CERT_PATH
        backend.pop("build", None)
        backend["environment"].update(cache["environment"])
        backend["environment"].update(ledger_backend["environment"])
        backend["environment"]["FULLMAG_PACKAGE_PROVENANCE"] = runtime.BACKEND_PROVENANCE_PATH
        backend["environment"]["FULLMAG_RUNTIME_PROVENANCE"] = runtime.BACKEND_PROVENANCE_PATH
        backend["environment"]["CUDA_CACHE_PATH"] = "/build/cuda-cache"
        backend["environment"].pop("FULLMAG_DOCKER_PREVIOUS_CONFIG_SHA256", None)
        if previous_config_sha256 is not None:
            backend["environment"]["FULLMAG_DOCKER_PREVIOUS_CONFIG_SHA256"] = str(
                previous_config_sha256
            )
        backend["environment"].update(validated_recovery_environment)
        backend["environment"].pop("FULLMAG_ACCEPTED_REATTACH_REQUEST", None)
        backend["environment"].pop("FULLMAG_ACCEPTED_REATTACH_REQUEST_SHA256", None)
        backend["environment"].update(validated_accepted_reattach_environment)
        if startup is not None:
            backend["environment"].update(FULLMAG_STARTUP_ENABLED="1",
                FULLMAG_STARTUP_SCRIPT=startup["authorization"]["container_script_path"],
                FULLMAG_STARTUP_PROVENANCE="/run/fullmag/startup-provenance.json",
                FULLMAG_STARTUP_PROVENANCE_SHA256=startup["provenance_sha256"],
                FULLMAG_STARTUP_HELPER_SHA256=startup["helper_hashes"]["docker_startup_script.py"],
                FULLMAG_STARTUP_API="http://127.0.0.1:8081")
            backend["volumes"].append({"type": "bind", "source": startup["path"],
                "target": "/run/fullmag/startup-provenance.json", "read_only": True,
                "bind": {"create_host_path": False}})
        backend["labels"].update(cache["overlay"]["services"]["backend"]["labels"])
        backend["volumes"] = [m for m in backend["volumes"]
                              if m["target"] not in {"/opt/fullmag/provenance.json", "/build", "/opt/fullmag/package", "/opt/fullmag/control"}]
        backend["volumes"] += cache["overlay"]["services"]["backend"]["volumes"] + ledger_backend["volumes"]
        frontend["volumes"] = [m for m in frontend["volumes"]
                               if m["target"] not in {"/state/development", "/run/fullmag/development-inputs.json"}]
        frontend["volumes"] += [
            {"type": "volume", "source": "frontend-build", "target": "/state/development", "volume": {"nocopy": True}},
            {"type": "volume", "source": "build-control", "target": "/opt/fullmag/control", "read_only": True,
             "volume": {"nocopy": True, "subpath": "frontend"}}]
        document["volumes"] = {**document.get("volumes", {}), **cache["overlay"]["volumes"],
            "frontend-build": {"name": frontend_volume, "external": True},
            "build-control": {"name": control.volume, "external": True}}
        if "x-fullmag-host-ledger-volume" in ledger_backend:
            descriptor = ledger_backend["x-fullmag-host-ledger-volume"]
            backend["x-fullmag-host-ledger-volume"] = descriptor
            document["volumes"]["host-ledger"] = descriptor["compose_volume"]
        _reassert_operator_probe_environment(document, operator_probe_record)
        for service in (backend, frontend):
            service["logging"] = {"driver": "local", "options": {"max-size": "10m", "max-file": "3"}}
        from docker_script_output_mounts import configure as configure_script_output, validate as validate_script_output
        configure_script_output(document, selected)
        validate_script_output(document)
        # All writable bind destinations are runtime/user stores, never build data.
        for service in (backend, frontend):
            for mount in service["volumes"]:
                if mount["type"] == "bind" and not mount.get("read_only") and mount["target"] not in ({"/state", "/user-data", "/host-ledger"} | ({"/opt/fullmag/script-output"} if service is backend else set())):
                    raise BuildControlError("Unexpected writable host bind: " + mount["target"])
        control.write(operation["root"] + "/compose.json", document)
        operation["receipt"].update(state="starting-services", state_root=str(state),
            frontend_volume=frontend_volume, backend_volumes=cache["volume_names"])
        _start_compose_services(control, operation, document)
        backend_id = compose_capture(document, "ps", "--all", "--quiet", "backend").decode().strip()
        frontend_id = compose_capture(document, "ps", "--all", "--quiet", "frontend").decode().strip()
        if not backend_id or not frontend_id:
            raise BuildControlError("Compose did not return both fixed services")
        import docker_backend_volume_cache as backend_cache
        backend_cache.validate_container(json.loads(docker_text("inspect", backend_id))[0], cache)
        if os.name != "nt":
            # Desktop translates WSL client paths. Pin inspect's daemon paths
            # after creation so later resumes compare the same namespace.
            for service, identifier in (("backend", backend_id), ("frontend", frontend_id)):
                actual = json.loads(docker_text("inspect", identifier))[0]
                if (actual.get("Config", {}).get("Labels", {}).get("com.docker.compose.project") != control.project
                        or actual.get("Config", {}).get("Labels", {}).get("com.docker.compose.service") != service):
                    raise BuildControlError("Cannot pin binds of a foreign service")
                document["services"][service]["x-fullmag-daemon-binds"] = {
                    mount["Destination"]: mount["Source"] for mount in actual.get("Mounts", [])
                    if mount["Type"] == "bind"}
            control.write(operation["root"] + "/compose.json", document)
        _finish(control, operation, document, backend_id, frontend_id, selected, state,
                certificate_path, certificate, cache, toolchain, image, git_common, ledger_profile, args.port)



def _wait_for_publication(control, operation, backend_id, *, timeout=14400):
    """A previous succeeded package is not evidence that this start finished."""
    import fullmag_docker_runtime as runtime
    deadline = time.monotonic() + timeout
    started_at = None
    handoff_seen = False
    last_report = 0.0
    while time.monotonic() < deadline:
        actual = json.loads(docker_text("inspect", backend_id))[0]
        current_start = actual.get("State", {}).get("StartedAt")
        if started_at is None:
            started_at = current_start
            operation["receipt"]["backend_started_at"] = started_at
        elif current_start != started_at:
            raise BuildControlError("Backend incarnation changed during build observation")
        if not actual["State"]["Running"]:
            logs = docker_text("logs", "--tail", "200", backend_id, combined=True)
            control.write(operation["root"] + "/backend-failure-log.json", {"log": logs})
            raise BuildControlError("Backend exited during build; logs and volumes retained: " + logs[-4000:])
        if not handoff_seen:
            logs = docker_text("logs", "--since", started_at, "--tail", "200", backend_id, combined=True)
            handoff_seen = "phase=start state=handoff" in logs
            if handoff_seen:
                operation["receipt"]["backend_package_cache_hit"] = "phase=start state=cache-hit" in logs
                control.write(operation["root"] + "/handoff-log.json", {"started_at": started_at, "log": logs})
        if handoff_seen:
            raw = docker_capture("exec", backend_id, "/usr/local/bin/python3", "-c",
                runtime._BACKEND_BUILD_DOCUMENTS_SCRIPT)
            observed = json.loads(raw.stdout)
            receipt, provenance = observed["receipt"]["value"], observed["provenance"]["value"]
            if (receipt.get("state") != "succeeded" or provenance.get("state") != "succeeded"
                    or provenance.get("build_receipt_sha256") != observed["receipt"]["sha256"]):
                raise BuildControlError("Current handoff has no matching succeeded package/provenance")
            return receipt, provenance
        if time.monotonic() - last_report > 45:
            mirror_console("Backend is building in its persistent Compose service; Docker data retained.\n")
            last_report = time.monotonic()
        time.sleep(3)
    raise BuildControlError("Backend publication observation timed out; services and volumes retained")


def _finish(control, operation, document, backend_id, frontend_id, selected, state,
            certificate_path, certificate, cache, toolchain, image, git_common, ledger_profile, port):
    import fullmag_docker_runtime as runtime
    token = operation["receipt"]["attempt"]
    operator_probe_record = _operator_probe_record_from_retained(operation["receipt"], document)
    inputs = {"image_id": image, "toolchain_image_id": toolchain["image_id"],
              "guest_provenance_path": "/opt/fullmag/control/backend/runtime-provenance.json",
              **operator_probe_record}
    receipt, provenance = _wait_for_publication(control, operation, backend_id)
    control.write(operation["root"] + "/backend-build-receipt.json", receipt)
    control.write(operation["root"] + "/provenance.json", provenance)
    operation["receipt"]["config_sha256"] = hashlib.sha256(canonical(document)).hexdigest()
    operation["receipt"]["storage_profile"] = certificate["storage_profile"]
    operation["receipt"]["storage_delegation_reused"] = certificate.get("restart_verified") is True
    # Use the existing source/binary validation before rotating Windows admission.
    inputs.update(device_access=document["services"]["backend"]["environment"]["FULLMAG_DOCKER_DEVICE_ACCESS"],
        gpu_preflight="PASS" if document["services"]["backend"]["environment"]["FULLMAG_DOCKER_DEVICE_ACCESS"] == "gpu" else "NOT_REQUIRED",
        backend_cache=cache, package_root="/opt/fullmag/package", run_id=token,
        source_root=str(selected), git_common_dir=str(git_common), build_profile="dev",
        startup_helper_hashes={}, backend_start_receipt="docker-volume://" + control.volume + "/" + operation["root"] + "/receipt.json",
        helper_context="image-owned")
    # Keep the exact frozen operator record in the final operation receipt and
    # in the assembly input consumed by runtime admission.
    operation["receipt"].update(operator_probe_record)
    assembly = runtime._assembly_from_backend_start(inputs, receipt, provenance, container_id=backend_id)
    # An admitted delegation intentionally permits subsequent live builds.
    # Rotating it back to unverified after handoff races the serving process.
    if certificate.get("restart_verified") is not True:
        certificate = runtime._refresh_development_certificate(certificate, assembly, inputs)
        host = _session_host()
        host.write_bound_evidence(certificate_path, certificate)
        host.publish_evidence(state / host.OWNER_NAME, certificate)
    log_writer = lambda output: control.write(operation["root"] + "/storage-probe-log.json", {"log": output})
    if os.name == "nt":
        runtime._complete_backend_storage_preflight(docker_text, backend_id, state, certificate_path, certificate, None,
                                                   log_writer=log_writer)
    else:
        _session_host().complete_preflight(docker_text, backend_id, state, certificate_path, certificate,
                                           log_writer=log_writer)
    import docker_host_ledger as ledger
    verify_spec = ledger_profile["maintenance_document"]
    verify_name = "fullmag-ledger-verify-" + token
    output = compose_capture(verify_spec, "run", "--name", verify_name, "--no-deps", "host-ledger-maintenance", "verify", timeout=240)
    actual_verify = json.loads(docker_text("inspect", verify_name))
    if (len(actual_verify) != 1 or actual_verify[0].get("Image") != image
            or actual_verify[0].get("State", {}).get("Running")
            or actual_verify[0].get("State", {}).get("ExitCode") != 0
            or actual_verify[0].get("Config", {}).get("Labels", {}).get("com.docker.compose.project") != control.project):
        raise BuildControlError("Fresh host-ledger verification identity/outcome differs")
    host_receipt = ledger._parse_json_lines(output.decode(), ledger.HOST_RECEIPT_SCHEMA)
    ledger._validate_host_receipt(host_receipt, {"project_id": ledger_profile["project_id"],
        "mount_root": ledger_profile["mount_root"], "backing_image": ledger_profile["backing_image"]})
    ledger_profile["host_receipt"] = host_receipt
    # Preserve the successful probe before observing the application. A backend
    # exit during its attestation must not leave this known stopped helper
    # blocking the next managed start of the same Compose project.
    control.write(operation["root"] + "/ledger-verify-receipt.json", host_receipt)
    control.write(operation["root"] + "/ledger-verify-log.json",
                  {"log": docker_text("logs", verify_name, combined=True)})
    docker_capture("rm", actual_verify[0]["Id"])
    backend_service = document["services"]["backend"]
    if "x-fullmag-host-ledger-volume" in backend_service:
        ledger_profile = {**ledger_profile, "daemon_volume": backend_service["x-fullmag-host-ledger-volume"]}
    ledger_attestation = ledger.validate_container(json.loads(docker_text("inspect", backend_id))[0], ledger_profile, docker_text)
    control.write(operation["root"] + "/host-ledger-attestation.json", ledger_attestation)
    # Observe the existing incarnations; a readiness check must never run up
    # again or wait an hour after the supervisor has already closed admission.
    image_config = json.loads(docker_text("image", "inspect", image))[0]["Config"]
    readiness_deadline = time.monotonic() + 3900
    while time.monotonic() < readiness_deadline:
        services = json.loads(docker_text("inspect", backend_id, frontend_id))
        for service, observed in zip(("backend", "frontend"), services):
            _validate_retained_service(document, observed, service, image_config,
                expected_started_at=operation["receipt"]["backend_started_at"] if service == "backend" else None)
            if not observed.get("State", {}).get("Running"):
                raise BuildControlError("DEV service exited before readiness: " + service)
        process_receipt = json.loads(docker_text("exec", backend_id, "/usr/local/bin/python3", "-B", "-c", _PROCESS_RECEIPT_PROBE))
        if str(process_receipt.get("state", "")).startswith("failed"):
            logs = docker_text("logs", "--since", operation["receipt"]["backend_started_at"],
                               "--tail", "100", backend_id, combined=True)
            if "Startup or runtime failed; admission closed:" in logs:
                control.write(operation["root"] + "/process-failure.json", process_receipt)
                raise BuildControlError("Runtime admission failed; services retained: " + str(process_receipt.get("error", "unknown failure"))[:4096])
        if all(service.get("State", {}).get("Health", {}).get("Status") == "healthy" for service in services):
            break
        time.sleep(3)
    else:
        raise BuildControlError("API/frontend readiness timed out; services and Docker data retained")
    startup_environment = document["services"]["backend"]["environment"]
    if startup_environment.get("FULLMAG_STARTUP_ENABLED") == "1":
        startup_path = state / "startup-provenance.json"
        data = _session_host().read_owned_regular(startup_path, maximum=256 * 1024)
        if hashlib.sha256(data).hexdigest() != startup_environment["FULLMAG_STARTUP_PROVENANCE_SHA256"]:
            raise BuildControlError("Startup authorization changed after admission")
        authorization = json.loads(data)
        helper, hashes = _startup_helper(control, selected, image)
        if hashes["docker_startup_script.py"] != startup_environment["FULLMAG_STARTUP_HELPER_SHA256"]:
            raise BuildControlError("Startup helper differs from retained service")
        operation["receipt"]["startup"] = runtime._wait_for_startup_ready(state, authorization, startup_helper=helper)
    operation["receipt"].update(state="succeeded", backend_container=backend_id,
        frontend_container=frontend_id, url="http://127.0.0.1:" + str(port),
        source_commit=provenance["commit"], source_digest=provenance["source_digest"],
        source_snapshot_sha256=provenance["source_snapshot_sha256"],
        backend_build_receipt_sha256=provenance["build_receipt_sha256"])



def _validate_retained_service(document, actual, service, image_config, *, expected_started_at=None):
    """Reject configuration/mount drift and a replaced observed incarnation."""
    if expected_started_at is not None and actual.get("State", {}).get("StartedAt") != expected_started_at:
        raise BuildControlError("Backend incarnation changed during readiness observation")
    from run_managed_browser import host_path
    expected = document["services"][service]
    config, host = actual.get("Config", {}), actual.get("HostConfig", {})
    environment = dict(item.split("=", 1) for item in config.get("Env", []) if "=" in item)
    if any(environment.get(key) != str(value) for key, value in expected.get("environment", {}).items()):
        raise BuildControlError("Retained service environment differs: " + service)
    if any(config.get("Labels", {}).get(key) != value for key, value in expected.get("labels", {}).items()):
        raise BuildControlError("Retained service source/cache labels differ: " + service)
    for field, observed in (("hostname", config.get("Hostname")), ("user", config.get("User"))):
        if field in expected and expected[field] != observed:
            raise BuildControlError("Retained service configuration differs: " + service + "/" + field)
    for field, image_field in (("entrypoint", "Entrypoint"), ("command", "Cmd")):
        resolved = expected.get(field)
        if resolved is None:
            resolved = image_config.get(image_field)
        if (resolved or None) != (config.get(image_field) or None):
            raise BuildControlError("Retained service image command differs: " + service + "/" + field)
    if host.get("ReadonlyRootfs") is not True or host.get("Privileged") is not False:
        raise BuildControlError("Retained service isolation differs: " + service)
    mounts = {mount["Destination"]: mount for mount in actual.get("Mounts", [])}
    if len(mounts) != len(actual.get("Mounts", [])):
        raise BuildControlError("Retained service has duplicate mount destinations")
    targets = {mount["target"] for mount in expected["volumes"]}
    temporary = {value.split(":", 1)[0] for value in expected.get("tmpfs", [])}
    if (targets - set(mounts) or set(mounts) - targets - temporary
            or set(host.get("Tmpfs") or {}) != temporary
            or any(mounts[target].get("Type") != "tmpfs" for target in set(mounts) - targets)):
        raise BuildControlError("Retained service has missing or extra mounts: " + service)
    for mount in expected["volumes"]:
        observed = mounts[mount["target"]]
        if observed.get("Type") != mount["type"] or bool(observed.get("RW")) == bool(mount.get("read_only", False)):
            raise BuildControlError("Retained mount type/access differs: " + mount["target"])
        if mount["type"] == "volume":
            name = document["volumes"][mount["source"]]["name"]
            if observed.get("Name") != name:
                raise BuildControlError("Retained named-volume identity differs: " + mount["target"])
        elif mount["type"] == "bind":
            pinned = expected.get("x-fullmag-daemon-binds", {}).get(mount["target"])
            matches = (observed["Source"] == pinned if pinned is not None else
                       host_path(observed["Source"]) == Path(mount["source"]).resolve())
            if not matches:
                raise BuildControlError("Retained source/runtime bind differs: " + mount["target"])


def _assert_private_restart_network(actual, ids, project):
    """Only the pinned frontend may expose this backend to browser commands."""
    backend = actual["backend"]
    if backend.get("HostConfig", {}).get("PortBindings") or backend.get("HostConfig", {}).get("NetworkMode") in {"host", "none"}:
        raise BuildControlError("Idle restart requires an unpublished private backend")
    networks = backend.get("NetworkSettings", {}).get("Networks", {})
    if len(networks) != 1:
        raise BuildControlError("Idle restart requires one private application bridge")
    observed = json.loads(docker_text("network", "inspect", next(iter(networks))))
    if (len(observed) != 1 or observed[0].get("Driver") != "bridge"
            or observed[0].get("Labels", {}).get("com.docker.compose.project") != project
            or set(observed[0].get("Containers", {})) - set(ids.values())):
        raise BuildControlError("Idle restart bridge has unknown consumers; no backend will be stopped")


def _read_cancelled_activation_bytes(control, relative, *, optional=False):
    """Read one bounded, immutable control-volume file with its raw bytes."""
    path = control.path(relative)
    script = control_read_script(path, _MAX_CANCELLED_ACTIVATION_RECORD_BYTES)
    result = bounded_capture(control.helper_args(script), data=b"", timeout=90)
    if optional and result.returncode == 44:
        return None
    if result.returncode:
        raise BuildControlError(
            f"Cannot read cancelled activation record {relative}: "
            + result.stderr.decode("utf-8", "replace")[-2048:]
        )
    raw = bytes(result.stdout)
    if len(raw) > _MAX_CANCELLED_ACTIVATION_RECORD_BYTES:
        raise BuildControlError(f"Cancelled activation record {relative} exceeds its size bound")
    return raw


def _read_cancelled_activation_record(control, relative, *, optional=False):
    """Read one bounded, immutable control-volume JSON record with its bytes."""
    raw = _read_cancelled_activation_bytes(control, relative, optional=optional)
    if raw is None:
        return None, None

    def reject_duplicate_keys(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise BuildControlError(f"Cancelled activation record {relative} contains a duplicate key")
            value[key] = item
        return value

    try:
        document = json.loads(raw.decode("utf-8"), object_pairs_hook=reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError(f"Cancelled activation record {relative} is invalid JSON: {error}") from error
    if not isinstance(document, dict):
        raise BuildControlError(f"Cancelled activation record {relative} is not an object")
    return document, raw


def _cancelled_activation_probe_script() -> str:
    # This script is passed as Python argv to the already pinned backend. It
    # only reads bounded regular files while holding both writer locks. It does
    # not import application code and cannot publish a cancellation itself.
    return r'''import fcntl, hashlib, json, os, pathlib, stat, sys, time, urllib.error, urllib.request

MAX=8*1024*1024
run_id, task_id, request_id, source_sha, marker_path, store_root, ledger_root, expected_scene_revision = sys.argv[1:]

def fail(message): raise RuntimeError(message)
def regular(path, label, maximum=MAX):
    path=pathlib.Path(path)
    if not path.is_absolute() or ".." in path.parts or path.is_symlink(): fail(label+" path is unsafe")
    try: fd=os.open(path, os.O_RDONLY|getattr(os, "O_NOFOLLOW", 0))
    except OSError as error: raise RuntimeError(label+" cannot be opened") from error
    try:
        meta=os.fstat(fd)
        if not stat.S_ISREG(meta.st_mode) or meta.st_size>maximum: fail(label+" is not bounded regular")
        chunks=[]; total=0
        while total<=maximum:
            chunk=os.read(fd, min(65536, maximum+1-total))
            if not chunk: break
            chunks.append(chunk); total+=len(chunk)
        if total>maximum: fail(label+" exceeds size bound")
        return b"".join(chunks)
    finally: os.close(fd)
def obj(path, label):
    try: value=json.loads(regular(path,label).decode("utf-8"))
    except (UnicodeDecodeError,json.JSONDecodeError) as error: raise RuntimeError(label+" is invalid JSON") from error
    if not isinstance(value,dict): fail(label+" is not an object")
    return value
def digest(raw): return hashlib.sha256(raw).hexdigest()
def canon(value): return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(",",":"),allow_nan=False).encode("utf-8")
def lock(path,label):
    path=pathlib.Path(path)
    if not path.is_file() or path.is_symlink(): fail(label+" is missing")
    fd=os.open(path,os.O_RDWR|getattr(os,"O_NOFOLLOW",0))
    deadline=time.monotonic()+5
    while True:
        try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB); return fd
        except BlockingIOError as error:
            if time.monotonic()>=deadline: os.close(fd); raise RuntimeError(label+" remained busy") from error
            time.sleep(0.05)
        except OSError as error: os.close(fd); raise RuntimeError(label+" lock outcome is unknown") from error
def matching_json(root, label, predicate):
    root=pathlib.Path(root)
    if not root.exists(): return []
    if root.is_symlink() or not root.is_dir(): fail(label+" is not a directory")
    found=[]
    for current, dirs, files in os.walk(root,topdown=True,followlinks=False):
        current=pathlib.Path(current)
        for name in list(dirs):
            if (current/name).is_symlink(): fail(label+" contains a symlink")
        for name in files:
            path=current/name
            if path.is_symlink() or not path.is_file(): fail(label+" contains an invalid file")
            value=obj(path,label+" record")
            if predicate(value): found.append(str(path))
    return found
def ensure_empty_tree(root,label):
    root=pathlib.Path(root)
    if not root.exists(): return
    if root.is_symlink() or not root.is_dir(): fail(label+" is not a directory")
    for current, dirs, files in os.walk(root,topdown=True,followlinks=False):
        current=pathlib.Path(current)
        for name in list(dirs):
            if (current/name).is_symlink(): fail(label+" contains a symlink")
        for name in files:
            path=current/name
            if path.is_symlink() or not path.is_file(): fail(label+" contains an invalid file")
            fail(label+" contains a durable record")
def api_get(path,label):
    request=urllib.request.Request("http://127.0.0.1:8081"+path,headers={"Accept":"application/json","Host":"localhost"})
    try:
        with urllib.request.urlopen(request,timeout=5) as response:
            data=response.read(MAX+1)
            if len(data)>MAX: fail(label+" response exceeds size bound")
            if response.status!=200: fail(label+" returned HTTP "+str(response.status))
            value=json.loads(data.decode("utf-8"))
            if not isinstance(value,dict): fail(label+" response is not an object")
            return value,response.headers.get("x-fullmag-api-instance"),digest(data)
    except urllib.error.HTTPError as error:
        try: error.read(MAX+1)
        except OSError: pass
        fail(label+" returned HTTP "+str(error.code))
    except (OSError,urllib.error.URLError,UnicodeDecodeError,json.JSONDecodeError) as error:
        raise RuntimeError(label+" cannot be read") from error

store=pathlib.Path(store_root)
ledger=pathlib.Path(ledger_root)
if (not store.is_absolute() or ".." in store.parts or store.is_symlink()
        or not ledger.is_absolute() or ".." in ledger.parts or ledger.is_symlink()): fail("probe roots are unsafe")
ledger_fd=None
try:
    ledger_fd=lock(ledger/"WRITER.lock","host ledger writer lock")
    store_fd=lock(store/"WRITER.lock","accepted store writer lock")
    run=store/"runs"/run_id
    intent_path=run/"run_intent.json"
    catalog_path=run/"run_catalog.json"
    cancellation_path=run/"task_cancellation_intents"/(task_id+".json")
    intent_raw=regular(intent_path,"accepted RunIntent")
    catalog_raw=regular(catalog_path,"run catalog")
    cancellation_raw=regular(cancellation_path,"cancellation intent")
    intent=obj(intent_path,"accepted RunIntent")
    catalog=obj(catalog_path,"run catalog")
    cancellation=obj(cancellation_path,"cancellation intent")
    if intent.get("schema_version")!="run_intent.v1" or intent.get("run_id")!=run_id: fail("RunIntent identity/schema differs")
    expected_intent_key="live-http-"+digest(request_id.encode("utf-8"))
    if intent.get("idempotency_key")!=expected_intent_key: fail("RunIntent idempotency identity is not bound to the startup request")
    if not isinstance(intent.get("payload_sha256"),str) or intent.get("payload_sha256")!=digest(canon(intent.get("specification"))): fail("RunIntent payload digest differs")
    specification=intent.get("specification")
    if not isinstance(specification,dict): fail("RunIntent specification is not an object")
    parameters=specification.get("parameters")
    if not isinstance(parameters,dict): fail("RunIntent parameters are missing")
    live=parameters.get("live_workspace")
    if not isinstance(live,dict): fail("RunIntent live workspace binding is missing")
    api_instance_id=live.get("api_instance_id")
    session_id=live.get("session_id")
    session_epoch=live.get("session_epoch")
    scene_revision=live.get("scene_revision")
    if (not isinstance(api_instance_id,str) or not api_instance_id
            or not isinstance(session_id,str) or not session_id
            or not isinstance(session_epoch,int) or isinstance(session_epoch,bool) or session_epoch<0
            or not isinstance(scene_revision,int) or isinstance(scene_revision,bool) or scene_revision<0):
        fail("RunIntent live workspace identity is malformed")
    if (live.get("command_id")!=request_id
            or live.get("request_idempotency_key")!=request_id
            or live.get("startup_source_sha256")!=source_sha):
        fail("RunIntent live workspace request/source binding differs")
    command=live.get("command")
    if (not isinstance(command,dict) or command.get("kind")!="startup_script"
            or command.get("request_id")!=request_id or command.get("source_sha256")!=source_sha):
        fail("RunIntent live workspace startup command differs")
    policy=parameters.get("fullmag.accepted_run_start")
    if (not isinstance(policy,dict) or policy.get("schema_version")!="accepted_run_start_policy.v1"
            or policy.get("mode")!="manual"):
        fail("RunIntent accepted start policy is not manual")
    if catalog.get("schema_version")!="run_catalog.v1" or catalog.get("run_id")!=run_id or not isinstance(catalog.get("revision"),int) or catalog.get("revision",0)<=0: fail("run catalog identity/schema differs")
    tasks=catalog.get("tasks")
    if not isinstance(tasks,list) or not tasks: fail("run catalog has no tasks")
    target=None
    task_ids=set()
    for task in tasks:
        if not isinstance(task,dict) or not isinstance(task.get("task_id"),str): fail("run catalog task is malformed")
        if task.get("task_id") in task_ids: fail("run catalog contains duplicate task identity")
        task_ids.add(task.get("task_id"))
        if task.get("lifecycle")!="cancelled": fail("run catalog still has a non-cancelled task")
        for key in ("attempt_id","resource_id","resolved_input_fingerprint","coordinator_watermark","coordinator_genesis"):
            if task.get(key) is not None: fail("run catalog retains an owner on a cancelled task")
        if task.get("task_id")==task_id: target=task
    if target is None: fail("target task is missing from the run catalog")
    if cancellation.get("schema_version")!="task_cancellation_intent.v1" or cancellation.get("run_id")!=run_id: fail("cancellation intent identity/schema differs")
    if cancellation.get("task",{}).get("task_id")!=task_id: fail("cancellation intent task differs")
    if cancellation.get("task",{}).get("lifecycle") not in {"accepted","queued"}: fail("cancellation intent was not pre-claim")
    if cancellation.get("task",{}).get("input_fingerprint")!=target.get("input_fingerprint"): fail("cancellation intent input scope differs")
    if cancellation.get("expected_catalog_revision",0)>catalog.get("revision",0): fail("cancellation intent revision is ahead of catalog")
    semantic={k:cancellation.get(k) for k in ("schema_version","cancellation_id","run_id","expected_catalog_revision","task","reason")}
    if cancellation.get("request_sha256")!=digest(canon(semantic)): fail("cancellation intent digest differs")
    if cancellation.get("cancellation_id") is None: fail("cancellation identity is missing")

    ensure_empty_tree(run/"task_admissions","cancelled run task admissions")
    for name in ("task_preparation_receipts", "accepted_stage_preparation_receipts"):
        paths=run/name
        ensure_empty_tree(paths, "task preparation receipts")
    for name in ("preparation_process_launches", "preparation_process_exit_receipts"):
        matches=matching_json(run/name,"preparation process records",lambda value: value.get("run_id")==run_id and value.get("task_id") in task_ids)
        if matches: fail("task has durable preparation process records")
    prep_matches=matching_json(run/"preparation_resource_leases","preparation resource leases",lambda value: value.get("run_id")==run_id and value.get("task_id") in task_ids)
    if prep_matches: fail("task has a durable preparation lease")
    solver_matches=matching_json(run/"resource_leases","solver resource leases",lambda value: value.get("run_id")==run_id and value.get("task_id") in task_ids and value.get("state")!="released")
    if solver_matches: fail("task has an active or uncertain solver lease")

    ledger_raw=regular(ledger/"HOST_RESOURCE_LEDGER.json","host resource ledger")
    ledger_doc=json.loads(ledger_raw)
    reservations=ledger_doc.get("reservations")
    if not isinstance(reservations,list): fail("host resource ledger reservations are missing")
    matching=[]
    for row in reservations:
        if not isinstance(row,dict): fail("host resource ledger reservation is malformed")
        identity=row.get("identity")
        if isinstance(identity,dict) and identity.get("run_id")==run_id and identity.get("task_id") in task_ids:
            matching.append(row)
            if row.get("state")!="released": fail("host resource ledger still holds the cancelled task")

    expected_scene_revision=int(expected_scene_revision)
    marker_raw=regular(marker_path,"startup activation marker")
    marker=obj(marker_path,"startup activation marker")
    expected_key=hashlib.sha256(request_id.encode("utf-8")).hexdigest()
    expected_path="/opt/fullmag/control/backend/script-activation-"+expected_key+"/activation.json"
    if marker_path!=expected_path: fail("startup activation marker path differs from request")
    if marker.get("schema")!="fullmag.docker-startup-activation-receipt.v1" or marker.get("state")!="started": fail("startup activation marker is not the unchanged started marker")
    if marker.get("request_id")!=request_id or marker.get("source_sha256")!=source_sha: fail("startup activation marker request/source fence differs")
    auth=marker.get("authorization")
    if not isinstance(auth,dict) or auth.get("request_id")!=request_id or auth.get("source_sha256")!=source_sha: fail("startup activation authorization fence differs")
    # The cancellation is terminal. Release writer leases before asking the
    # API for liveness: its native observer also needs those same writers.
    fcntl.flock(store_fd,fcntl.LOCK_UN); os.close(store_fd); store_fd=None
    fcntl.flock(ledger_fd,fcntl.LOCK_UN); os.close(ledger_fd); ledger_fd=None
    current_status,current_api_instance,current_status_sha256=api_get("/v2/sessions/current/status","current live session status")
    current_session=current_status.get("session")
    if not isinstance(current_session,dict): fail("current live session status has no session")
    if (current_session.get("session_id")!=session_id
            or not isinstance(current_session.get("created_at"),str)
            or not current_session["created_at"].isdigit()
            or current_session.get("session_epoch")!=session_id+"@"+current_session["created_at"]
            or current_session.get("request_scope_epoch")!=api_instance_id+":"+str(session_epoch)):
        fail("current live session identity differs from RunIntent")
    if current_api_instance!=api_instance_id: fail("current API instance differs from RunIntent")
    current_document, current_document_instance, _ = api_get("/v2/sessions/current", "current session")
    if (current_document.get("current") is not True
            or current_document.get("session_id") != session_id
            or current_document.get("script", {}).get("sha256") != source_sha
            or current_document_instance != api_instance_id):
        fail("current session script identity differs from the cancelled activation")
    run_request=urllib.request.Request("http://127.0.0.1:8081/v2/sessions/current/simulation/runs/current",headers={"Accept":"application/json","Host":"localhost"})
    try:
        with urllib.request.urlopen(run_request,timeout=5) as response:
            fail("current session still has an in-memory run")
    except urllib.error.HTTPError as error:
        if error.code != 404: fail("current run absence is not confirmed")
        if error.headers.get("x-fullmag-api-instance") != api_instance_id:
            fail("current run API instance differs")
        error.read(MAX+1)
    except (OSError,urllib.error.URLError) as error:
        raise RuntimeError("current run absence cannot be read") from error
    scene, _, _ = api_get("/v2/sessions/current/model/scene", "current live scene")
    observed_scene_revision=scene.get("revision")
    if observed_scene_revision is None: observed_scene_revision=scene.get("scene_revision")
    if observed_scene_revision!=expected_scene_revision or observed_scene_revision!=scene_revision:
        fail("current API scene revision differs from the accepted scene")
    queue, _, _ = api_get("/v2/platform/compute/queue", "compute queue")
    if queue.get("schema_version")!="compute_queue.v1" or queue.get("items")!=[]:
        fail("compute queue is not empty")
    runtime, _, _ = api_get("/v2/platform/runtime-service", "native runtime service")
    reason=runtime.get("reason")
    if (runtime.get("configured") is not True or runtime.get("state")!="ready"
            or not isinstance(reason,dict) or reason.get("code")!="service_ready"):
        fail("native runtime service is not ready")
    health, _, _ = api_get("/v2/platform/health", "platform health")
    if health.get("status")!="ok" or health.get("active_session") is not True:
        fail("cancelled activation requires the pinned stale active session")
    if matching: fail("host resource ledger retains a cancelled task reservation")
    print(json.dumps({"schema":"fullmag.docker-activation-cancel-probe.v1","run_id":run_id,"task_id":task_id,"request_id":request_id,"source_sha256":source_sha,"catalog_revision":catalog["revision"],"cancellation_id":cancellation["cancellation_id"],"run_intent_sha256":digest(intent_raw),"run_catalog_sha256":digest(catalog_raw),"cancellation_intent_sha256":digest(cancellation_raw),"activation_marker_sha256":digest(marker_raw),"host_ledger_sha256":digest(ledger_raw),"matching_reservations":len(matching),"task_count":len(tasks),"live_api_instance_id":api_instance_id,"live_session_id":session_id,"live_session_epoch":session_epoch,"live_scene_revision":scene_revision,"live_workspace_sha256":digest(canon(live)),"current_session_sha256":current_status_sha256,"scene":scene,"compute_queue":queue,"runtime_service":runtime,"health":health},sort_keys=True))
finally:
    if ledger_fd is not None: fcntl.flock(ledger_fd,fcntl.LOCK_UN); os.close(ledger_fd)
    if "store_fd" in locals() and store_fd is not None: fcntl.flock(store_fd,fcntl.LOCK_UN); os.close(store_fd)
'''



def _cancelled_activation_store_probe(
    backend_id, *, run_id, task_id, request_id, source_sha256, marker_path,
    expected_scene_revision, environment,
):
    """Recheck cancelled store ownership and the live API from the image.

    Writer locks protect the bounded durable snapshot and are released before
    HTTP liveness checks. Cancelled tasks cannot acquire new native owners.
    The caller repeats this check after stopping the private frontend.
    """
    store_root = environment.get("FULLMAG_RUNS_ROOT", "/state/runs/docker-all") + "/session-store"
    ledger_root = environment.get("FULLMAG_HOST_LEDGER_ROOT", "/host-ledger/ledger")
    result = docker_capture(
        "exec", backend_id, "/usr/local/bin/python3", "-B", "-c",
        _cancelled_activation_probe_script(),
        run_id, task_id, request_id, source_sha256, marker_path,
        store_root, ledger_root, str(expected_scene_revision),
        timeout=90, allow_failure=True,
    )
    if result.returncode:
        raise BuildControlError(
            "Cancelled activation store preflight failed: "
            + result.stderr.decode("utf-8", "replace")[-4096:]
        )
    try:
        value = json.loads(result.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError("Cancelled activation store preflight returned invalid JSON") from error
    if not isinstance(value, dict) or value.get("schema") != "fullmag.docker-activation-cancel-probe.v1":
        raise BuildControlError("Cancelled activation store preflight returned an invalid schema")
    return value



def _cancelled_activation_sha(value, label):
    if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None:
        raise BuildControlError(f"Cancelled activation {label} is not a SHA-256 digest")
    return value


def _cancelled_activation_id(value, label, *, request=False):
    pattern = r"[A-Za-z0-9][A-Za-z0-9._:-]{0,199}" if request else r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}"
    if not isinstance(value, str) or re.fullmatch(pattern, value) is None or value in {".", ".."}:
        raise BuildControlError(f"Cancelled activation {label} is not a portable identifier")
    if not request and value.endswith("."):
        raise BuildControlError(f"Cancelled activation {label} is not a portable identifier")
    return value


def _validate_cancelled_activation_preflight(
    control, previous_root, previous, document, selected, config_sha256, backend_id, environment,
    *, require_quiesced_activation=True,
):
    """Accept the stale active-session exception only for one immutable proof."""
    current, current_raw = _read_cancelled_activation_record(control, "activation/current.json")
    if current is None or current_raw is None:
        raise BuildControlError("Restart has no accepted-then-cancelled activation proof")
    if (current.get("schema") != "fullmag.docker-build-operation.v1"
            or current.get("phase") != "activation"
            or current.get("compose_project") != control.project
            or current.get("control_volume") != control.volume
            or current.get("state") != "failed-confirmed"
            or current.get("activation_state") != "accepted-then-cancelled"):
        raise BuildControlError("Current activation is not a failed accepted-then-cancelled terminal")
    activation_attempt = current.get("attempt")
    if (not isinstance(activation_attempt, str)
            or _CANCELLED_ACTIVATION_ATTEMPT.fullmatch(activation_attempt) is None):
        raise BuildControlError("Current cancelled activation attempt is invalid")
    terminal, terminal_raw = _read_cancelled_activation_record(
        control, f"activation/attempts/{activation_attempt}/terminal.json"
    )
    if terminal_raw != current_raw or terminal != current:
        raise BuildControlError("Current activation pointer differs from its immutable terminal")
    proof, proof_raw = _read_cancelled_activation_record(
        control, f"activation/attempts/{activation_attempt}/accepted-then-cancelled.json"
    )
    if proof is None or proof_raw is None:
        raise BuildControlError("Accepted-then-cancelled activation proof is missing")
    if (proof.get("schema") != _CANCELLED_ACTIVATION_SCHEMA
            or proof.get("state") != "accepted-then-cancelled"):
        raise BuildControlError("Accepted-then-cancelled activation proof schema/state differs")
    proof_sha256 = hashlib.sha256(proof_raw).hexdigest()
    if current.get("cancellation_proof_sha256") != proof_sha256:
        raise BuildControlError("Current activation proof digest differs")

    inputs = current.get("inputs")
    if not isinstance(inputs, Mapping):
        raise BuildControlError("Cancelled activation inputs are missing")
    previous_inputs = previous.get("inputs")
    image_id = previous_inputs.get("image_id") if isinstance(previous_inputs, Mapping) else None
    development_attempt = previous_root.rsplit("/", 1)[-1]
    expected = {
        "activation_attempt": activation_attempt,
        "development_attempt": development_attempt,
        "compose_project": control.project,
        "config_sha256": config_sha256,
        "source_root": str(selected),
        "image_id": image_id,
        "backend_container": backend_id,
    }
    for key, value in expected.items():
        if proof.get(key) != value:
            raise BuildControlError(f"Cancelled activation proof {key} differs")
    for key, value in {
        "development_attempt": development_attempt,
        "config_sha256": config_sha256,
        "source_root": str(selected),
        "backend_container": backend_id,
        "image_id": image_id,
    }.items():
        if inputs.get(key) != value:
            raise BuildControlError(f"Cancelled activation input/{key} differs")

    request_id = proof.get("request_id")
    source_sha256 = proof.get("source_sha256")
    run_id = proof.get("run_id")
    task_id = proof.get("task_id")
    cancellation_id = proof.get("cancellation_id")
    _cancelled_activation_id(request_id, "request_id", request=True)
    _cancelled_activation_sha(source_sha256, "source_sha256")
    _cancelled_activation_id(run_id, "run_id")
    _cancelled_activation_id(task_id, "task_id")
    _cancelled_activation_id(cancellation_id, "cancellation_id")
    if inputs.get("request_id") != request_id or inputs.get("source_sha256") != source_sha256:
        raise BuildControlError("Cancelled activation input request/source differs")
    for key, value in {"run_id": run_id, "task_id": task_id, "cancellation_id": cancellation_id}.items():
        if current.get(key) != value:
            raise BuildControlError(f"Current activation {key} differs")

    expected_key = hashlib.sha256(request_id.encode("utf-8")).hexdigest()
    expected_marker = "/opt/fullmag/control/backend/script-activation-" + expected_key + "/activation.json"
    if (inputs.get("activation_receipt_path") != expected_marker
            or inputs.get("activation_receipt_key") != expected_key):
        raise BuildControlError("Cancelled activation marker path is not request-bound")
    # The service may not carry the wrapper's receipt key.  The immutable
    # activation input and image-side marker are the authorization boundary.

    for key in (
        "config_sha256", "source_sha256", "unknown_receipt_sha256",
        "activation_marker_sha256", "run_intent_sha256", "run_catalog_sha256",
        "cancellation_intent_sha256", "host_ledger_sha256", "live_workspace_sha256",
        "current_session_sha256", "probe_sha256",
    ):
        _cancelled_activation_sha(proof.get(key), "proof " + key)
    for key in ("live_api_instance_id", "live_session_id"):
        if not isinstance(proof.get(key), str) or not proof[key]:
            raise BuildControlError(f"Cancelled activation proof {key} is missing")
    for key in ("live_session_epoch", "live_scene_revision", "catalog_revision"):
        value = proof.get(key)
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            raise BuildControlError(f"Cancelled activation proof {key} is invalid")
    if proof["catalog_revision"] <= 0:
        raise BuildControlError("Cancelled activation proof catalog_revision is invalid")
    helper_name = proof.get("helper_container")
    if not isinstance(helper_name, str) or helper_name != "fullmag-control-" + activation_attempt:
        raise BuildControlError("Cancelled activation proof helper identity differs")
    helper_id = proof.get("helper_container_id")
    if not isinstance(helper_id, str) or re.fullmatch(r"[0-9a-f]{64}", helper_id) is None:
        raise BuildControlError("Cancelled activation proof helper container id is invalid")

    if require_quiesced_activation and _read_cancelled_activation_bytes(control, "active", optional=True) is not None:
        raise BuildControlError("Original accepted activation helper still holds the control lease")
    fresh_probe = _cancelled_activation_store_probe(
        backend_id, run_id=run_id, task_id=task_id, request_id=request_id,
        source_sha256=source_sha256, marker_path=expected_marker,
        expected_scene_revision=proof["live_scene_revision"], environment=environment,
    )
    for key, value in {
        "run_id": run_id, "task_id": task_id, "request_id": request_id,
        "source_sha256": source_sha256,
        "catalog_revision": proof["catalog_revision"],
        "cancellation_id": cancellation_id,
        "run_intent_sha256": proof["run_intent_sha256"],
        "run_catalog_sha256": proof["run_catalog_sha256"],
        "cancellation_intent_sha256": proof["cancellation_intent_sha256"],
        "activation_marker_sha256": proof["activation_marker_sha256"],
        "live_api_instance_id": proof["live_api_instance_id"],
        "live_session_id": proof["live_session_id"],
        "live_session_epoch": proof["live_session_epoch"],
        "live_scene_revision": proof["live_scene_revision"],
        "live_workspace_sha256": proof["live_workspace_sha256"],
        "matching_reservations": 0,
    }.items():
        if fresh_probe.get(key) != value:
            raise BuildControlError(f"Fresh cancelled activation probe {key} differs")
    if fresh_probe.get("schema") != "fullmag.docker-activation-cancel-probe.v1":
        raise BuildControlError("Fresh cancelled activation probe schema differs")
    # Heartbeats and other worktrees legitimately change these snapshots.
    # Immutable run/catalog/cancellation/marker identity was checked above.
    for key in ("host_ledger_sha256", "current_session_sha256"):
        _cancelled_activation_sha(fresh_probe.get(key), "fresh probe " + key)
    if fresh_probe.get("compute_queue", {}).get("items") != []:
        raise BuildControlError("Fresh cancelled activation probe found queued compute")
    runtime = fresh_probe.get("runtime_service")
    if (not isinstance(runtime, Mapping) or runtime.get("configured") is not True
            or runtime.get("state") != "ready"):
        raise BuildControlError("Fresh cancelled activation probe found an unready runtime")
    health = fresh_probe.get("health")
    if not isinstance(health, Mapping) or health.get("status") != "ok" or health.get("active_session") is not True:
        raise BuildControlError("Fresh cancelled activation probe lost the pinned active session")
    return {"proof_sha256": proof_sha256, "probe": fresh_probe, "runtime": fresh_probe}


def _retained_startup_enabled(container):
    """Match the image entrypoint's opt-in startup rule using effective env."""
    environment = dict(item.split("=", 1) for item in container.get("Config", {}).get("Env", []) if "=" in item)
    value = environment.get("FULLMAG_STARTUP_ENABLED", "0")
    if value not in {"0", "1"}:
        raise BuildControlError("Retained startup activation setting is invalid")
    return value == "1"


def restart_idle(args):
    return _retained_operation(args, recreate_services=False, restart_idle_service=True)


def stop_idle(args):
    """Drain the exact idle backend before managed service recreation."""
    return _retained_operation(args, recreate_services=False, restart_idle_service=True, stop_after_drain=True)


def recreate(args):
    return _retained_operation(args, recreate_services=True)


def resume(args):
    return _retained_operation(args, recreate_services=False)


def _read_runtime_config_digest(control):
    """Read the current native config while holding the runtime owner lock."""

    config_path = control.path("runtime-control/runtime-service/docker-all.json")
    lock_path = control.path("runtime-control/runtime-services/OWNER.lock")
    config_parent = str(PurePosixPath(config_path).parent)
    lock_parent = str(PurePosixPath(lock_path).parent)
    script = (
        f"test -e '{lock_path}'; test ! -L '{lock_path}'; test -f '{lock_path}'; "
        f"test $(stat -c %h '{lock_path}') = 1; "
        f"test \"$(readlink -f '{lock_parent}')\" = '{lock_parent}'; "
        f"exec 9<> '{lock_path}'; flock -n 9; "
        f"test -e '{config_path}'; test ! -L '{config_path}'; test -f '{config_path}'; "
        f"test $(stat -c %h '{config_path}') = 1; "
        f"test \"$(readlink -f '{config_parent}')\" = '{config_parent}'; "
        f"head -c {_MAX_RUNTIME_CONFIG_BYTES + 1} '{config_path}'"
    )
    result = bounded_capture(control.helper_args(script), data=b"", timeout=90)
    if result.returncode:
        raise BuildControlError(
            "Native runtime configuration could not be pinned under OWNER.lock: "
            + result.stderr.decode("utf-8", "replace")[-2048:]
        )
    raw = bytes(result.stdout)
    if not raw or len(raw) > _MAX_RUNTIME_CONFIG_BYTES:
        raise BuildControlError("Native runtime configuration exceeds its bounded size")
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError("Native runtime configuration is not valid JSON") from error
    if not isinstance(value, Mapping):
        raise BuildControlError("Native runtime configuration is not an object")
    digest = hashlib.sha256(raw).hexdigest()
    if _SHA256.fullmatch(digest) is None:
        raise BuildControlError("Native runtime configuration digest is invalid")
    return digest


def _validate_completed_recovery_receipt(control, authorization, recovery_module):
    """Return true only for a complete receipt bound to the old authorization."""

    receipt_relative = (
        "runtime-control/runtime-services/container-recovery/"
        + authorization["native_request_sha256"] + "/receipt.json"
    )
    receipt_raw = recovery_module._control_bytes(control, receipt_relative, optional=True)
    if receipt_raw is None:
        return False
    receipt = recovery_module._parse_json(receipt_raw, "retained recovery receipt")
    if receipt.get("schema_version") != "runtime_service_container_recovery.v1":
        raise BuildControlError("Completed recovery receipt schema is unsupported")
    if receipt.get("status") != "recovered":
        # A prepared/pending receipt still owns the original capability.  It
        # must be carried unchanged so PID 1 can finish its authenticated
        # recovery protocol on the next start.
        return False
    if receipt.get("outcome") != "empty_namespace_recovered":
        raise BuildControlError("Completed recovery receipt has an unsupported outcome")
    request_relative = authorization["native_request_path"][len("/opt/fullmag/control/"):]
    request_raw = recovery_module._control_bytes(control, request_relative)
    if hashlib.sha256(request_raw).hexdigest() != authorization["native_request_sha256"]:
        raise BuildControlError("Completed recovery request digest differs from authorization")
    request = recovery_module.validate_request(
        recovery_module._parse_json(request_raw, "retained recovery request")
    )
    for field in ("request_id", "config_sha256", "owner_sha256"):
        if request.get(field) != authorization[field]:
            raise BuildControlError("Completed recovery request differs from authorization")
    attestation_relative = authorization["attestation_path"][len("/opt/fullmag/control/"):]
    attestation_raw = recovery_module._control_bytes(control, attestation_relative)
    attestation = recovery_module.validate_attestation(
        recovery_module._parse_json(attestation_raw, "retained recovery attestation"),
        request,
        authorization["native_request_sha256"],
    )
    if hashlib.sha256(canonical(attestation)).hexdigest() != authorization["attestation_sha256"]:
        raise BuildControlError("Completed recovery attestation digest differs from authorization")
    manifest_relative = authorization["manifest_path"][len("/opt/fullmag/control/"):]
    manifest_raw = recovery_module._control_bytes(control, manifest_relative)
    if hashlib.sha256(manifest_raw).hexdigest() != authorization["manifest_sha256"]:
        raise BuildControlError("Completed recovery manifest digest differs from authorization")
    expected = {
        "request_id": request["request_id"],
        "request_sha256": authorization["native_request_sha256"],
        "config_sha256": request["config_sha256"],
        "target_id": "docker-all",
        "owner_sha256_before": request["owner_sha256"],
        "owner_state_before": request["expected_owner"]["state"],
        "owner_state_after": "failed",
        "store_root_sha256": request["store_root_sha256"],
        "application": request["application"],
        "ledger_root_sha256": request["ledger_root_sha256"],
        "ledger_snapshot_sha256": request["ledger_snapshot_sha256"],
        "attestation_sha256": authorization["attestation_sha256"],
        "docker_manifest_sha256": request["docker_manifest_sha256"],
        "prior_ready_owner_proof_sha256": request["prior_ready_owner_proof_sha256"],
        "device_release_mapping_sha256": request["device_release_mapping_sha256"],
    }
    if any(receipt.get(key) != value for key, value in expected.items()):
        raise BuildControlError("Completed recovery receipt differs from its authorization")
    owner_after = receipt.get("owner_sha256_after")
    if _SHA256.fullmatch(owner_after or "") is None or owner_after == request["owner_sha256"]:
        raise BuildControlError("Completed recovery receipt has no new failed-owner digest")
    for field, pattern in (
        ("historical_build_commit", re.compile(r"[0-9a-f]{40}\Z")),
        ("executor_build_commit", re.compile(r"[0-9a-f]{40}\Z")),
        ("historical_build_snapshot", _SHA256),
        ("executor_build_snapshot", _SHA256),
        ("archived_evidence_sha256", _SHA256),
    ):
        if pattern.fullmatch(receipt.get(field, "")) is None:
            raise BuildControlError("Completed recovery receipt has invalid " + field)
    return True


def _native_failed_stop_recovery_context(control, previous, *, backend_id, fresh_state):
    """Validate one managed native-failure stop journal for recreation.

    The legacy ``native-start-failure`` proof has no retained service owner.
    ``native-after-ready-failure`` is a separate, stricter proof: it carries
    the previous READY owner as an identity pin and may only recreate after
    the terminal receipt preserves that exact pin.  Neither route changes the
    owner state or releases a resource lease here; the proof is only carried
    into the next managed start.
    """

    if not isinstance(backend_id, str) or not _SHA256.fullmatch(backend_id):
        return None
    journal_path = "verification/stop-failed-" + backend_id + ".json"
    from docker_volume_stop_unadmitted import _control_bytes, _json
    journal_raw = _control_bytes(control, journal_path, optional=True)
    if journal_raw is None:
        return None
    journal = _json(journal_raw, "native failed-stop journal")
    if fresh_state:
        raise BuildControlError("Native failed-stop recovery requires the retained session storage")
    previous_inputs = previous.get("inputs")
    if not isinstance(previous_inputs, Mapping):
        raise BuildControlError("Native failed-stop recreation has no retained inputs")
    image_id = previous_inputs.get("image_id")
    if not isinstance(image_id, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
        raise BuildControlError("Native failed-stop recreation has no immutable image identity")
    failure_kind = journal.get("failure_kind")
    if (
        journal.get("schema") != _NATIVE_STOP_JOURNAL_SCHEMA
        or journal.get("state") != "stopped-confirmed"
        or failure_kind not in {"native-start-failure", "native-after-ready-failure"}
        or journal.get("container_id") != backend_id
        or journal.get("image_id") != image_id
        or type(journal.get("exit_code")) is not int
    ):
        raise BuildControlError("Native failed-stop journal is not the exact stopped backend proof")
    after_ready = failure_kind == "native-after-ready-failure"
    failure = journal.get("failure_receipt")
    if not isinstance(failure, Mapping):
        raise BuildControlError("Native failed-stop journal has no failed process receipt")
    process_sha = failure.get("sha256")
    if not isinstance(process_sha, str) or _SHA256.fullmatch(process_sha) is None:
        raise BuildControlError("Native failed-stop journal has an invalid failed process digest")
    failed_receipt = failure.get("receipt")
    probe = journal.get("native_failure_probe")
    if not isinstance(failed_receipt, Mapping) or not isinstance(probe, Mapping):
        raise BuildControlError("Native failed-stop journal has incomplete native failure evidence")
    if probe.get("process_receipt_sha256") != process_sha or probe.get("process_receipt") != failed_receipt:
        raise BuildControlError("Native failed-stop journal failed process evidence differs")
    from docker_volume_stop_failed import (
        _validate_native_after_ready_failure_probe,
        _validate_native_failure_probe,
    )
    validated = (
        _validate_native_after_ready_failure_probe(probe, process_sha)
        if after_ready
        else _validate_native_failure_probe(probe, process_sha)
    )

    terminal_raw = _control_bytes(control, "runtime-control/runtime-service/process-tree.json")
    terminal = _json(terminal_raw, "native failed-stop terminal process receipt")
    if terminal != journal.get("terminal_process_receipt"):
        raise BuildControlError("Native failed-stop terminal process receipt differs")
    if (
        terminal.get("schema") != "fullmag.docker-process-tree.v1"
        or terminal.get("state") != "shutdown_unknown"
        or "terminal_service_owner" in terminal
        or type(terminal.get("api_exit_code")) is not int
        or terminal.get("runtime_pid") is not None
    ):
        raise BuildControlError("Native failed-stop terminal process receipt is not canonical")
    if after_ready:
        retained_ready_owner = journal.get("retained_ready_owner")
        terminal_ready_owner = terminal.get("service_owner")
        if retained_ready_owner != validated["ready_owner"]:
            raise BuildControlError("Native failed-stop retained ready owner differs from its probe")
        if terminal_ready_owner != validated["ready_owner"]:
            raise BuildControlError("Native failed-stop terminal ready owner differs from its probe")
        if journal.get("terminal_retained_ready_owner") != terminal_ready_owner:
            raise BuildControlError("Native failed-stop terminal ready owner evidence differs")
    elif "service_owner" in terminal:
        raise BuildControlError("Native failed-stop terminal process receipt is not canonical")
    terminal_owner_raw = _control_bytes(control, "runtime-control/runtime-services/OWNER.json")
    terminal_owner = _json(terminal_owner_raw, "native failed-stop terminal owner")
    expected_owner = journal.get("terminal_failed_owner")
    owner_sha = hashlib.sha256(terminal_owner_raw).hexdigest()
    if (
        terminal_owner != expected_owner
        or (
            journal.get("terminal_failed_owner_sha256") is not None
            and journal.get("terminal_failed_owner_sha256") != owner_sha
        )
        or validated["probe"].get("failed_owner_sha256") != owner_sha
        or terminal_owner != validated["failed_owner"]
    ):
        raise BuildControlError("Native failed-stop failed owner changed after the stop proof")
    from docker_volume_activation_reconcile import (
        _namespace_attestation_path,
        _validate_namespace_attestation,
        _validate_stopped_backend,
    )
    namespace_relative = _namespace_attestation_path(backend_id)
    namespace_raw = _control_bytes(control, namespace_relative, optional=True)
    namespace_attestation = None
    if namespace_raw is not None:
        namespace_attestation = _validate_namespace_attestation(
            control,
            _json(namespace_raw, "stopped namespace attestation"),
            backend_id=backend_id,
            image_id=image_id,
            journal_raw=journal_raw,
            journal=journal,
            terminal_raw=terminal_raw,
            terminal=terminal,
            owner_raw=terminal_owner_raw,
            owner=terminal_owner,
            selected_source=previous_inputs["source_root"],
        )
    if isinstance(journal.get("container_state"), Mapping):
        _validate_stopped_backend(control, backend_id, image_id, journal=journal)
    elif namespace_attestation is None:
        raise BuildControlError("Legacy native stop journal requires a fresh namespace attestation")
    previous_config_sha256 = _read_runtime_config_digest(control)
    recorded_config = journal.get("previous_config_sha256")
    if recorded_config is not None and recorded_config != previous_config_sha256:
        raise BuildControlError("Native failed-stop runtime configuration digest differs")
    metadata = {
        "schema": _NATIVE_STOP_RECREATE_METADATA_SCHEMA,
        "failure_kind": failure_kind,
        "journal_sha256": hashlib.sha256(journal_raw).hexdigest(),
        "container_id": backend_id,
        "image_id": image_id,
        "failure_receipt_sha256": process_sha,
        "terminal_process_receipt_sha256": hashlib.sha256(terminal_raw).hexdigest(),
        "terminal_failed_owner_sha256": owner_sha,
        "previous_config_sha256": previous_config_sha256,
        "claim_pending": False,
    }
    if after_ready:
        metadata["retained_ready_owner"] = validated["ready_owner"]
    if namespace_attestation is not None:
        metadata["namespace_attestation_path"] = namespace_relative
        metadata["namespace_attestation_sha256"] = hashlib.sha256(namespace_raw).hexdigest()
    return {
        "previous_config_sha256": previous_config_sha256,
        "native_restart_metadata": metadata,
    }


def _retained_recovery_context(control, previous, document, *, fresh_state, backend_id=None):
    """Carry pending recovery authority, or consume a completed proof once.

    PID 1 still authenticates the native request and current owner before any
    recovery or service start. Pending authorization is carried unchanged;
    a completed recovery receipt is validated before its authority is dropped.
    A separate native-start-failure journal carries only reduced restart
    evidence and never mints a recovery authorization.
    """
    import docker_volume_container_recovery as recovery_module
    from docker_volume_container_recovery import (
        AUTHORIZATION_ENV, AUTHORIZATION_SHA_ENV, CONTROL_ROOT,
        _control_bytes, _parse_json, _relative_control_path,
        validate_runtime_authorization,
    )
    environment = document["services"]["backend"]["environment"]
    carried = {key: value for key, value in environment.items()
               if key.startswith("FULLMAG_CONTAINER_RECOVERY_")}
    metadata = previous.get("container_recovery")
    if not carried and metadata is None:
        return _native_failed_stop_recovery_context(
            control, previous, backend_id=backend_id or previous.get("backend_container"),
            fresh_state=fresh_state,
        ) or {}
    if fresh_state:
        raise BuildControlError("Pending container recovery must retain its original session storage")
    if set(carried) != {AUTHORIZATION_ENV, AUTHORIZATION_SHA_ENV} or not isinstance(metadata, Mapping):
        raise BuildControlError("Retained container recovery capability is incomplete")
    if previous.get("container_recovery_environment") != sorted(carried):
        raise BuildControlError("Retained container recovery environment differs from its receipt")
    path = carried[AUTHORIZATION_ENV]
    if not isinstance(path, str) or not path.startswith(CONTROL_ROOT + "/"):
        raise BuildControlError("Retained container recovery authorization escapes control volume")
    relative = _relative_control_path(path[len(CONTROL_ROOT) + 1:])
    raw = _control_bytes(control, relative)
    if raw is None:
        raise BuildControlError("Retained container recovery authorization is missing")
    digest = hashlib.sha256(raw).hexdigest()
    if digest != carried[AUTHORIZATION_SHA_ENV] or digest != metadata.get("authorization_sha256"):
        raise BuildControlError("Retained container recovery authorization digest differs")
    authorization = validate_runtime_authorization(_parse_json(raw, "retained runtime authorization"))
    if (authorization["compose_project"] != control.project
            or authorization["source_root"] != previous["inputs"]["source_root"]):
        raise BuildControlError("Retained container recovery source or project differs")
    expected = {
        "schema": "fullmag.container-recovery.v1",
        "request_id": authorization["request_id"],
        "request_sha256": authorization["native_request_sha256"],
        "attestation_sha256": authorization["attestation_sha256"],
        "manifest_sha256": authorization["manifest_sha256"],
        "authorization_sha256": digest,
        "stop_journal_sha256": authorization["prior_stop_journal_sha256"],
        "removed_container_ids": [authorization["backend_container_id"], authorization["frontend_container_id"]],
    }
    if metadata != expected:
        raise BuildControlError("Retained container recovery metadata differs from authorization")
    if _validate_completed_recovery_receipt(control, authorization, recovery_module):
        native_restart = _native_failed_stop_recovery_context(
            control, previous, backend_id=backend_id or previous.get("backend_container"),
            fresh_state=fresh_state,
        )
        if native_restart is not None:
            return native_restart
        # The first post-recovery Failed owner still needs the original
        # capability for its authorized configuration-generation rotation.
        # A completed receipt alone does not prove a later owner existed.
    return {"recovery_environment": _validate_recovery_environment(carried),
            "recovery_metadata": _validate_recovery_metadata(expected)}


def _retained_operation(args, *, recreate_services, restart_idle_service=False, stop_after_drain=False):
    """Resume observation/admission of one exact failed start; never restart the backend."""
    from docker_dev import _select_source, _compose_identity
    require_host()
    selected, layout = _select_source(Path(args.repo_root).resolve(strict=True), args.source_root)
    identity = _compose_identity(layout)
    from docker_build_control import toolchain_configuration
    configured = toolchain_configuration(selected, identity)
    control = BuildControl(identity, configured["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"])
    control.prepare()
    if not re.fullmatch(r"[0-9a-f]{32}", args.attempt):
        raise BuildControlError("Resume requires an exact attempt UUID")
    previous_root = "development/attempts/" + args.attempt
    previous = control.read(previous_root + "/terminal.json")
    allowed = {"failed-confirmed", "succeeded"} if recreate_services or restart_idle_service or getattr(args, "restart_backend", False) else {"failed-confirmed"}
    if previous.get("state") not in allowed or previous.get("compose_project") != control.project:
        raise BuildControlError("Retained start has no admissible terminal outcome")
    document = control.read(previous_root + "/compose.json")
    if hashlib.sha256(canonical(document)).hexdigest() != args.config_sha256 or document.get("name") != control.project:
        raise BuildControlError("Resume Compose identity/CAS differs")
    operator_probe_record = _operator_probe_record_from_retained(previous, document)
    image = previous["inputs"]["image_id"]
    if previous["inputs"]["source_root"] != str(selected):
        raise BuildControlError("Resume source selection differs")
    if recreate_services:
        policy = previous["inputs"].get("gpu_access_requested")
        if policy not in {"auto", "required", "disabled"}:
            raise BuildControlError("Recreation requires the retained GPU access intent")
        args.gpu_access = policy
    ids = {service: compose_capture(document, "ps", "--all", "--quiet", service).decode().strip()
           for service in ("backend", "frontend")}
    actual = {}
    image_config = json.loads(docker_text("image", "inspect", image))[0]["Config"]
    for service, identifier in ids.items():
        records = json.loads(docker_text("inspect", identifier))
        if len(records) != 1:
            raise BuildControlError("Ambiguous retained service")
        observed = actual[service] = records[0]
        labels = observed.get("Config", {}).get("Labels", {})
        if (observed.get("Image") != image or labels.get("com.docker.compose.project") != control.project
                or labels.get("com.docker.compose.service") != service
                or labels.get("org.fullmag.source.worktree-id") != identity["worktree_id"]):
            raise BuildControlError("Retained container ownership differs")
        recorded_id = previous.get(service + "_container")
        if recorded_id is not None and observed.get("Id") != recorded_id:
            raise BuildControlError("Recorded container incarnation differs")
        _validate_retained_service(document, observed, service, image_config)
    if restart_idle_service:
        if (not actual["backend"]["State"]["Running"]
                or actual["backend"]["State"].get("Health", {}).get("Status") != "healthy"):
            raise BuildControlError("Idle restart requires a healthy backend; an active build is never interrupted")
        state = storage.validate_path(Path(previous["state_root"]), layout["runtime_root"], "retained Windows sessions")
        certificate_path = _certificate_path(state)
        certificate = _retained_certificate(state, document)
        environment = document["services"]["backend"]["environment"]
        startup_enabled = _retained_startup_enabled(actual["backend"])
        if startup_enabled:
            raise BuildControlError("Startup activation requires dedicated recovery; idle restart will not repeat Solve")
        if _read_cancelled_activation_bytes(control, "active", optional=True) is not None:
            raise BuildControlError("Original accepted activation helper still holds the control lease")
        cache = control.read(previous_root + "/backend-cache.json")
        import docker_backend_volume_cache as cache_adapter
        cache_adapter.validate_container(actual["backend"], cache)
        ledger_profile = {"profile": "host-ledger-v1", "image_id": image, "environment": environment,
            "mount_root": environment["FULLMAG_HOST_LEDGER_MOUNT_ROOT"],
            "project_id": environment["FULLMAG_HOST_LEDGER_PROJECT_ID"],
            "backing_image": environment["FULLMAG_HOST_LEDGER_BACKING_IMAGE"],
            "host_receipt": control.read(previous_root + "/host-ledger.json"),
            "maintenance_document": control.read(previous_root + "/ledger-maintenance-compose.json")}
        with control.operation("iteration", {"source_root": str(selected), "image_id": image,
                                            "attempt": args.attempt, "config_sha256": args.config_sha256,
                                            **operator_probe_record}) as operation:
            operation["receipt"].update(operator_probe_record)
            _assert_private_restart_network(actual, ids, control.project)
            operation["daemon_pending"] = True
            docker_capture("stop", "--time", "60", ids["frontend"], timeout=90)
            operation["daemon_pending"] = False
            try:
                fresh = {service: json.loads(docker_text("inspect", identifier))[0]
                         for service, identifier in ids.items()}
                for service in ids:
                    if (fresh[service].get("Id") != actual[service].get("Id")
                            or fresh[service].get("State", {}).get("StartedAt")
                            != actual[service].get("State", {}).get("StartedAt")):
                        raise BuildControlError("Service incarnation changed during idle restart preflight")
                if (fresh["frontend"]["State"].get("Running") is not False
                        or fresh["backend"]["State"].get("Running") is not True):
                    raise BuildControlError("Frontend is not quiesced or backend is no longer running")
                _assert_private_restart_network(fresh, ids, control.project)
                probe = """import json,urllib.request
with urllib.request.urlopen('http://127.0.0.1:8081/v2/platform/health',timeout=5) as response:
 document=json.load(response)
 if (response.status!=200 or document.get('status')!='ok'
         or (document.get('active_session') is not False
             and document.get('active_session') is not True)):
  raise RuntimeError('Backend health is unknown; restart refused')
 print(json.dumps(document))
"""
                health = json.loads(docker_text("exec", ids["backend"], "/usr/local/bin/python3", "-B", "-c", probe))
                if health.get("status") != "ok":
                    raise BuildControlError("Backend health is not ready; idle restart refused")
                active_session = health.get("active_session")
                if active_session is True:
                    if startup_enabled:
                        raise BuildControlError("Backend has an active session; idle restart refused")
                    cancelled_activation = _validate_cancelled_activation_preflight(
                        control, previous_root, previous, document, selected, args.config_sha256,
                        ids["backend"], environment, require_quiesced_activation=False,
                    )
                    health = cancelled_activation["probe"]["health"]
                    operation["receipt"]["accepted_then_cancelled_proof_sha256"] = (
                        cancelled_activation["proof_sha256"]
                    )
                elif active_session is not False:
                    raise BuildControlError("Backend has an active or unknown session; idle restart refused")
            except Exception:
                operation["daemon_pending"] = True
                docker_capture("start", ids["frontend"], timeout=90)
                operation["daemon_pending"] = False
                raise
            control.write(operation["root"] + "/idle-preflight.json", health)
            control.write(operation["root"] + "/compose.json", document)
            operation["receipt"].update(state="restarting-idle-backend", state_root=str(state),
                backend_volumes=previous["backend_volumes"], frontend_volume=previous["frontend_volume"])
            operation["daemon_pending"] = True
            docker_capture("stop", "--time", "60", ids["backend"], timeout=90)
            stopped = json.loads(docker_text("inspect", ids["backend"]))[0]
            if (stopped.get("Id") != actual["backend"].get("Id")
                    or stopped.get("State", {}).get("StartedAt")
                    != actual["backend"].get("State", {}).get("StartedAt")
                    or stopped["State"].get("Running") is not False
                    or stopped["State"].get("OOMKilled") is not False
                    or stopped["State"].get("ExitCode") != 0):
                raise BuildControlError("Backend termination is not confirmed graceful; restart withheld")
            from docker_volume_stop_unadmitted import _read_terminal_process_receipt
            drained_raw, drained = _read_terminal_process_receipt(stopped, control)
            control.write(operation["root"] + "/backend-drain.json", {
                "schema": "fullmag.docker-idle-restart-drain.v1",
                "backend_container_id": ids["backend"],
                "process_receipt_sha256": hashlib.sha256(drained_raw).hexdigest(),
                "process_receipt": drained,
            })
            if stop_after_drain:
                operation["daemon_pending"] = False
                operation["receipt"].update(
                    state="succeeded", idle_backend_stopped=True,
                    backend_container=ids["backend"], frontend_container=ids["frontend"],
                    config_sha256=args.config_sha256,
                )
                return
            docker_capture("start", ids["backend"], timeout=90)
            docker_capture("start", ids["frontend"], timeout=90)
            operation["daemon_pending"] = False
            git_common = Path(next(m["source"] for m in document["services"]["backend"]["volumes"]
                                   if m["target"] == "/opt/fullmag/source-git"))
            _finish(control, operation, document, ids["backend"], ids["frontend"], selected, state,
                certificate_path, certificate, cache, {"image_id": environment["FULLMAG_TOOLCHAIN_IMAGE_ID"]},
                image, git_common, ledger_profile, args.port)
        return
    if recreate_services:
        if actual["backend"]["State"]["Running"]:
            raise BuildControlError("Recreation requires the backend stopped; an active build/runtime is never interrupted")
        if document["services"]["backend"]["environment"].get("FULLMAG_STARTUP_ENABLED") == "1":
            raise BuildControlError("Retained startup activation requires its dedicated recovery; recreation will not repeat Solve")
        state = storage.validate_path(Path(previous["state_root"]), layout["runtime_root"], "retained Windows sessions")
        certificate_path = _certificate_path(state)
        certificate = _retained_certificate(state, document)
        owner_path = state / _session_host().OWNER_NAME
        if certificate.get("image_id") != image:
            raise BuildControlError("Retained storage image differs")
        fresh_state = bool(getattr(args, "fresh_state", False))
        recovery_context = _retained_recovery_context(
            control, previous, document, fresh_state=fresh_state,
            backend_id=actual["backend"].get("Id"),
        )
        # Reconcile only the exact activation helper that still owns the
        # control lease.  The native failed-stop proof above authenticates the
        # stopped backend; the reconciler preserves the unknown activation
        # marker and only lets that helper release its own technical lease.
        from docker_volume_activation_reconcile import reconcile_unknown_activation
        reconciliation = reconcile_unknown_activation(
            control,
            previous=previous,
            document=document,
            selected_source=str(selected),
            config_sha256=args.config_sha256,
            image_id=image,
            backend_id=actual["backend"].get("Id"),
            native_restart_metadata=recovery_context.get("native_restart_metadata"),
            fresh_state=fresh_state,
        )
        accepted_reattach_context = {}
        if reconciliation is not None:
            if args.script is not None:
                raise BuildControlError(
                    "A retained accepted run cannot be recreated together with a new startup script"
                )
            from docker_volume_accepted_reattach import produce_accepted_reattach
            accepted_store_root = storage.validate_path(
                state / "runs" / "docker-all" / "session-store",
                state,
                "retained accepted session store",
            )
            produced = produce_accepted_reattach(
                control,
                store_root=accepted_store_root,
            )
            accepted_environment = _validate_accepted_reattach_environment(
                produced.get("environment")
            )
            accepted_pins = _validate_accepted_reattach_metadata(
                produced.get("pins"), accepted_environment
            )
            accepted_reattach_context = {
                "accepted_reattach_environment": accepted_environment,
                "accepted_reattach_metadata": accepted_pins,
            }
        if not fresh_state and not certificate.get("restart_verified"):
            raise BuildControlError("Unadmitted storage cannot rotate as an admitted runtime; use explicit --fresh-state to preserve the old root")
        # Exact recorded helper only; unknown group resources are never deleted.
        helper_ids = []
        for helper_name in ("fullmag-ledger-" + previous["attempt"], "fullmag-ledger-verify-" + previous["attempt"]):
            helper = docker_capture("inspect", helper_name, allow_failure=True)
            if not helper.returncode:
                helper_document = json.loads(helper.stdout)[0]
                labels = helper_document.get("Config", {}).get("Labels", {})
                if (helper_document.get("Image") != image or helper_document.get("State", {}).get("Running")
                        or labels.get("com.docker.compose.project") != control.project
                        or labels.get("com.docker.compose.service") != "host-ledger-maintenance"):
                    raise BuildControlError("Recorded ledger helper identity/outcome differs")
                helper_ids.append(helper_document["Id"])
        with control.operation("recreate-services", {"attempt": args.attempt, "config_sha256": args.config_sha256,
                                                      **operator_probe_record}) as operation:
            if recovery_context != _retained_recovery_context(
                control, previous, document, fresh_state=fresh_state,
                backend_id=actual["backend"].get("Id"),
            ):
                raise BuildControlError("Retained container recovery capability changed before recreation")
            operation["receipt"].update(operator_probe_record)
            if reconciliation is not None:
                operation["receipt"]["activation_reconciliation"] = {
                    key: reconciliation[key]
                    for key in (
                        "attempt", "activation_receipt_sha256", "native_stop_journal_sha256",
                        "namespace_attestation_path", "namespace_attestation_sha256",
                    )
                    if key in reconciliation
                }
            if accepted_reattach_context:
                operation["receipt"]["accepted_reattach"] = accepted_reattach_context[
                    "accepted_reattach_metadata"
                ]
            control.write(operation["root"] + "/retained-containers.json", actual)
            operation["receipt"].update(state="stopping-owned-frontend", previous_state_root=str(state),
                                        fresh_state=fresh_state)
            operation["daemon_pending"] = True
            if actual["frontend"]["State"]["Running"]:
                docker_capture("stop", "--time", "60", ids["frontend"], timeout=90)
            for identifier in ids.values():
                if json.loads(docker_text("inspect", identifier))[0]["State"]["Running"]:
                    raise BuildControlError("An owned service is still running; resources retained")
            docker_capture("rm", *ids.values())
            if helper_ids:
                docker_capture("rm", *helper_ids)
            operation["daemon_pending"] = False
            operation["receipt"].update(state="succeeded", removed_containers=list(ids.values()),
                                        retained_volumes=previous["backend_volumes"], retained_frontend_volume=previous["frontend_volume"])
        reuse = None if fresh_state else {"state": state, "host_certificate": certificate_path,
            "owner_marker": owner_path, "receipt": {"image_id": image},
            "operator_probe_environment_record": operator_probe_record}
        recovery_context.update(accepted_reattach_context)
        return start(args, reuse_state=reuse, **recovery_context)
    restart_backend = bool(getattr(args, "restart_backend", False))
    if restart_backend:
        if actual["backend"]["State"]["Running"]:
            raise BuildControlError("Starting the retained backend requires it to be stopped; active runtime is never interrupted")
    elif not actual["backend"]["State"]["Running"] or actual["frontend"]["State"]["Running"]:
        raise BuildControlError("Resume requires the retained backend running and frontend stopped")
    state = storage.validate_path(Path(previous["state_root"]), layout["runtime_root"], "retained Windows sessions")
    certificate_path = _certificate_path(state)
    certificate = _retained_certificate(state, document)
    cache = control.read(previous_root + "/backend-cache.json")
    import docker_backend_volume_cache as cache_adapter
    cache_adapter.validate_container(actual["backend"], cache)
    environment = document["services"]["backend"]["environment"]
    ledger_receipt = control.read(previous_root + "/host-ledger.json")
    ledger_profile = {"profile": "host-ledger-v1", "image_id": image, "environment": environment,
        "mount_root": environment["FULLMAG_HOST_LEDGER_MOUNT_ROOT"],
        "project_id": environment["FULLMAG_HOST_LEDGER_PROJECT_ID"],
        "backing_image": environment["FULLMAG_HOST_LEDGER_BACKING_IMAGE"], "host_receipt": ledger_receipt,
        "maintenance_document": control.read(previous_root + "/ledger-maintenance-compose.json")}
    with control.operation("resume", {"attempt": args.attempt, "config_sha256": args.config_sha256,
                                       **operator_probe_record}) as operation:
        operation["receipt"].update(operator_probe_record)
        operation["receipt"].update(state="resuming-observation", state_root=str(state),
            backend_volumes=previous["backend_volumes"], frontend_volume=previous["frontend_volume"])
        if not actual["frontend"]["State"]["Running"]:
            _frontend(control, operation, selected, state, args.port, image)
            compose_capture(document, "start", "frontend", timeout=90)
        if restart_backend:
            operation["daemon_pending"] = True
            compose_capture(document, "start", "backend", timeout=90)
            operation["daemon_pending"] = False
        git_common = Path(environment["FULLMAG_SOURCE_GIT_COMMON"]) if "FULLMAG_SOURCE_GIT_COMMON" in environment else Path(
            next(m["source"] for m in document["services"]["backend"]["volumes"] if m["target"] == "/opt/fullmag/source-git"))
        _finish(control, operation, document, ids["backend"], ids["frontend"], selected, state,
            certificate_path, certificate, cache, {"image_id": environment["FULLMAG_TOOLCHAIN_IMAGE_ID"]},
            image, git_common, ledger_profile, args.port)
