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
import uuid

import fullmag_storage as storage
from docker_build_control import (BuildControl, BuildControlError, canonical, docker_capture,
                                  compose_capture, build_volume_toolchain, build_volume_runtime_images, bounded_capture)


_NEW_WINDOWS_RUNTIME_STATE_DIRECTORIES = (
    Path("runs"),
    Path("runs/docker-all"),
    Path("runs/docker-all/session-store"),
    Path("runs/docker-all/session-store/runtime-services"),
)

_RECOVERY_ENVIRONMENT_NAME = re.compile(r"FULLMAG_CONTAINER_RECOVERY_[A-Z0-9_]+\Z")
_RECOVERY_ATTEMPT = re.compile(r"[0-9a-f]{32}\Z")
_MAX_RECOVERY_METADATA_BYTES = 256 * 1024


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


def _linux_runtime_identity():
    from docker_platform import host_profile, runtime_identity

    return runtime_identity() if host_profile() == "linux-native-v1" else None


def _docker_process_environment(environment=None):
    from docker_platform import docker_environment

    return docker_environment(environment)


def _host_certificate_paths(state, profile):
    if profile == "linux-native-v1":
        from docker_platform import certificate_directory

        directory = certificate_directory(state)
        return (directory / "linux-native-host.json",
                Path(state) / ".fullmag-linux-native-owner.json")
    return (Path(state) / "windows-folder-host.json",
            Path(state) / ".fullmag-windows-folder-owner.json")


def _path_contains(parent, child):
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def _assert_linux_certificate_mount_isolated(document, certificate_directory):
    """Require one RO certificate bind and reject every writable alias of it."""
    from docker_platform import LINUX_CERTIFICATE_DIRECTORY_TARGET

    certificate_directory = Path(certificate_directory).resolve(strict=False)
    services = document.get("services") if isinstance(document, Mapping) else None
    if not isinstance(services, Mapping):
        raise BuildControlError("Rendered Compose document has no services")
    admissions = 0
    for service_name in ("backend", "frontend"):
        service = services.get(service_name)
        if not isinstance(service, Mapping):
            raise BuildControlError("Rendered Compose document is missing " + service_name)
        mounts = service.get("volumes")
        if not isinstance(mounts, list):
            raise BuildControlError("Rendered Compose mounts are malformed for " + service_name)
        for mount in mounts:
            if not isinstance(mount, Mapping):
                raise BuildControlError("Rendered Compose contains a malformed mount")
            if mount.get("type") != "bind":
                continue
            source = mount.get("source")
            if not isinstance(source, str) or not source:
                raise BuildControlError("Rendered bind mount has no host source")
            source_path = Path(source).resolve(strict=False)
            target = mount.get("target")
            read_only = mount.get("read_only") is True
            exact_admission = (
                service_name == "backend"
                and source_path == certificate_directory
                and target == LINUX_CERTIFICATE_DIRECTORY_TARGET
                and read_only
            )
            if exact_admission:
                admissions += 1
                continue
            if (_path_contains(source_path, certificate_directory)
                    or _path_contains(certificate_directory, source_path)):
                raise BuildControlError(
                    "Host certificate directory is exposed through a non-dedicated Compose bind"
                )
    if admissions != 1:
        raise BuildControlError(
            "Rendered Linux backend must have exactly one dedicated readonly host-certificate bind"
        )


def _read_host_certificate(certificate_path, owner_path):
    from docker_platform import read_owned_regular

    certificate_bytes = read_owned_regular(certificate_path, maximum=1024 * 1024)
    owner_bytes = read_owned_regular(owner_path, maximum=1024 * 1024)
    if certificate_bytes != owner_bytes:
        raise BuildControlError("Retained storage owner marker and host certificate differ")
    try:
        certificate = json.loads(certificate_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError("Retained host certificate is invalid") from error
    if not isinstance(certificate, dict):
        raise BuildControlError("Retained host certificate is malformed")
    return certificate


def _current_docker_host():
    import docker_platform

    if docker_platform.host_profile() == "linux-native-v1":
        return docker_platform.require_local_linux_engine(lambda *args: docker_text(*args))
    result = docker_platform.target_record()
    result["daemon_id"] = docker_text("info", "--format", "{{.ID}}").strip()
    return result


def _assert_ledger_peer_documents(documents, expected):
    """Refuse a second active Linux host-ledger identity on this daemon."""
    for document in documents:
        if not isinstance(document, Mapping):
            raise BuildControlError("Docker returned an invalid active-container record")
        config = document.get("Config") or {}
        labels = config.get("Labels") or {}
        environment = {}
        for item in config.get("Env", []) or []:
            if isinstance(item, str) and "=" in item:
                key, value = item.split("=", 1)
                environment[key] = value
        is_managed_backend = (
            environment.get("FULLMAG_DOCKER_ROLE") == "backend"
            or labels.get("com.docker.compose.service") == "backend"
            or (labels.get("org.fullmag.compose.project") and
                labels.get("org.fullmag.compose.role") == "backend")
        )
        if not is_managed_backend:
            continue
        profile = environment.get("FULLMAG_HOST_LEDGER_PROFILE")
        ledger_values = (
            profile,
            environment.get("FULLMAG_HOST_LEDGER_PROJECT_ID"),
            environment.get("FULLMAG_HOST_LEDGER_MOUNT_ROOT"),
            environment.get("FULLMAG_HOST_LEDGER_BACKING_IMAGE"),
            environment.get("FULLMAG_DOCKER_HOST_ID"),
        )
        if ledger_values != expected:
            name = config.get("Hostname") or document.get("Name") or document.get("Id") or "unknown"
            raise BuildControlError(
                "Active Fullmag backend peer " + str(name)[:128]
                + " uses a different or unproven host-ledger identity on this Docker daemon; "
                "coordinate the canonical storage/ledger settings before starting another DEV group"
            )


def _assert_linux_ledger_peers(layout):
    """Check running Fullmag backends before this checkout allocates its group."""
    import docker_host_ledger as ledger
    from docker_platform import host_profile

    if host_profile() != "linux-native-v1":
        return
    values = ledger._resolve_values(layout)
    daemon = ledger._daemon_info(docker_text)
    identifiers = docker_text("ps", "--quiet", "--no-trunc").split()
    if not identifiers:
        return
    documents = json.loads(docker_text("inspect", *identifiers))
    if not isinstance(documents, list):
        raise BuildControlError("Cannot inspect active Fullmag backend peers safely")
    expected = (
        ledger.PROFILE,
        values["project_id"],
        values["mount_root"],
        ledger._daemon_path(values["backing_image"], "backing image"),
        daemon["id_sha256"],
    )
    _assert_ledger_peer_documents(documents, expected)


def _verify_linux_certificate_owner(certificate, state, image, docker_host, volume):
    uid, gid = _linux_runtime_identity()
    owner_token = certificate.get("owner_token")
    expected_restart = hashlib.sha256((str(owner_token) + ":" + str(image)).encode("ascii")).hexdigest()
    if (certificate.get("schema") != "fullmag.linux-native-host-certificate.v1"
            or certificate.get("storage_profile") != "linux-native-v1"
            or certificate.get("role") != "session"
            or certificate.get("owner_scope") != "docker-local-unix"
            or certificate.get("image_id") != image
            or certificate.get("host_root") != str(Path(state).resolve(strict=True))
            or certificate.get("filesystem") != volume.get("filesystem")
            or certificate.get("device") != volume.get("device")
            or certificate.get("runtime_uid") != uid
            or certificate.get("runtime_gid") != gid
            or not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", str(owner_token))
            or certificate.get("restart_expected_sha256") != expected_restart
            or certificate.get("docker_host") != docker_host
            or certificate.get("engine_id") != docker_host.get("daemon_id")):
        raise BuildControlError("Linux host certificate differs from current owner, filesystem, image, or Docker endpoint")


def _publish_linux_certificate(certificate_path, owner_path, certificate):
    from docker_platform import publish_evidence

    publish_evidence(certificate_path, certificate)
    publish_evidence(owner_path, certificate)


def _new_linux_host_certificate(state, image, runtime_identity, docker_host,
                                volume, assembly, binary_hashes, delegation,
                                owner_token=None):
    owner_token = owner_token or str(uuid.uuid4())
    # Owner tokens are UUIDs, not arbitrary cache or service identifiers.
    owner_token = str(uuid.UUID(owner_token))
    return {
        "schema": "fullmag.linux-native-host-certificate.v1",
        "storage_profile": "linux-native-v1",
        "role": "session",
        "owner_scope": "docker-local-unix",
        "owner_token": owner_token,
        "engine_id": docker_host["daemon_id"],
        "docker_host": dict(docker_host),
        "host_root": str(Path(state).resolve(strict=True)),
        "filesystem": volume["filesystem"],
        "device": volume["device"],
        "runtime_uid": runtime_identity[0],
        "runtime_gid": runtime_identity[1],
        "image_id": image,
        "source_commit": assembly["commit"],
        "binary_hashes": dict(binary_hashes),
        "artifact_receipt_sha256": assembly["build_receipt_sha256"],
        "restart_expected_sha256": hashlib.sha256(
            (owner_token + ":" + image).encode("ascii")
        ).hexdigest(),
        "restart_verified": False,
        "development_build": dict(delegation),
    }


def _linux_probe_snapshot(container_id):
    script = r'''import hashlib,json,os,stat
def read(path):
 fd=os.open(path,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_NONBLOCK',0))
 try:
  info=os.fstat(fd)
  if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_uid!=os.geteuid() or info.st_gid!=os.getegid() or info.st_size>65536:
   raise RuntimeError('Linux storage probe record is not a bounded owned regular file')
  data=os.read(fd,65537)
  if len(data)>65536: raise RuntimeError('Linux storage probe record exceeded its byte limit')
  return data
 finally: os.close(fd)
probe=json.loads(read('/state/.fullmag-linux-native-probe.json'))
restart=read('/state/.linux-native-restart')
print(json.dumps({'probe':probe,'restart_sha256':hashlib.sha256(restart).hexdigest()}))
'''
    raw = docker_text("exec", container_id, "/usr/local/bin/python3", "-B", "-c", script)
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise BuildControlError("Linux guest storage probe returned invalid JSON") from error
    if not isinstance(value, dict) or not isinstance(value.get("probe"), dict):
        raise BuildControlError("Linux guest storage probe result is incomplete")
    return value


def _run_linux_storage_preflight(control, operation, backend_id, state,
                                 certificate_path, owner_path, certificate,
                                 assembly=None, inputs=None):
    """Verify guest durability, rotate the owner certificate, and verify restart."""
    import docker_platform
    import fullmag_docker_runtime as runtime

    local = docker_platform.admit_storage_path(state)
    current = _current_docker_host()
    if certificate.get("restart_verified") is not True:
        if assembly is None or inputs is None:
            raise BuildControlError("Initial Linux admission requires a matching backend build receipt")
        certificate = runtime._refresh_development_certificate(certificate, assembly, inputs)
        _publish_linux_certificate(certificate_path, owner_path, certificate)
    _verify_linux_certificate_owner(certificate, state, certificate.get("image_id"), current, local)
    first = docker_text("exec", backend_id, "/usr/local/bin/python3", "/opt/fullmag/entrypoint.py",
                        "--storage-probe", timeout=120, combined=True)
    control.write(operation["root"] + "/storage-probe-first-log.json", {"log": first})
    snapshot = _linux_probe_snapshot(backend_id)
    probe = snapshot["probe"]
    required = ("file_sync", "directory_sync", "atomic_replace", "process_lock", "sqlite_transactions")
    if (probe.get("schema") != "fullmag.linux-native-probe.v1"
            or probe.get("storage_profile") != "linux-native-v1"
            or probe.get("image_id") != certificate.get("image_id")
            or probe.get("owner_token") != certificate.get("owner_token")
            or probe.get("restart_expected_sha256") != certificate.get("restart_expected_sha256")
            or not isinstance(probe.get("checks"), Mapping)
            or any(probe["checks"].get(name) is not True for name in required)
            or snapshot.get("restart_sha256") != certificate.get("restart_expected_sha256")):
        raise BuildControlError("Initial Linux storage durability or restart readback probe failed")
    if certificate.get("restart_verified") is not True:
        certificate = dict(certificate)
        certificate["restart_verified"] = True
        _publish_linux_certificate(certificate_path, owner_path, certificate)
    _verify_linux_certificate_owner(certificate, state, certificate.get("image_id"), current, local)
    second = docker_text("exec", backend_id, "/usr/local/bin/python3", "/opt/fullmag/entrypoint.py",
                         "--storage-probe", timeout=120, combined=True)
    control.write(operation["root"] + "/storage-probe-restart-log.json", {"log": second})
    final = _linux_probe_snapshot(backend_id)
    final_probe = final["probe"]
    if (final_probe.get("checks", {}).get("restart_readback") is not True
            or final_probe.get("image_id") != certificate.get("image_id")
            or final_probe.get("owner_token") != certificate.get("owner_token")
            or final_probe.get("restart_expected_sha256") != certificate.get("restart_expected_sha256")
            or final.get("restart_sha256") != certificate.get("restart_expected_sha256")
            or any(final_probe.get("checks", {}).get(name) is not True
                   for name in (*required, "restart_readback"))):
        raise BuildControlError("Restarted Linux storage durability probe failed")
    control.write(operation["root"] + "/linux-storage-probe-receipt.json", final_probe)
    return certificate, final_probe


def consumers():
    ids = docker_text("ps", "--quiet", "--no-trunc").split()
    return json.loads(docker_text("inspect", *ids)) if ids else []


def _owned_volume(control, role, key):
    from docker_platform import runtime_identity_record

    runtime = runtime_identity_record()
    if runtime["profile"] == "linux-native-v1":
        key = hashlib.sha256(canonical({"key": key, "runtime": runtime})).hexdigest()
    name = "fullmag-dev-" + role + "-v1-" + key[:24]
    labels = {**{k: v for k, v in control.labels.items() if k.startswith("org.fullmag.")},
              "org.fullmag.build.role": role, "org.fullmag.build.cache-key": key}
    if runtime["profile"] == "linux-native-v1":
        labels.update({
            "org.fullmag.build.runtime-profile": runtime["profile"],
            "org.fullmag.build.runtime-uid": str(runtime["uid"]),
            "org.fullmag.build.runtime-gid": str(runtime["gid"]),
        })
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
    if runtime["profile"] == "linux-native-v1":
        uid, gid = runtime["uid"], runtime["gid"]
        script = (f"if test $(stat -c %u:%g /data) = {uid}:{gid}; then test $(stat -c %a /data) = 750; "
                  f"elif test $(stat -c %u:%g /data) = 0:0; then "
                  "test -z \"$(find /data -mindepth 1 -maxdepth 1 -print -quit)\"; "
                  f"chown {uid}:{gid} /data; chmod 0750 /data; else exit 41; fi")
    else:
        script = "test $(stat -c %u /data) = 0 -o $(stat -c %u /data) = 65532; chown 65532:65532 /data; chmod 0750 /data"
    args = control.helper_args(script, initialize=True)
    args[args.index("--entrypoint"):args.index("--entrypoint")] = ["--mount", "type=volume,src=" + name + ",dst=/data,volume-nocopy"]
    result = bounded_capture(args, data=b"", timeout=90, env=_docker_process_environment())
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
    result = bounded_capture(args, data=request, timeout=120, env=_docker_process_environment())
    if result.returncode:
        raise BuildControlError(result.stderr.decode("utf-8", "replace"))
    seeded = json.loads(result.stdout)
    inputs = seeded.pop("inputs")
    control.write(operation["root"] + "/frontend-seed.json", seeded)
    control.write("frontend/development-inputs.json", inputs)
    return inputs, volume


def _backend_cache(control, operation, layout, selected, image, toolchain):
    import docker_backend_volume_cache as cache
    runtime_identity = _linux_runtime_identity()
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
        control_volume_name=control.volume, runtime_identity=runtime_identity)
    overlay = cache.maintenance_overlay(profile)
    overlay["name"] = control.project
    control.write(operation["root"] + "/cache-maintenance-compose.json", overlay)
    output = compose_capture(overlay, "run", "--rm", "--no-deps", cache.MAINTENANCE_SERVICE, timeout=180)
    receipt = cache._read_json_output(output.decode())
    result = cache.validate(profile, profile["volume_documents"], receipt, consumers)
    control.write(relative, result)
    return result


def _host_ledger(control, operation, layout, selected, image):
    import docker_host_ledger as ledger
    values = ledger._resolve_values(layout)
    daemon = ledger._daemon_info(docker_text)
    ledger._image_attestation(image, docker_text)
    helper = selected / "scripts/lib/docker_host_ledger.sh"
    from docker_platform import (
        host_profile,
        read_owned_regular,
        runtime_identity as host_runtime_identity,
    )
    helper_bytes = read_owned_regular(helper, maximum=ledger.MAX_HELPER_BYTES)
    helper_hash = hashlib.sha256(helper_bytes).hexdigest()
    helper_relative = operation["root"] + "/docker_host_ledger.sh"
    control.write_bytes(helper_relative, helper_bytes)
    env = {
        "FULLMAG_HOST_LEDGER_PROFILE": ledger.PROFILE,
        "FULLMAG_HOST_LEDGER_PROJECT_ID": values["project_id"],
        "FULLMAG_HOST_LEDGER_STORAGE_ROOT": ledger._daemon_path(values["storage_root"], "storage root"),
        "FULLMAG_HOST_LEDGER_BACKING_IMAGE": ledger._daemon_path(values["backing_image"], "backing image"),
        "FULLMAG_HOST_LEDGER_MOUNT_ROOT": values["mount_root"],
        "FULLMAG_HOST_LEDGER_LOCK_PATH": ledger._daemon_path(values["lock_path"], "lock path"),
        "FULLMAG_HOST_LEDGER_OWNER_MARKER": values["owner_marker"],
        "FULLMAG_HOST_LEDGER_SIZE_BYTES": str(ledger.IMAGE_SIZE_BYTES),
        "FULLMAG_HOST_LEDGER_MOUNT_TARGET": ledger.MOUNT_TARGET,
        "FULLMAG_HOST_LEDGER_ROOT": ledger.LEDGER_ROOT,
        "FULLMAG_HOST_LEDGER_LEDGER_ROOT": values["ledger_root_daemon"],
        "FULLMAG_HOST_LEDGER_HELPER_PATH": ledger._daemon_path(helper, "readonly helper source"),
        "FULLMAG_HOST_LEDGER_HELPER_IMAGE": image,
        "FULLMAG_HOST_LEDGER_HOST_PID": "1",
        "FULLMAG_HOST_LEDGER_RUNTIME_UID": str(host_runtime_identity()[0]) if host_profile() == "linux-native-v1" else "65532",
        "FULLMAG_HOST_LEDGER_RUNTIME_GID": str(host_runtime_identity()[1]) if host_profile() == "linux-native-v1" else "65532",
        "FULLMAG_HOST_LEDGER_LOCK_WAIT_SECONDS": "120", "FULLMAG_DOCKER_HOST_ID": daemon["id_sha256"],
    }
    from docker_platform import docker_cli_prefix
    command = [*docker_cli_prefix(), "compose", "--project-name", control.project,
               "-f", "-", "-f", str(selected / "compose.host-ledger.yaml"), "--profile", "host-ledger-maintenance", "config", "--format", "json"]
    result = bounded_capture(command, data=canonical({"name": control.project,
        "services": {"backend": {"image": image}}}),
        env=_docker_process_environment({**os.environ, **env}), timeout=90)
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
    if hashlib.sha256(read_owned_regular(helper, maximum=ledger.MAX_HELPER_BYTES)).hexdigest() != helper_hash:
        raise BuildControlError("Host-ledger helper changed during maintenance")
    host_receipt = ledger._parse_json_lines(output.decode(), ledger.HOST_RECEIPT_SCHEMA)
    ledger._validate_host_receipt(host_receipt, {"project_id": values["project_id"],
        "mount_root": values["mount_root"], "backing_image": env["FULLMAG_HOST_LEDGER_BACKING_IMAGE"]})
    control.write(operation["root"] + "/host-ledger.json", host_receipt)
    control.write(operation["root"] + "/ledger-helper-log.json",
                  {"log": docker_text("logs", name, combined=True)})
    docker_capture("rm", observed[0]["Id"])
    backend = rendered["services"]["backend"]
    return backend, {"profile": ledger.PROFILE, "image_id": image, "environment": env,
        "mount_root": values["mount_root"], "project_id": values["project_id"],
        "backing_image": env["FULLMAG_HOST_LEDGER_BACKING_IMAGE"], "host_receipt": host_receipt,
        "maintenance_document": spec}



def _startup_helper(control, selected, image):
    """Execute host admission code only when both helper bytes match the image."""
    import fullmag_docker_runtime as runtime
    names = ("docker_startup_script.py", "fullmag_storage.py")
    command = "sha256sum " + " ".join("/opt/fullmag/" + name for name in names)
    arguments = control.helper_args(command)
    arguments[arguments.index(control.image)] = image
    result = bounded_capture(arguments, data=b"", timeout=90, env=_docker_process_environment())
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
          recovery_environment=None, recovery_metadata=None):
    from docker_dev import (_require_managed_dev_host, _select_source, _compose_identity,
        _assert_no_running_fullmag, _source_git_common_directory, _workspace_state_root,
        _operator_probe_environment_from_host)
    import fullmag_docker_runtime as runtime
    import docker_platform
    provided_control = control
    provided_operation = operation
    if (provided_control is None) != (provided_operation is None):
        raise BuildControlError("Recovery start requires both control and operation")
    validated_recovery_environment = _validate_recovery_environment(recovery_environment)
    validated_recovery_metadata = _validate_recovery_metadata(recovery_metadata)
    _require_managed_dev_host()
    host_profile = docker_platform.host_profile()
    selected, layout = _select_source(Path(args.repo_root).resolve(strict=True), args.source_root or args.repo_root)
    _assert_linux_ledger_peers(layout)
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
    operation_inputs = {"source_root": str(selected), "image_id": image,
        "source_project_id": identity["project_id"],
        "source_worktree_id": identity["worktree_id"],
        "source_checkout_kind": identity["checkout_kind"],
        "gpu_access_requested": policy, "device_access": device_access,
        "gpu_preflight": "PASS" if device_access == "gpu" else "NOT_REQUIRED",
        **operator_probe_record}
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
        token = operation["receipt"]["attempt"]
        if reuse_state is None:
            state = storage.validate_path(Path(layout["runtime_root"]) / "docker-volume-dev" / token,
                                          layout["storage_root"], "DEV session storage")
            state.parent.mkdir(parents=True, exist_ok=True)
            state.mkdir(mode=0o700, exist_ok=False)
            if host_profile == "linux-native-v1":
                os.chmod(state, 0o700)
                certificate_path, owner_marker = _host_certificate_paths(state, host_profile)
                certificate_path.parent.mkdir(mode=0o700, exist_ok=False)
                os.chmod(certificate_path.parent, 0o700)
            else:
                operation["receipt"]["windows_runtime_directories"] = list(
                    _precreate_new_windows_runtime_state(state)
                )
                operation["receipt"]["windows_runtime_write_probe"] = "PASS"
                certificate_path, owner_marker = _host_certificate_paths(state, host_profile)
                certificate_path.touch(exist_ok=False)
        else:
            try:
                state = storage.validate_path(
                    Path(reuse_state["state"]),
                    Path(layout["runtime_root"]),
                    "retained DEV sessions",
                )
                certificate_path, owner_marker = _host_certificate_paths(state, host_profile)
                expected_certificate = storage.validate_path(
                    certificate_path, Path(layout["runtime_root"]),
                    "retained DEV session certificate")
                expected_owner = storage.validate_path(owner_marker, state,
                    "retained DEV session owner marker")
                if (Path(reuse_state["host_certificate"]).resolve(strict=False) != expected_certificate
                        or Path(reuse_state["owner_marker"]).resolve(strict=False) != expected_owner):
                    raise BuildControlError("Retained host certificate paths differ from the selected profile")
            except (KeyError, TypeError, ValueError, storage.StorageError) as error:
                raise BuildControlError(
                    "Retained DEV session paths are outside the selected runtime root"
                ) from error
            reuse_state = dict(reuse_state)
            reuse_state["state"] = state
            reuse_state["host_certificate"] = certificate_path
            reuse_state["owner_marker"] = owner_marker
        operation["receipt"]["state_root"] = str(state)
        volume_identity = docker_platform.admit_storage_path(state)
        docker_host = _current_docker_host()
        runtime_identity = docker_platform.runtime_identity() if host_profile == "linux-native-v1" else None
        operation["receipt"]["docker_host"] = docker_host
        operation["receipt"]["storage_profile"] = host_profile
        retained_certificate = None
        if host_profile == "linux-native-v1" and reuse_state is not None:
            retained_certificate = _read_host_certificate(certificate_path, owner_marker)
            _verify_linux_certificate_owner(retained_certificate, state,
                retained_certificate.get("image_id"), docker_host, volume_identity)
            if (retained_certificate.get("image_id") != image
                    or retained_certificate.get("restart_verified") is not True):
                raise BuildControlError(
                    "Retained Linux state is not admitted for this backend image; preserve it and use explicit fresh-state recovery"
                )
        cache = _backend_cache(control, operation, layout, selected, image, toolchain["image_id"])
        operation["receipt"]["backend_volumes"] = cache["volume_names"]
        frontend_inputs, frontend_volume = _frontend(control, operation, selected, state, args.port, image)
        ledger_backend, ledger_profile = _host_ledger(control, operation, layout, selected, image)
        inputs = {"image_id": image, "toolchain_image_id": toolchain["image_id"],
                  "guest_provenance_path": "/opt/fullmag/control/backend/runtime-provenance.json"}
        assembly, hashes, delegation = runtime._provisional_development_certificate(
            inputs, identity, storage_profile=host_profile
        )
        if host_profile == "linux-native-v1":
            certificate = _new_linux_host_certificate(
                state, image, runtime_identity, docker_host, volume_identity,
                assembly, hashes, delegation,
                owner_token=(retained_certificate or {}).get("owner_token"),
            )
            _publish_linux_certificate(certificate_path, owner_marker, certificate)
            operation["receipt"].update(
                storage_profile=host_profile,
                owner_token=certificate["owner_token"],
                host_certificate_sha256=hashlib.sha256(
                    docker_platform.read_owned_regular(certificate_path, maximum=1024 * 1024)
                ).hexdigest(),
            )
        else:
            from windows_folder_host import attest, publish_evidence
            if reuse_state is None:
                certificate = attest(state, assembly, docker_host["daemon_id"], hashes,
                                     development_build=delegation)
                publish_evidence(certificate_path, certificate)
            else:
                certificate = runtime._reuse_host_certificate(
                    reuse_state, assembly, docker_host["daemon_id"], development_build=delegation
                )
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
        git_common = _source_git_common_directory(selected)
        environment = {**docker_platform.runtime_environment(os.environ),
            "FULLMAG_COMPOSE_PROJECT": control.project,
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
        if host_profile == "linux-native-v1":
            environment["FULLMAG_HOST_CERTIFICATE_DIR"] = str(certificate_path.parent)
            operation["receipt"]["runtime_identity"] = {
                "uid": runtime_identity[0], "gid": runtime_identity[1]
            }
        # Only the two validated controls are carried into Compose.  The
        # digest is explicit so later cache/ledger overlays cannot silently
        # replace the operator's requested probe mode.
        environment.update(operator_probe_record["operator_probe_environment"])
        environment["FULLMAG_OPERATOR_PROBE_ENVIRONMENT_SHA256"] = operator_probe_record[
            "operator_probe_environment_sha256"
        ]
        configured = bounded_capture([*docker_platform.docker_cli_prefix(), "compose",
            "--project-name", control.project, "-f", str(selected / "compose.dev.yaml"),
            "config", "--format", "json"],
            env=_docker_process_environment(environment), timeout=90)
        if configured.returncode or len(configured.stdout) > 1024 * 1024:
            raise BuildControlError("DEV Compose render failed: " + configured.stderr.decode("utf-8", "replace"))
        document = json.loads(configured.stdout)
        if device_access == "gpu":
            document["services"]["backend"]["gpus"] = [{"count": "all"}]
        backend, frontend = (document["services"][name] for name in ("backend", "frontend"))
        backend.pop("build", None)
        backend["environment"].update(cache["environment"])
        backend["environment"].update(ledger_backend["environment"])
        backend["environment"]["FULLMAG_PACKAGE_PROVENANCE"] = runtime.BACKEND_PROVENANCE_PATH
        backend["environment"]["FULLMAG_RUNTIME_PROVENANCE"] = runtime.BACKEND_PROVENANCE_PATH
        backend["environment"]["CUDA_CACHE_PATH"] = "/build/cuda-cache"
        backend["environment"].update(validated_recovery_environment)
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
        _reassert_operator_probe_environment(document, operator_probe_record)
        for service in (backend, frontend):
            service["logging"] = {"driver": "local", "options": {"max-size": "10m", "max-file": "3"}}
        if host_profile == "linux-native-v1":
            _assert_linux_certificate_mount_isolated(document, certificate_path.parent)
        # All writable bind destinations are runtime/user stores, never build data.
        for service in (backend, frontend):
            for mount in service["volumes"]:
                if mount["type"] == "bind" and not mount.get("read_only") and mount["target"] not in {"/state", "/user-data", "/host-ledger"}:
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
            print("Backend is building in its persistent Compose service; Docker data retained.", flush=True)
            last_report = time.monotonic()
        time.sleep(3)
    raise BuildControlError("Backend publication observation timed out; services and volumes retained")


def _finish(control, operation, document, backend_id, frontend_id, selected, state,
            certificate_path, certificate, cache, toolchain, image, git_common, ledger_profile, port):
    import fullmag_docker_runtime as runtime
    import docker_platform
    token = operation["receipt"]["attempt"]
    operator_probe_record = _operator_probe_record_from_retained(operation["receipt"], document)
    inputs = {"image_id": image, "toolchain_image_id": toolchain["image_id"],
              "guest_provenance_path": "/opt/fullmag/control/backend/runtime-provenance.json",
              **operator_probe_record}
    receipt, provenance = _wait_for_publication(control, operation, backend_id)
    control.write(operation["root"] + "/backend-build-receipt.json", receipt)
    control.write(operation["root"] + "/provenance.json", provenance)
    operation["receipt"]["config_sha256"] = hashlib.sha256(canonical(document)).hexdigest()
    operation["receipt"]["storage_profile"] = certificate.get("storage_profile")
    operation["receipt"]["storage_delegation_reused"] = certificate.get("restart_verified") is True
    # Use the existing source/binary validation before rotating host admission.
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
    if certificate.get("storage_profile") == "linux-native-v1":
        owner_marker = Path(state) / ".fullmag-linux-native-owner.json"
        certificate, probe = _run_linux_storage_preflight(
            control, operation, backend_id, state, certificate_path, owner_marker,
            certificate, assembly=assembly, inputs=inputs,
        )
        operation["receipt"]["linux_native_storage_probe"] = probe
        operation["receipt"]["owner_token"] = certificate["owner_token"]
        operation["receipt"]["host_certificate_sha256"] = hashlib.sha256(
            docker_platform.read_owned_regular(certificate_path, maximum=1024 * 1024)
        ).hexdigest()
        operation["receipt"]["linux_native_certificate_sha256"] = hashlib.sha256(
            canonical(certificate)
        ).hexdigest()
    else:
        if certificate.get("restart_verified") is not True:
            certificate = runtime._refresh_development_certificate(certificate, assembly, inputs)
            runtime._publish_bound_development_certificate(
                certificate_path, state / ".fullmag-windows-folder-owner.json", certificate
            )
        runtime._complete_backend_storage_preflight(
            docker_text, backend_id, state, certificate_path, certificate, None,
            log_writer=lambda output: control.write(
                operation["root"] + "/storage-probe-log.json", {"log": output}
            ),
        )
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
    ledger_attestation = ledger.validate_container(json.loads(docker_text("inspect", backend_id))[0], ledger_profile, docker_text)
    control.write(operation["root"] + "/host-ledger-attestation.json", ledger_attestation)
    # Observe the existing incarnations; a readiness check must never run up
    # again or wait an hour after the supervisor has already closed admission.
    process_script = """import json,pathlib,sys
sys.path.insert(0,'/opt/fullmag')
import runtime_service
try:
 raw=runtime_service._bounded_regular(pathlib.Path('/state/.fullmag/runtime-service/process-tree.json'),'process receipt')
except FileNotFoundError:
 print(json.dumps({'state':'not-published'}))
else:
 print(raw.decode('utf-8'))
"""
    image_config = json.loads(docker_text("image", "inspect", image))[0]["Config"]
    readiness_deadline = time.monotonic() + 3900
    while time.monotonic() < readiness_deadline:
        services = json.loads(docker_text("inspect", backend_id, frontend_id))
        for service, observed in zip(("backend", "frontend"), services):
            _validate_retained_service(document, observed, service, image_config,
                expected_started_at=operation["receipt"]["backend_started_at"] if service == "backend" else None)
            if not observed.get("State", {}).get("Running"):
                raise BuildControlError("DEV service exited before readiness: " + service)
        process_receipt = json.loads(docker_text("exec", backend_id, "/usr/local/bin/python3", "-B", "-c", process_script))
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
        from docker_platform import read_owned_regular
        startup_path = state / "startup-provenance.json"
        data = read_owned_regular(startup_path, maximum=256 * 1024)
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
        elif mount["type"] == "bind" and host_path(observed["Source"]) != Path(mount["source"]).resolve():
            raise BuildControlError("Retained source/runtime bind differs: " + mount["target"])


def _load_retained_storage(layout, previous, profile, image, docker_host):
    import docker_platform

    state = storage.validate_path(
        Path(previous["state_root"]), layout["runtime_root"], "retained DEV session"
    )
    certificate_path, owner_path = _host_certificate_paths(state, profile)
    certificate = _read_host_certificate(certificate_path, owner_path)
    if certificate.get("image_id") != image:
        raise BuildControlError("Retained host certificate belongs to another backend image")
    if profile == "linux-native-v1":
        volume = docker_platform.admit_storage_path(state)
        _verify_linux_certificate_owner(certificate, state, image, docker_host, volume)
        if previous.get("storage_profile") != profile:
            raise BuildControlError("Retained Linux storage profile differs from its pinned receipt")
        if previous.get("docker_host") != docker_host:
            raise BuildControlError("Retained Linux operation selected another Docker endpoint or context")
        if previous.get("owner_token") != certificate.get("owner_token"):
            raise BuildControlError("Retained Linux owner token differs from its pinned receipt")
        identity = docker_platform.runtime_identity_record()
        if previous.get("runtime_identity") != {"uid": identity["uid"], "gid": identity["gid"]}:
            raise BuildControlError("Retained Linux runtime UID/GID differs from its pinned receipt")
        certificate_digest = hashlib.sha256(
            docker_platform.read_owned_regular(certificate_path, maximum=1024 * 1024)
        ).hexdigest()
        if previous.get("host_certificate_sha256") != certificate_digest:
            raise BuildControlError("Retained Linux certificate bytes differ from the pinned receipt")
    return state, certificate_path, owner_path, certificate


def _retained_identity_receipt(profile, docker_host, certificate_path, certificate):
    import docker_platform

    identity = {"storage_profile": profile, "docker_host": dict(docker_host)}
    if profile == "linux-native-v1":
        runtime = docker_platform.runtime_identity_record()
        identity.update(
            runtime_identity={"uid": runtime["uid"], "gid": runtime["gid"]},
            owner_token=certificate["owner_token"],
            host_certificate_sha256=hashlib.sha256(
                docker_platform.read_owned_regular(
                    certificate_path, maximum=1024 * 1024
                )
            ).hexdigest(),
        )
    return identity


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


def restart_idle(args):
    return _retained_operation(args, recreate_services=False, restart_idle_service=True)


def recreate(args):
    return _retained_operation(args, recreate_services=True)


def resume(args):
    return _retained_operation(args, recreate_services=False)


def _retained_operation(args, *, recreate_services, restart_idle_service=False):
    """Resume observation/admission of one exact failed start; never restart the backend."""
    from docker_dev import _require_managed_dev_host, _select_source, _compose_identity
    import docker_platform
    _require_managed_dev_host()
    host_profile = docker_platform.host_profile()
    selected, layout = _select_source(Path(args.repo_root).resolve(strict=True), args.source_root)
    _assert_linux_ledger_peers(layout)
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
    docker_host = _current_docker_host()
    if previous.get("docker_host") is not None and previous.get("docker_host") != docker_host:
        raise BuildControlError("Retained operation selected another Docker endpoint or context")
    state, certificate_path, owner_marker, certificate = _load_retained_storage(
        layout, previous, host_profile, image, docker_host
    )
    retained_identity = _retained_identity_receipt(
        host_profile, docker_host, certificate_path, certificate
    )
    if host_profile == "linux-native-v1":
        _assert_linux_certificate_mount_isolated(document, certificate_path.parent)
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
        environment = document["services"]["backend"]["environment"]
        if environment.get("FULLMAG_STARTUP_ENABLED") == "1":
            raise BuildControlError("Startup activation requires dedicated recovery; idle restart will not repeat Solve")
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
            operation["receipt"].update(retained_identity)
            _assert_private_restart_network(actual, ids, control.project)
            operation["daemon_pending"] = True
            docker_capture("stop", "--time", "60", ids["frontend"], timeout=90)
            operation["daemon_pending"] = False
            _assert_private_restart_network(actual, ids, control.project)
            probe = """import json,urllib.request
with urllib.request.urlopen('http://127.0.0.1:8081/v2/platform/health',timeout=5) as response:
 document=json.load(response)
 if response.status!=200 or document.get('status')!='ok' or document.get('active_session') is not False:
  raise RuntimeError('Backend has an active or unknown session; restart refused')
 print(json.dumps(document))
"""
            try:
                health = json.loads(docker_text("exec", ids["backend"], "/usr/local/bin/python3", "-B", "-c", probe))
                if health.get("status") != "ok" or health.get("active_session") is not False:
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
        if certificate.get("image_id") != image:
            raise BuildControlError("Retained storage certificate belongs to another image")
        fresh_state = bool(getattr(args, "fresh_state", False))
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
            operation["receipt"].update(operator_probe_record)
            operation["receipt"].update(retained_identity)
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
            "owner_marker": owner_marker, "receipt": {"image_id": image},
            "operator_probe_environment_record": operator_probe_record}
        return start(args, reuse_state=reuse)
    restart_backend = bool(getattr(args, "restart_backend", False))
    if restart_backend:
        if actual["backend"]["State"]["Running"]:
            raise BuildControlError("Starting the retained backend requires it to be stopped; active runtime is never interrupted")
    elif not actual["backend"]["State"]["Running"] or actual["frontend"]["State"]["Running"]:
        raise BuildControlError("Resume requires the retained backend running and frontend stopped")
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
        operation["receipt"].update(retained_identity)
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
