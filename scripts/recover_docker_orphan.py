"""Explicit operator recovery of one failed Docker worker namespace.

All process effects belong to the host adapter; only the native CLI changes
SessionStore or the host ledger. No build, API start, or Solve is performed.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import posixpath
from pathlib import Path
import re
import stat
import subprocess
import uuid
from typing import Any, Callable, Mapping, Sequence

MAX_DOCUMENT = 2 * 1024 * 1024
CONFIG_PATH = "/state/.fullmag/runtime-service/docker-all.json"
NATIVE_PROGRAM = "/opt/fullmag/package/bin/fullmag-runtime-service"
READONLY_MOUNTS = frozenset({
    "/opt/fullmag/package", "/opt/fullmag/provenance.json",
    "/opt/fullmag/source", "/opt/fullmag/source-git",
    "/run/fullmag/windows-folder-host.json",
    "/run/fullmag/startup-provenance.json",
})
MUTABLE_MOUNTS = frozenset({"/state", "/host-ledger"})
ENVIRONMENT_NAMES = frozenset({
    "FULLMAG_SESSION_STORAGE_PROFILE", "FULLMAG_RUNTIME_IMAGE_ID",
    "FULLMAG_HOST_LEDGER_PROFILE", "FULLMAG_HOST_LEDGER_PROJECT_ID",
    "FULLMAG_DOCKER_HOST_ID", "FULLMAG_DOCKER_HOST_EXECUTION",
    "FULLMAG_WINDOWS_CONTAINER_MANAGED", "FULLMAG_REPO_ROOT",
    "FULLMAG_STATE_ROOT", "FULLMAG_STATE_DIR", "FULLMAG_PROJECT_STORAGE_ROOT",
    "FULLMAG_RUNS_ROOT", "FULLMAG_WORKTREE_ID", "FULLMAG_RUNTIME_SERVICE_CONFIG",
    "FULLMAG_RUNTIME_ROOT", "FULLMAG_PACKAGE_PROVENANCE",
    "FULLMAG_RUNTIME_PACKAGE_ROOT", "LD_LIBRARY_PATH", "HOME",
    "FULLMAG_COMPOSE_PROJECT", "FULLMAG_TOOLCHAIN_IMAGE_ID",
    "FULLMAG_BACKEND_CARGO_PROFILE",
})

RECOVERY_CONTAINER_SERVICE = "backend-recovery"
MAX_OUTPUT = 2 * 1024 * 1024


def _backend_volume_cache_adapter(value: Any):
    """Return the v2 adapter only for an explicit ready volume profile."""

    if not isinstance(value, Mapping):
        raise RecoveryAborted("v2 backend cache proof is missing")
    try:
        import docker_backend_volume_cache as adapter
    except ImportError as error:  # pragma: no cover - packaging error
        raise RecoveryAborted("backend volume cache adapter is unavailable") from error
    if value.get("schema") != adapter.SCHEMA or value.get("profile") != adapter.PROFILE:
        raise RecoveryAborted("backend cache profile is not the supported v2 schema")
    if value.get("state") != "ready":
        raise RecoveryAborted("backend volume cache proof is not ready")
    if value.get("build_root") != adapter.BUILD_TARGET or value.get("mount_root") != adapter.BUILD_TARGET:
        raise RecoveryAborted("backend volume cache build target differs from v2")
    if value.get("package_root") != adapter.PACKAGE_TARGET:
        raise RecoveryAborted("backend volume cache package target differs from v2")
    names = value.get("volume_names")
    if (not isinstance(names, Mapping)
            or set(names) != set(adapter.VOLUME_ROLES)
            or any(not isinstance(name, str) or adapter._VOLUME_NAME.fullmatch(name) is None
                   for name in names.values())):
        raise RecoveryAborted("backend volume cache names are invalid")
    receipt = value.get("receipt")
    if not isinstance(receipt, Mapping) or receipt.get("volume_names") != dict(names):
        raise RecoveryAborted("backend volume cache receipt does not pin the exact volume set")
    receipt_path = value.get("receipt_path")
    receipt_sha = value.get("receipt_sha256")
    if not isinstance(receipt_path, str):
        raise RecoveryAborted("backend volume cache receipt path is missing")
    receipt_file = _absolute_no_follow(Path(receipt_path),
                                       "backend volume cache receipt path")
    if receipt_sha is not None and (
            not isinstance(receipt_sha, str)
            or re.fullmatch(r"[0-9a-f]{64}", receipt_sha) is None):
        raise RecoveryAborted("backend volume cache receipt digest is invalid")
    receipt_document = _read_json_record(receipt_file, "backend volume cache receipt")
    receipt_raw = _regular_bytes(receipt_file, "backend volume cache receipt")
    if (receipt_document != dict(receipt)
            or (receipt_sha is not None
                and hashlib.sha256(receipt_raw).hexdigest() != receipt_sha)):
        raise RecoveryAborted("backend volume cache receipt changed or differs from its pin")
    documents = value.get("volume_documents")
    if not isinstance(documents, Mapping):
        raise RecoveryAborted("backend volume cache has no inspected volume set")
    try:
        adapter._validate_volume_documents(documents, value)
    except Exception as error:
        raise RecoveryAborted(f"backend volume cache volume proof is invalid: {error}") from error
    return adapter


def _validate_backend_volume_cache_target(
    target: Mapping[str, Any], cache: Mapping[str, Any], client: Callable[..., Any] | None = None,
) -> None:
    """Validate the ready descriptor before probing or mounting its volumes."""

    try:
        from docker_orphan_recovery import _validate_backend_volume_cache
        _validate_backend_volume_cache(cache)
    except RecoveryAborted:
        raise
    except Exception as error:
        raise RecoveryAborted(
            f"backend volume cache descriptor failed closed before maintenance: {error}"
        ) from error

    adapter = _backend_volume_cache_adapter(cache)
    labels = target.get("Config", {}).get("Labels", {})
    if cache.get("control_project") != labels.get("com.docker.compose.project"):
        raise RecoveryAborted("backend control volume belongs to another Compose group")
    mounts = {
        item.get("Destination"): item
        for item in target.get("Mounts", [])
        if isinstance(item, Mapping)
    }
    expected = {
        adapter.BUILD_TARGET: adapter.BUILD_VOLUME_ROLE,
        adapter.PACKAGE_TARGET: adapter.PACKAGE_VOLUME_ROLE,
        adapter.CONTROL_TARGET: adapter.CONTROL_VOLUME_ROLE,
    }
    for destination, role in expected.items():
        mount = mounts.get(destination)
        if (not isinstance(mount, Mapping) or mount.get("Type") != "volume"
                or mount.get("Name") != cache["volume_names"][role]
                or mount.get("RW") is not True):
            raise RecoveryAborted(f"target cache mount {destination} is not the pinned named volume")
    if client is None:
        return
    for role in adapter.VOLUME_ROLES:
        name = cache["volume_names"][role]
        try:
            raw = _docker_call(client, "volume", "inspect", name, timeout=60)
            document = json.loads(raw)
        except (OSError, ValueError, json.JSONDecodeError) as error:
            raise RecoveryUnknown(f"backend cache volume {role} inspect is unavailable") from error
        if not isinstance(document, list) or len(document) != 1:
            raise RecoveryUnknown(f"backend cache volume {role} inspect is ambiguous")
        try:
            adapter._validate_volume_document(document[0], cache, role)
        except Exception as error:
            raise RecoveryUnknown(f"backend cache volume {role} identity changed") from error


def require(condition: object, message: str) -> None:
    if not condition:
        raise ValueError(message)


def _mapping(value: Any, label: str) -> dict[str, Any]:
    require(isinstance(value, Mapping), f"{label} must be an object")
    return dict(value)


def require_request_id(value: str) -> None:
    parsed = uuid.UUID(value)
    require(parsed.int != 0 and str(parsed) == value,
            "request ID must be a canonical nonzero UUID and preserved for replay")


def canonical_bytes(document: Mapping[str, Any]) -> bytes:
    return json.dumps(document, sort_keys=True, ensure_ascii=False,
                      separators=(",", ":")).encode("utf-8")


def native_arguments(phase: str, request_path: str,
                     attestation_path: str | None = None) -> list[str]:
    require(phase in {"prepare", "complete"}, "unknown orphan recovery phase")
    for path in [request_path, *([attestation_path] if attestation_path else [])]:
        require(isinstance(path, str) and
                re.fullmatch(r"/state/diagnostics/[A-Za-z0-9._/-]+", path) and
                ".." not in path.split("/"), "recovery input path is outside diagnostics")
    require((phase == "complete") == bool(attestation_path),
            "only completion requires a teardown attestation")
    command = [NATIVE_PROGRAM,
               "--prepare-orphan-teardown" if phase == "prepare"
               else "--recover-orphan-after-teardown",
               "--config", CONFIG_PATH, "--request", request_path]
    if attestation_path:
        command += ["--attestation", attestation_path]
    return command


def maintenance_compose(target: Mapping[str, Any], project: str,
                        request_id: str, command: Sequence[str], *,
                        preflight: bool = False,
                        backend_cache: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """Derive minimum mounts from the exact backend; never inherit its GPU."""
    require_request_id(request_id)
    require(re.fullmatch(r"fullmag-(?:master|worktree-[a-z0-9._-]+)", project),
            "invalid checkout Compose project")
    labels = target["Config"].get("Labels", {})
    require(labels.get("com.docker.compose.project") == project and
            labels.get("com.docker.compose.service") == "backend",
            "target is not this checkout's backend")
    require(re.fullmatch(r"sha256:[0-9a-f]{64}", target["Image"]),
            "target image is not immutable")
    require(not target["HostConfig"].get("Privileged") and
            target["HostConfig"].get("PidMode", "") in {"", "private"},
            "target does not have a private unprivileged process scope")
    require(command and all(isinstance(item, str) for item in command),
            "maintenance command is missing")
    mounts = {item["Destination"]: item for item in target["Mounts"]}
    require(MUTABLE_MOUNTS | {"/opt/fullmag/package"} <= mounts.keys(),
            "target lacks the exact store, ledger, or cached package mount")
    volumes = []
    for destination in sorted((READONLY_MOUNTS | MUTABLE_MOUNTS) & mounts.keys()):
        mount = mounts[destination]
        read_only = preflight or destination in READONLY_MOUNTS
        if mount.get("Type") == "volume":
            require(destination == "/opt/fullmag/package" and backend_cache is not None,
                    "v2 recovery requires the typed backend volume cache proof")
            _validate_backend_volume_cache_target(target, backend_cache)
            name = mount.get("Name")
            require(name == backend_cache["volume_names"]["package"],
                    "recovery package volume differs from its exact v2 pin")
            volumes.append({"type": "volume", "source": name,
                            "target": destination, "read_only": read_only,
                            "volume": {"nocopy": True}})
        else:
            require(mount["Type"] == "bind" and mount.get("Source"),
                    "recovery requires an existing exact bind mount")
            volumes.append({"type": "bind", "source": mount["Source"],
                            "target": destination, "read_only": read_only,
                            "bind": {"create_host_path": False}})
    environment = {}
    for entry in target["Config"].get("Env", []):
        name, separator, value = entry.partition("=")
        if separator and name in ENVIRONMENT_NAMES:
            environment[name] = value
    environment.update({"FULLMAG_DOCKER_ROLE": "backend-recovery",
                        "FULLMAG_STARTUP_ENABLED": "0",
                        "NVIDIA_VISIBLE_DEVICES": "void",
                        "CUDA_VISIBLE_DEVICES": ""})
    service = {
        "image": target["Image"], "pull_policy": "never",
        "entrypoint": list(command), "command": [],
        "init": True, "restart": "no", "network_mode": "none",
        "runtime": "runc", "ipc": "private", "read_only": True,
        "cap_drop": ["ALL"], "security_opt": ["no-new-privileges:true"],
        "tmpfs": ["/tmp:rw,nosuid,nodev,size=64m"],
        "environment": environment, "volumes": volumes,
        "healthcheck": {"disable": True},
        "labels": {"fullmag.recovery.request_id": request_id,
                   "fullmag.recovery.target_container": target["Id"]},
    }
    if target["Config"].get("User"):
        service["user"] = target["Config"]["User"]
    return {"name": project, "services": {"backend-recovery": service}}


LOADER_PROBE = r'''
import json, pathlib, subprocess, sys
binary = '/opt/fullmag/package/bin/fullmag-runtime-service'
if any(pathlib.Path(p).exists() for p in ['/dev/dxg', '/dev/nvidia0', '/dev/nvidiactl']):
    raise SystemExit('maintenance must not receive GPU devices')
p = subprocess.run([binary, '--fullmag-recovery-loader-probe'],
                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
if p.returncode != 1 or b'usage: fullmag-runtime-service' not in p.stderr:
    sys.stderr.buffer.write(p.stderr)
    raise SystemExit('recovery loader preflight failed; target remains untouched')
print(json.dumps({'schema':'fullmag.orphan-recovery-loader.v1','status':'ready'}))
'''


NONCOMPUTE_EXECUTOR = r'''
import hashlib, json, os, pathlib, re, subprocess, sys, tempfile
expected, grant_json, binary, *arguments = sys.argv[1:]
grant_context = json.loads(grant_json)
if binary != '/opt/fullmag/package/bin/fullmag-runtime-service' or not arguments:
    raise SystemExit('only the pinned native administrative command is permitted')
if arguments[0] not in {'--fullmag-recovery-loader-probe',
                        '--prepare-orphan-teardown', '--recover-orphan-after-teardown'}:
    raise SystemExit('ordinary runtime or solver startup is forbidden in recovery')
if any(pathlib.Path(p).exists() for p in ['/dev/dxg', '/dev/nvidia0', '/dev/nvidiactl']):
    raise SystemExit('maintenance must not receive GPU devices')
root = pathlib.Path('/usr/local/cuda').resolve(strict=True)
stub = next((candidate.resolve(strict=True) for candidate in (
    root / 'targets/x86_64-linux/lib/stubs/libcuda.so',
    root / 'lib64/stubs/libcuda.so',
) if candidate.is_file()), None)
if stub is None or 'stubs' not in stub.relative_to(root).parts or not 0 < stub.stat().st_size <= 2 * 1024 * 1024:
    raise SystemExit('pinned CUDA SDK administrative loader is unavailable')
digest = hashlib.sha256(stub.read_bytes()).hexdigest()
if not re.fullmatch('[0-9a-f]{64}', expected) or digest != expected:
    raise SystemExit('CUDA SDK administrative loader differs from its image pin')
temporary = pathlib.Path(tempfile.mkdtemp(prefix='fullmag-recovery-loader-', dir='/tmp'))
(temporary / 'libcuda.so.1').symlink_to(stub)
environment = dict(os.environ)
environment['LD_LIBRARY_PATH'] = str(temporary) + ':' + environment.get('LD_LIBRARY_PATH', '')
environment['FULLMAG_RECOVERY_NONCOMPUTE_LOADER'] = 'cuda-sdk-stub'
if arguments[0] == '--fullmag-recovery-loader-probe':
    p = subprocess.run([binary, *arguments], env=environment,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    if p.returncode != 1 or b'usage: fullmag-runtime-service' not in p.stderr:
        sys.stderr.buffer.write(p.stderr)
        raise SystemExit('noncompute recovery loader failed; target remains untouched')
    print(json.dumps({'schema':'fullmag.orphan-recovery-loader.v1', 'status':'ready',
                      'mode':'cuda-sdk-stub', 'stub_sha256':digest, 'gpu_devices':False}))
else:
    if grant_context is not None:
        proof = _issue_recovery_namespace_grant(grant_context)
        print(json.dumps(proof, sort_keys=True), flush=True)
    os.execve(binary, [binary, *arguments], environment)
'''


def _namespace_grant_module():
    import importlib.util
    module_path = Path(__file__).with_name("docker_orphan_namespace_grant.py")
    spec = importlib.util.spec_from_file_location("docker_orphan_namespace_grant", module_path)
    require(spec is not None and spec.loader is not None, "namespace grant helper is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _grant_context(target: Mapping[str, Any], request: Mapping[str, Any],
                   phase: str) -> dict[str, Any] | None:
    environment = dict(entry.split("=", 1) for entry in target["Config"].get("Env", [])
                       if "=" in entry)
    profile = environment.get("FULLMAG_SESSION_STORAGE_PROFILE")
    require(profile in {None, "windows-folder-v1"}, "unknown recovery session storage profile")
    if profile is None:
        # Native ext4 admission has no Windows storage-profile override.
        return None
    require(any(m.get("Destination") == "/run/fullmag/windows-folder-host.json"
                for m in target.get("Mounts", [])),
            "Windows recovery requires the exact mounted host certificate")
    return _namespace_grant_module().build_grant_context(
        request, phase, image_id=target["Image"], target_container_id=target["Id"])


def _assert_failed_keeper_only(client: Callable[..., Any], target: Mapping[str, Any]) -> None:
    """Before replacing a Windows grant, require the terminal keeper alone.

    Failed owner metadata is checked again by the guest and native locks. This
    host observation additionally rejects a live API, worker, or build process.
    """
    output = _docker_call(client, "top", str(target["Id"]), "-eo", "pid,ppid,comm,args")
    rows = [line.split(None, 3) for line in output.splitlines()[1:] if line.strip()]
    require(len(rows) == 2 and all(len(row) == 4 for row in rows),
            "Windows grant rotation requires only the failed backend keeper")
    init = next((row for row in rows if row[2] == "docker-init"), None)
    keeper = next((row for row in rows if row[2] == "python3"), None)
    require(init is not None and keeper is not None and
            init[0].isdigit() and int(init[0]) == target["State"].get("Pid") and
            keeper[1] == init[0] and
            keeper[3] == "/usr/local/bin/python3 /opt/fullmag/entrypoint.py",
            "a live writer or unexpected process blocks Windows grant rotation")


def _validate_phase_grant(phase: Mapping[str, Any], context: Mapping[str, Any] | None) -> None:
    if context is None:
        return
    module = _namespace_grant_module()
    proofs = []
    for line in str(phase.get("output", "")).splitlines():
        try:
            value = json.loads(line)
        except (ValueError, TypeError):
            continue
        if isinstance(value, dict) and value.get("schema") == module.PROOF_SCHEMA:
            proofs.append(value)
    require(len(proofs) == 1, "maintenance lacks one exact namespace grant proof")
    module.validate_grant_receipt(proofs[0], context)


def noncompute_command(command: Sequence[str], stub_sha256: str,
                       grant_context: Mapping[str, Any] | None = None) -> list[str]:
    require(re.fullmatch(r"[0-9a-f]{64}", stub_sha256), "invalid SDK loader digest")
    require(len(command) > 1 and command[0] == NATIVE_PROGRAM and command[1] in {
        "--fullmag-recovery-loader-probe", "--prepare-orphan-teardown",
        "--recover-orphan-after-teardown"}, "recovery cannot start an ordinary runtime")
    script = NONCOMPUTE_EXECUTOR
    if grant_context is not None:
        require(command[1] != "--fullmag-recovery-loader-probe",
                "read-only loader probe must not rotate a grant")
        script = _namespace_grant_module().GUEST_NAMESPACE_GRANT_SCRIPT + "\n" + script
    return ["python3", "-c", script, stub_sha256,
            json.dumps(grant_context, sort_keys=True, separators=(",", ":")), *command]


def assert_shared_clients_quiescent(target: Mapping[str, Any],
                                    running: Sequence[Mapping[str, Any]]) -> None:
    def normalized_source(source: Any) -> str:
        require(isinstance(source, str) and source.startswith("/"),
                "running client host mount source cannot be verified")
        # These are Linux daemon paths, not paths on the Windows CLI host.
        return posixpath.normpath("/" + source.lstrip("/"))

    ledger_mount = normalized_source(next(item["Source"] for item in target["Mounts"]
                                         if item["Destination"] == "/host-ledger"))
    for container in running:
        if container["Id"] == target["Id"]:
            continue
        for item in container.get("Mounts", []):
            if not item.get("RW") or item.get("Type") == "tmpfs":
                continue
            source = normalized_source(item.get("Source"))
            shared = (source == ledger_mount
                      or source.startswith(ledger_mount.rstrip("/") + "/")
                      or ledger_mount.startswith(source.rstrip("/") + "/"))
            require(not shared, "another running client can write this host ledger; "
                    "stop and upgrade it before publishing the new release proof")


class RecoveryUnknown(RuntimeError):
    """A Docker operation did not produce enough evidence to continue safely."""


class RecoveryAborted(ValueError):
    """A preflight or native validation failed before target stop."""


def _pure_module():
    try:
        from docker_orphan_recovery import (
            build_orphan_request,
            build_teardown_attestation,
            canonical_json_sha256,
            finalize,
            write_immutable_json,
        )
    except ImportError as error:  # pragma: no cover - packaging error
        raise RuntimeError("docker_orphan_recovery.py is not available") from error
    return (build_orphan_request, build_teardown_attestation,
            canonical_json_sha256, finalize, write_immutable_json)


def _pure_validators():
    """Load native replay validators without changing the builder seam."""
    try:
        from docker_orphan_recovery import (
            validate_orphan_request, validate_teardown_attestation,
        )
    except ImportError as error:  # pragma: no cover - packaging error
        raise RuntimeError("docker_orphan_recovery.py is not available") from error
    return validate_orphan_request, validate_teardown_attestation


def _regular_bytes(path: Path, label: str, maximum: int = MAX_DOCUMENT) -> bytes:
    try:
        metadata = path.lstat()
    except OSError as error:
        raise RecoveryAborted(f"cannot inspect {label}: {error}") from error
    if path.is_symlink() or not path.is_file() or metadata.st_size <= 0 or metadata.st_size > maximum:
        raise RecoveryAborted(f"{label} is not a bounded regular file")
    try:
        first = path.read_bytes()
        second = path.read_bytes()
    except OSError as error:
        raise RecoveryAborted(f"cannot read {label}: {error}") from error
    if first != second or len(first) != metadata.st_size:
        raise RecoveryAborted(f"{label} changed while it was read")
    return first


def _read_json_record(path: Path, label: str) -> dict[str, Any]:
    """Read one immutable JSON evidence record without following a link."""
    try:
        raw = _regular_bytes(path, label)
        document = json.loads(raw.decode("utf-8"))
    except Exception as error:
        raise RecoveryUnknown(f"cannot read immutable {label}: {error}") from error
    if not isinstance(document, dict):
        raise RecoveryUnknown(f"immutable {label} is not a JSON object")
    return document


def _validate_maintenance_created_mounts(
    service: Mapping[str, Any], created: Mapping[str, Any]
) -> None:
    """Require daemon-reported mounts and isolation to match the request."""
    expected_volumes = service.get("volumes")
    if not isinstance(expected_volumes, list):
        raise RecoveryAborted("maintenance service has no volume specification")
    expected: dict[str, dict[str, Any]] = {}
    for volume in expected_volumes:
        if not isinstance(volume, Mapping):
            raise RecoveryAborted("maintenance volume specification is invalid")
        destination = volume.get("target")
        source = volume.get("source")
        volume_type = volume.get("type")
        if (not isinstance(destination, str) or not isinstance(source, str)
                or volume_type not in {"bind", "volume"}):
            raise RecoveryAborted("maintenance volume has invalid typed mount")
        if destination in expected:
            raise RecoveryAborted(f"duplicate maintenance mount: {destination}")
        expected[destination] = {
            "Type": volume_type,
            ("Source" if volume_type == "bind" else "Name"): source,
            "Destination": destination,
            "RW": not bool(volume.get("read_only", False)),
        }
    tmpfs_specs = service.get("tmpfs", [])
    if not isinstance(tmpfs_specs, list):
        raise RecoveryAborted("maintenance tmpfs specification is invalid")
    expected_tmpfs: dict[str, str] = {}
    for specification in tmpfs_specs:
        if not isinstance(specification, str):
            raise RecoveryAborted("maintenance tmpfs specification is invalid")
        destination, separator, mode = specification.partition(":")
        if (not separator or not destination.startswith("/") or
                ".." in Path(destination).parts or not mode):
            raise RecoveryAborted("maintenance tmpfs specification has invalid path or mode")
        if destination in expected or destination in expected_tmpfs:
            raise RecoveryAborted(f"duplicate maintenance mount: {destination}")
        expected_tmpfs[destination] = mode
    mounts = created.get("Mounts")
    if not isinstance(mounts, list):
        raise RecoveryAborted("maintenance inspect omitted actual mounts")
    actual: dict[str, Mapping[str, Any]] = {}
    for mount in mounts:
        if not isinstance(mount, Mapping):
            raise RecoveryAborted("maintenance inspect contains invalid mount")
        destination = mount.get("Destination")
        if not isinstance(destination, str) or destination in actual:
            raise RecoveryAborted("maintenance inspect contains duplicate mount")
        actual[destination] = mount
    actual_managed_destinations = {
        destination for destination, mount in actual.items()
        if mount.get("Type") in {"bind", "volume"}
    }
    if actual_managed_destinations != set(expected):
        raise RecoveryAborted("maintenance managed mounts differ from the requested set")
    actual_tmpfs_destinations = {
        destination for destination, mount in actual.items()
        if mount.get("Type") == "tmpfs"
    }
    if set(actual) != actual_managed_destinations | actual_tmpfs_destinations:
        raise RecoveryAborted("maintenance inspect contains an unsupported mount type")
    if not actual_tmpfs_destinations <= set(expected_tmpfs):
        raise RecoveryAborted("maintenance inspect contains an undeclared tmpfs mount")
    for destination, wanted in expected.items():
        observed = actual[destination]
        fields = ("Type", "Source", "Destination") if wanted["Type"] == "bind" else ("Type", "Name", "Destination")
        for field in fields:
            if observed.get(field) != wanted[field]:
                raise RecoveryAborted(
                    f"maintenance mount {destination} has unexpected {field}"
                )
        if bool(observed.get("RW")) != bool(wanted["RW"]):
            raise RecoveryAborted(
                f"maintenance mount {destination} has unexpected read/write mode"
            )
    for destination in actual_tmpfs_destinations:
        observed = actual[destination]
        if (observed.get("Destination") != destination or
                observed.get("RW") is not True or
                observed.get("Mode") != expected_tmpfs[destination] or
                observed.get("Source") not in (None, "", "tmpfs")):
            raise RecoveryAborted(
                f"maintenance tmpfs mount {destination} differs from the requested set"
            )
    config = created.get("Config")
    host = created.get("HostConfig")
    if not isinstance(config, Mapping) or not isinstance(host, Mapping):
        raise RecoveryAborted("maintenance inspect omitted Config or HostConfig")
    if config.get("User", "") != service.get("user", ""):
        raise RecoveryAborted("maintenance user changed after create")
    if host.get("NetworkMode") != "none":
        raise RecoveryAborted("maintenance network is not none")
    if host.get("Runtime") != "runc":
        raise RecoveryAborted("maintenance runtime is not runc")
    observed_tmpfs = host.get("Tmpfs")
    if observed_tmpfs is None:
        observed_tmpfs = {}
    if not isinstance(observed_tmpfs, Mapping):
        raise RecoveryAborted("maintenance inspect has invalid tmpfs configuration")
    if dict(observed_tmpfs) != expected_tmpfs:
        raise RecoveryAborted("maintenance tmpfs configuration differs from the request")
    if host.get("IpcMode") != "private":
        raise RecoveryAborted("maintenance IPC is not private")
    if host.get("ReadonlyRootfs") is not True:
        raise RecoveryAborted("maintenance root filesystem is writable")
    if host.get("Privileged") is not False:
        raise RecoveryAborted("maintenance container is privileged")
    if host.get("PidMode") not in ("", "private", None):
        raise RecoveryAborted("maintenance PID namespace is not private")
    if host.get("DeviceRequests") not in (None, []):
        raise RecoveryAborted("maintenance container has device requests")
    if host.get("Devices") not in (None, []):
        raise RecoveryAborted("maintenance container has host devices")
    if list(host.get("CapAdd") or []):
        raise RecoveryAborted("maintenance container adds capabilities")
    if set(host.get("CapDrop") or []) != {"ALL"}:
        raise RecoveryAborted("maintenance container did not drop all capabilities")
    if "no-new-privileges:true" not in set(host.get("SecurityOpt") or []):
        raise RecoveryAborted("maintenance container lacks no-new-privileges")


def _load_pins(path: Path) -> tuple[dict[str, Any], str]:
    raw = _regular_bytes(path, "orphan recovery pins", 16 * 1024 * 1024)
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RecoveryAborted(f"orphan recovery pins are not valid JSON: {error}") from error
    if not isinstance(value, dict):
        raise RecoveryAborted("orphan recovery pins must be a JSON object")
    return value, hashlib.sha256(raw).hexdigest()


def _docker_unknown(error: BaseException) -> bool:
    return (isinstance(error, (TimeoutError, subprocess.TimeoutExpired)) or
            error.__class__.__name__ == "DockerOutcomeUnknown")


def _docker_factual_not_found(error: BaseException) -> bool:
    """Accept only a daemon's explicit absent-container result during cleanup."""
    text = str(error).lower()
    return ("no such container" in text or
            ("container" in text and "not found" in text))


def _docker_call(client: Callable[..., Any], *args: str, timeout: int = 60,
                 combined: bool = False) -> str:
    try:
        value = (client(*args, timeout=timeout, combined=True) if combined
                 else client(*args, timeout=timeout))
    except BaseException as error:
        if _docker_unknown(error):
            raise RecoveryUnknown(f"Docker operation timed out or became unknown: {args[0]}") from error
        raise
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="replace")
    if not isinstance(value, str):
        raise RecoveryAborted(f"Docker operation returned a non-text result: {args[0]}")
    if len(value.encode("utf-8", errors="replace")) > MAX_OUTPUT:
        raise RecoveryAborted(f"Docker operation output exceeds its bound: {args[0]}")
    return value


def _docker_json(client: Callable[..., Any], *args: str, timeout: int = 60) -> Any:
    raw = _docker_call(client, *args, timeout=timeout)
    try:
        return json.loads(raw)
    except json.JSONDecodeError as error:
        raise RecoveryAborted(f"Docker operation did not return JSON: {args[0]}") from error


def _inspect(client: Callable[..., Any], container_id: str) -> dict[str, Any]:
    require(re.fullmatch(r"[0-9a-f]{64}", container_id),
            "Docker inspect requires a full immutable container ID")
    value = _docker_json(client, "inspect", container_id)
    if not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], dict):
        raise RecoveryAborted("Docker inspect did not return exactly one container")
    document = value[0]
    if document.get("Id") != container_id:
        raise RecoveryAborted("Docker inspect returned a different container identity")
    return document


def _engine(client: Callable[..., Any]) -> dict[str, Any]:
    engine_id = _docker_call(client, "info", "--format", "{{.ID}}", timeout=30).strip()
    from docker_orphan_recovery import OrphanRecoveryError, validate_engine_id

    try:
        validate_engine_id(engine_id)
    except OrphanRecoveryError as error:
        raise RecoveryAborted("Docker engine did not return an immutable ID") from error
    return {"ID": engine_id}


def _running_containers(client: Callable[..., Any]) -> list[dict[str, Any]]:
    raw = _docker_call(client, "ps", "--quiet", "--no-trunc", timeout=30)
    ids = [line.strip() for line in raw.splitlines() if line.strip()]
    if len(ids) > 256:
        raise RecoveryAborted("running Docker container inventory exceeds its bound")
    if any(re.fullmatch(r"[0-9a-f]{64}", item) is None for item in ids):
        raise RecoveryAborted("running Docker inventory did not return full container IDs")
    return [_inspect(client, item) for item in ids]


def _target_mount(target: Mapping[str, Any], destination: str) -> dict[str, Any]:
    for item in target.get("Mounts", []):
        if isinstance(item, Mapping) and item.get("Destination") == destination:
            return dict(item)
    raise RecoveryAborted(f"target does not expose required bind {destination}")


def _absolute_no_follow(path: Path, label: str) -> Path:
    """Make a lexical absolute path while rejecting existing link ancestors."""

    candidate = Path(os.fspath(path))
    if not candidate.is_absolute():
        raise RecoveryAborted(f"{label} is not absolute")
    if any(part in {"..", ""} for part in candidate.parts):
        raise RecoveryAborted(f"{label} contains parent traversal")
    current = Path(candidate.anchor)
    for part in candidate.parts[1:]:
        current /= part
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            continue
        except OSError as error:
            raise RecoveryAborted(f"cannot inspect {label}: {error}") from error
        if stat.S_ISLNK(metadata.st_mode) or bool(
                getattr(metadata, "st_file_attributes", 0) & 0x400):
            raise RecoveryAborted(f"{label} contains a symlink or reparse-point ancestor")
    return candidate


def _assert_diagnostics_binding(target: Mapping[str, Any], root: Path) -> Path:
    """Keep every host evidence file inside the target's exact /state bind."""

    mount = _target_mount(target, "/state")
    require(mount.get("Type") == "bind" and mount.get("RW") is True and
            isinstance(mount.get("Source"), str) and mount["Source"],
            "target state is not an exact writable bind")
    source = _absolute_no_follow(Path(str(mount["Source"])), "target state bind source")
    candidate = _absolute_no_follow(Path(root), "diagnostics root")
    diagnostics = source / "diagnostics"
    if candidate != diagnostics:
        raise RecoveryAborted(
            "diagnostics root must be exactly the target /state/diagnostics bind")
    return candidate


PACKAGE_PROBE_SCRIPT = r'''
import hashlib, importlib.util, json, pathlib, sys
root = pathlib.Path('/opt/fullmag/package')
helper_path = pathlib.Path('/opt/fullmag/backend_dev.py')
def fail(message):
    raise SystemExit(message)
if root.is_symlink() or not root.is_dir():
    fail('canonical package root is unavailable')
if helper_path.is_symlink() or not helper_path.is_file():
    fail('trusted backend package validator is unavailable')
sys.path.insert(0, str(helper_path.parent))
spec = importlib.util.spec_from_file_location('fullmag_trusted_backend_dev', helper_path)
if spec is None or spec.loader is None:
    fail('trusted backend package validator cannot be loaded')
module = importlib.util.module_from_spec(spec)
try:
    spec.loader.exec_module(module)
    receipt, receipt_bytes, _children = module._validated_package(
        root, 'cached package', exclude_development_control=True
    )
except Exception as error:
    fail(f'trusted package validation failed: {error}')
if not isinstance(receipt, dict) or receipt.get('state') != 'succeeded':
    fail('package receipt is not a successful build')
artifacts = receipt.get('artifacts')
if not isinstance(artifacts, list) or not artifacts:
    fail('package receipt has no artifacts')
for item in artifacts:
    if not isinstance(item, dict) or set(item) != {'path','size','sha256','mode'}:
        fail('trusted package artifact record is malformed')
    if item['mode'] not in {'100755', '100644'}:
        fail('trusted package artifact mode is not canonical')
artifacts = sorted(artifacts, key=lambda item: item['path'])
package_sha = hashlib.sha256(json.dumps(
    {'artifacts': artifacts}, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
print(json.dumps({'schema':'fullmag.docker.cached-package-probe.v1',
                  'package_root':'/opt/fullmag/package',
                  'receipt_path':'/opt/fullmag/package/backend-build-receipt.json',
                  'receipt_sha256':hashlib.sha256(receipt_bytes).hexdigest(),
                  'package_sha256':package_sha, 'read_only_mount':True,
                  'state':'succeeded', 'receipt':receipt, 'artifacts':artifacts},
                 sort_keys=True, separators=(',',':')))
'''

SDK_LOADER_DIGEST_PROBE = r'''
import hashlib, json, pathlib
if any(pathlib.Path(item).exists() for item in ('/dev/dxg','/dev/nvidia0','/dev/nvidiactl')):
    raise SystemExit('GPU device is present in the noncompute loader probe')
root = pathlib.Path('/usr/local/cuda').resolve(strict=True)
stub = next((candidate.resolve(strict=True) for candidate in (
    root / 'targets/x86_64-linux/lib/stubs/libcuda.so',
    root / 'lib64/stubs/libcuda.so',
) if candidate.is_file()), None)
if stub is None or root not in stub.parents or 'stubs' not in stub.relative_to(root).parts:
    raise SystemExit('CUDA SDK stub is unavailable')
data = stub.read_bytes()
if not data or len(data) > 2 * 1024 * 1024:
    raise SystemExit('CUDA SDK stub is outside its bound')
print(json.dumps({'schema':'fullmag.orphan-recovery-loader-pin.v1',
                  'status':'ready', 'stub_sha256':hashlib.sha256(data).hexdigest(),
                  'gpu_devices':False}, sort_keys=True, separators=(',',':')))
'''


def _parse_last_json(raw: str, label: str) -> dict[str, Any]:
    for line in reversed([line.strip() for line in raw.splitlines() if line.strip()]):
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    raise RecoveryAborted(f"{label} produced no bounded JSON result")


def _probe_image_loader(
    client: Callable[..., Any], target: Mapping[str, Any], project: str, request_id: str,
    run_maintenance: Callable[..., dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Run the SDK-only loader probe in the exact labeled maintenance service."""

    if run_maintenance is None:
        run_maintenance = lambda target_document, name, command, preflight, phase: _maintenance_run(  # noqa: E731
            client, target_document, project, request_id, command,
            preflight=preflight, phase=phase)
    phase = run_maintenance(
        target, "sdk-loader", ["python3", "-c", SDK_LOADER_DIGEST_PROBE],
        True, "sdk-loader-probe")
    result = phase.get("result")
    require(isinstance(result, Mapping) and
            result.get("schema") == "fullmag.orphan-recovery-loader-pin.v1" and
            result.get("status") == "ready" and result.get("gpu_devices") is False,
            "image loader probe did not produce a noncompute pin")
    digest = result.get("stub_sha256")
    require(isinstance(digest, str) and re.fullmatch(r"[0-9a-f]{64}", digest),
            "image loader probe returned an invalid SDK digest")
    return dict(phase)



def _probe_package_output(raw: str, target: Mapping[str, Any]) -> dict[str, Any]:
    result = _parse_last_json(raw, "cached package probe")
    required = {"schema", "package_root", "receipt_path", "receipt_sha256",
                "package_sha256", "read_only_mount", "state", "receipt", "artifacts"}
    require(set(result) == required, "cached package probe has unexpected fields")
    image = target.get("Image")
    container_id = target.get("Id")
    require(isinstance(container_id, str) and isinstance(image, str),
            "target identity is unavailable for package probe binding")
    result = dict(result)
    # The maintenance service has the exact image and package bind, while the
    # target identity is the binding being recovered.  This host binding is
    # accepted only after the target and its package source were inspected.
    result.update({"container_id": container_id, "image_id": image})
    return result


def _command_parts(command: Sequence[str]) -> tuple[str, list[str]]:
    require(command and all(isinstance(item, str) and item for item in command),
            "maintenance command is missing")
    if command[0] in {"python3", "/usr/local/bin/python3"}:
        return "/usr/local/bin/python3", list(command[1:])
    return command[0], list(command[1:])


def _maintenance_create_args(spec: Mapping[str, Any], *, name: str) -> list[str]:
    service = _mapping(spec["services"][RECOVERY_CONTAINER_SERVICE], "recovery service")
    image = service.get("image")
    entrypoint, command = _command_parts(service["entrypoint"])
    args = ["create", "--name", name, "--pull", "never",
            "--network", "none", "--ipc", "private",
            "--runtime", "runc",
            "--read-only", "--init", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges:true"]
    if service.get("user"):
        args += ["--user", str(service["user"])]
    for item in service.get("tmpfs", []):
        args += ["--tmpfs", str(item)]
    for key, value in sorted(service.get("environment", {}).items()):
        args += ["--env", f"{key}={value}"]
    labels = dict(service.get("labels", {}))
    labels.update({"com.docker.compose.project": str(spec["name"]),
                   "com.docker.compose.service": RECOVERY_CONTAINER_SERVICE})
    for key, value in sorted(labels.items()):
        args += ["--label", f"{key}={value}"]
    for volume in service.get("volumes", []):
        volume_type = volume.get("type")
        require(volume_type in {"bind", "volume"} and volume.get("source")
                and volume.get("target"), "maintenance service has an invalid typed mount")
        if volume_type == "volume":
            mount = f"type=volume,src={volume['source']},dst={volume['target']}"
            options = volume.get("volume", {})
            require(isinstance(options, Mapping),
                    "maintenance service has invalid volume options")
            if options.get("nocopy") is True:
                mount += ",volume-nocopy"
        else:
            mount = f"type=bind,src={volume['source']},dst={volume['target']}"
        if volume.get("read_only"):
            mount += ",readonly"
        args += ["--mount", mount]
    require(isinstance(image, str) and re.fullmatch(r"sha256:[0-9a-f]{64}", image),
            "maintenance image is not immutable")
    args += ["--entrypoint", entrypoint, image, *command]
    return args


def _maintenance_run(client: Callable[..., Any], target: Mapping[str, Any], project: str,
                     request_id: str, command: Sequence[str], *, preflight: bool,
                     phase: str,
                     backend_cache: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """Run one exact, non-networked maintenance container and retain evidence."""

    spec = maintenance_compose(
        target, project, request_id, command, preflight=preflight,
        backend_cache=backend_cache,
    )
    name = f"fullmag-recovery-{request_id[:8]}-{phase}"
    created = _docker_call(client, *_maintenance_create_args(spec, name=name), timeout=60).strip()
    if not re.fullmatch(r"[0-9a-f]{64}", created):
        raise RecoveryAborted("maintenance container create did not return a full ID")
    created_document = _inspect(client, created)
    created_host = created_document.get("HostConfig", {})
    created_config = created_document.get("Config", {})
    require(isinstance(created_host, Mapping) and isinstance(created_config, Mapping),
            "maintenance container inspect lacks isolation fields")
    created_labels = created_config.get("Labels", {})
    require(isinstance(created_labels, Mapping) and
            created_labels.get("com.docker.compose.project") == project and
            created_labels.get("com.docker.compose.service") == RECOVERY_CONTAINER_SERVICE and
            created_labels.get("fullmag.recovery.request_id") == request_id and
            created_labels.get("fullmag.recovery.target_container") == target.get("Id"),
            "maintenance container is outside the pinned recovery project")
    _validate_maintenance_created_mounts(
        _mapping(spec["services"][RECOVERY_CONTAINER_SERVICE], "recovery service"),
        created_document,
    )
    require(created_host.get("PidMode", "") in {"", "private"} and
            created_host.get("NetworkMode") == "none" and
            created_host.get("Privileged") is False and
            not created_host.get("DeviceRequests"),
            "maintenance container did not preserve private non-GPU isolation")
    require(created_document.get("Image") == target.get("Image"),
            "maintenance container image differs from the pinned target")
    started = False
    try:
        _docker_call(client, "start", created, timeout=60)
        started = True
        _docker_call(client, "wait", created, timeout=300)
        output = _docker_call(client, "logs", "--tail", "200", created,
                              timeout=30, combined=True)
        inspected = _inspect(client, created)
    except RecoveryUnknown:
        raise
    except BaseException as error:
        if started:
            raise RecoveryUnknown(
                f"maintenance phase {phase} became uncertain after start: {error}"
            ) from error
        raise RecoveryAborted(f"maintenance phase {phase} failed before start: {error}") from error
    state = inspected.get("State", {})
    if not isinstance(state, Mapping) or state.get("Status") != "exited" or state.get("Running") is not False:
        raise RecoveryUnknown(f"maintenance phase {phase} did not produce a factual exit")
    exit_code = state.get("ExitCode")
    if exit_code != 0:
        raise RecoveryUnknown(
            f"maintenance phase {phase} exited unsuccessfully after start: {output[-2000:]}"
        )
    try:
        result = _parse_last_json(output, f"maintenance phase {phase}")
    except RecoveryUnknown:
        raise
    except BaseException as error:
        raise RecoveryUnknown(
            f"maintenance phase {phase} produced uncertain output after start: {error}"
        ) from error
    # The caller must persist the terminal inspect/log evidence before this
    # technical container is removed. Unknown/error paths deliberately leave
    # it in place for operator inspection.
    return {"result": result, "container_id": created, "inspect": inspected, "output": output}


def _cleanup_maintenance(client: Callable[..., Any], phase: Mapping[str, Any]) -> None:
    """Remove only a completed, fully evidenced maintenance container."""

    container_id = phase.get("container_id")
    if container_id is None:
        return
    if not (isinstance(container_id, str) and
            re.fullmatch(r"[0-9a-f]{64}", container_id)):
        raise RecoveryUnknown("maintenance phase has an invalid container identity")
    recorded = phase.get("inspect")
    if not isinstance(recorded, Mapping) or recorded.get("Id") != container_id:
        raise RecoveryUnknown("maintenance phase lacks a bound terminal inspect")
    recorded_state = recorded.get("State")
    if (not isinstance(recorded_state, Mapping) or
            recorded_state.get("Status") != "exited" or
            recorded_state.get("Running") is not False):
        raise RecoveryUnknown("maintenance phase lacks a terminal exited proof")
    recorded_config = recorded.get("Config")
    if not isinstance(recorded_config, Mapping):
        raise RecoveryUnknown("maintenance phase lacks container labels")
    recorded_labels = recorded_config.get("Labels")
    if (not isinstance(recorded_labels, Mapping) or
            recorded_labels.get("com.docker.compose.service") != RECOVERY_CONTAINER_SERVICE):
        raise RecoveryUnknown("maintenance phase is not bound to the recovery service")
    try:
        current = _inspect(client, container_id)
    except RecoveryUnknown:
        raise
    except BaseException as error:
        if _docker_factual_not_found(error):
            return
        raise RecoveryUnknown(
            "maintenance evidence exists but its container inspect became uncertain"
        ) from error
    if _container_identity(current) != _container_identity(recorded):
        raise RecoveryUnknown("maintenance container identity changed before cleanup")
    current_state = current.get("State")
    if (not isinstance(current_state, Mapping) or
            current_state.get("Status") != "exited" or
            current_state.get("Running") is not False):
        raise RecoveryUnknown("maintenance container is not factually exited before cleanup")
    current_config = current.get("Config")
    current_labels = current_config.get("Labels") if isinstance(current_config, Mapping) else None
    if (not isinstance(current_labels, Mapping) or
            current_labels.get("com.docker.compose.service") != RECOVERY_CONTAINER_SERVICE):
        raise RecoveryUnknown("current cleanup target is not the recovery service")
    try:
        _docker_call(client, "rm", container_id, timeout=30)
    except RecoveryUnknown:
        raise
    except BaseException as error:
        if _docker_factual_not_found(error):
            return
        raise RecoveryUnknown(
            "maintenance evidence was durable but its technical container could not be retired"
        ) from error


def _phase_evidence(phase: Mapping[str, Any], name: str) -> dict[str, Any]:
    """Bounded terminal inspect/log proof retained before phase cleanup."""

    return {
        "schema": "fullmag.docker.orphan-maintenance-phase.v1",
        "phase": name,
        "container_id": phase.get("container_id"),
        "inspect": phase.get("inspect"),
        "output": phase.get("output", ""),
    }


def _manifest_observation(document: Mapping[str, Any], *, stopped: bool) -> dict[str, Any]:
    config = document.get("Config", {})
    host = document.get("HostConfig", {})
    state = document.get("State", {})
    require(isinstance(config, Mapping) and isinstance(host, Mapping) and isinstance(state, Mapping),
            "target inspection lacks lifecycle fields")
    pid_mode = host.get("PidMode", "")
    device_requests = host.get("DeviceRequests")
    require(isinstance(device_requests, list), "target inspection lacks DeviceRequests")
    network_mode = host.get("NetworkMode", "")
    require(pid_mode in {"", "private"} and host.get("Privileged") is False and
            isinstance(network_mode, str) and network_mode not in {"host", "container"} and
            not network_mode.startswith("container:") and
            host.get("IpcMode", "") in {"", "private", "none"},
            "target does not prove private namespace")
    proof = None
    if stopped:
        require(state.get("Status") == "exited" and state.get("Running") is False and
                state.get("Pid") == 0 and isinstance(state.get("FinishedAt"), str) and
                bool(state.get("FinishedAt")),
                "stopped target lacks an exited/PID-zero/FinishedAt proof")
        # Docker's private PID namespace is torn down with the exited
        # container.  This is an engine/cgroup contract, not a guessed host
        # process scan; the exact lifecycle fields are retained as evidence.
        proof = {
            "schema": "fullmag.docker.private-pid-namespace-exit.v1",
            "basis": "docker-engine-private-pid-namespace-exit",
            "pid_mode": pid_mode,
            "status": state.get("Status"),
            "running": state.get("Running"),
            "pid": state.get("Pid"),
            "finished_at": state.get("FinishedAt"),
            "cgroup_scope": "container-cgroup-terminated-with-exit",
        }
    return {
        "container_id": document.get("Id"), "image_id": document.get("Image"),
        "service": "backend", "role": "backend", "user": config.get("User"),
        "private_pid_namespace": True, "host_pid": False,
        "device_requests": device_requests,
        "state": "exited" if stopped else state.get("Status"),
        "pid": state.get("Pid"),
        "finished_at": state.get("FinishedAt") if stopped else None,
        "descendant_count": 0 if stopped else None,
        "namespace_teardown_proof": proof,
    }


def _validate_release_pin(pins: Mapping[str, Any], resource_id: str, *,
                          stopped_replay: bool = False) -> dict[str, Any]:
    release = pins.get("device_release")
    require(isinstance(release, Mapping),
            "explicit device mapping pin is required before target stop")
    release = dict(release)
    require(release.get("resource_id") == resource_id,
            "device mapping pin is not bound to the exact resource")
    # Preserve immutable legacy pins only after the replay path independently
    # verified the exact stopped namespace and its recorded attestation.
    require("mapping_detached" not in release or
            (stopped_replay and release["mapping_detached"] is True),
            "device mapping pin cannot assert detachment before factual target exit")
    require(isinstance(release.get("mapping_sha256"), str) and
            re.fullmatch(r"[0-9a-f]{64}", release["mapping_sha256"]),
            "device_release mapping hash is invalid")
    require(set(release["mapping_sha256"]) != {"0"},
            "device_release mapping hash cannot be all zeroes")
    return release


def _write_record(path: Path, value: Mapping[str, Any]) -> str:
    _, _, _, _, write_immutable_json = _pure_module()
    try:
        return write_immutable_json(path, value)
    except Exception as error:
        raise RecoveryAborted(f"cannot publish immutable recovery evidence {path}: {error}") from error


def _validate_native_result(result: Mapping[str, Any], status: str,
                            request_digest: str) -> dict[str, Any]:
    require(result.get("schema_version") == "runtime_service_orphan_teardown_result.v1",
            "native orphan result has an unsupported schema")
    require(result.get("status") == status and result.get("started") is False and
            result.get("solve_replayed") is False and result.get("startup_replayed") is False,
            "native orphan result claims an unexpected lifecycle transition")
    require(result.get("request_sha256") == request_digest,
            "native orphan result is bound to a different request")
    return dict(result)


def _container_identity(document: Mapping[str, Any]) -> dict[str, Any]:
    return {key: document.get(key) for key in ("Id", "Image", "Config", "HostConfig", "Mounts")}


def _revalidate_before_stop(client: Callable[..., Any], target_id: str,
                            target_before: Mapping[str, Any], engine_before: Mapping[str, Any],
                            pins: Mapping[str, Any], request: Mapping[str, Any],
                            pins_sha256: str) -> tuple[dict[str, Any], dict[str, Any]]:
    try:
        current_target = _inspect(client, target_id)
    except RecoveryUnknown:
        raise
    except BaseException as error:
        raise RecoveryUnknown(
            f"backend inspect became uncertain after native prepare: {error}"
        ) from error
    if _container_identity(current_target) != _container_identity(target_before):
        raise RecoveryUnknown("backend identity or mounts changed after native prepare")
    try:
        current_engine = _engine(client)
    except RecoveryUnknown:
        raise
    except BaseException as error:
        raise RecoveryUnknown(
            f"Docker engine inspect became uncertain after native prepare: {error}"
        ) from error
    if current_engine != engine_before:
        raise RecoveryUnknown("Docker engine identity changed after native prepare")
    try:
        running = _running_containers(client)
    except RecoveryUnknown:
        raise
    except BaseException as error:
        raise RecoveryUnknown(
            f"running-container inventory became uncertain after native prepare: {error}"
        ) from error
    try:
        assert_shared_clients_quiescent(current_target, running)
    except RecoveryUnknown:
        raise
    except BaseException as error:
        raise RecoveryUnknown(
            f"shared-ledger quiescence changed after native prepare: {error}"
        ) from error
    pin_path = pins.get("pins_path")
    if isinstance(pin_path, str):
        try:
            observed = hashlib.sha256(
                _regular_bytes(Path(pin_path), "orphan recovery pins")
            ).hexdigest()
        except RecoveryUnknown:
            raise
        except BaseException as error:
            raise RecoveryUnknown(
                f"orphan recovery pins became unreadable after native prepare: {error}"
            ) from error
        if observed != pins_sha256:
            raise RecoveryUnknown("orphan recovery pins changed after native prepare")
    return current_engine, current_target


def _is_factually_stopped(document: Mapping[str, Any]) -> bool:
    state = document.get("State")
    return (isinstance(state, Mapping) and state.get("Status") == "exited" and
            state.get("Running") is False and state.get("Pid") == 0 and
            bool(state.get("FinishedAt")))


def _record_exists(path: Path, label: str) -> bool:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return False
    except OSError as error:
        raise RecoveryUnknown(f"cannot inspect {label}: {error}") from error
    if path.is_symlink() or not stat.S_ISREG(metadata.st_mode):
        raise RecoveryUnknown(f"{label} is not an immutable regular file")
    return True


def _pins_digest(pins: Mapping[str, Any], pins_sha256: str) -> str:
    """Return the immutable digest used to bind a replay to the same pins."""
    pin_path = pins.get("pins_path")
    if isinstance(pin_path, str):
        require(re.fullmatch(r"[0-9a-f]{64}", pins_sha256),
                "pins file replay requires its original SHA-256")
        observed = hashlib.sha256(
            _regular_bytes(Path(pin_path), "orphan recovery pins")
        ).hexdigest()
        require(observed == pins_sha256, "orphan recovery pins changed")
        return observed
    frozen = copy.deepcopy(dict(pins))
    frozen.pop("pins_path", None)
    return hashlib.sha256(canonical_bytes(frozen)).hexdigest()


def _validate_replayed_receipt(
    receipt: Mapping[str, Any], request: Mapping[str, Any], attestation: Mapping[str, Any]
) -> dict[str, Any]:
    expected_request_sha = _pure_module()[2](request)
    expected_attestation_sha = _pure_module()[2](attestation)
    require(receipt.get("schema") == "fullmag.docker.orphan-recovery-receipt.v2" and
            receipt.get("protocol_version") == 2,
            "existing final receipt has an unsupported schema")
    require(receipt.get("request_sha256") == expected_request_sha and
            receipt.get("attestation_sha256") == expected_attestation_sha,
            "existing final receipt is bound to different immutable evidence")
    require(receipt.get("run_id") == request.get("run_id") and
            receipt.get("task_id") == request.get("task_id") and
            receipt.get("container_id") == request["containers"][0]["container_id"],
            "existing final receipt is bound to a different run or container")
    require(receipt.get("outcome") == "await_reconciliation" and
            receipt.get("history_immutable") is True and
            receipt.get("solve_replayed") is False,
            "existing final receipt claims an unexpected lifecycle")
    return dict(receipt)


def _resume_existing_recovery(
    *, pins: Mapping[str, Any], pins_sha256: str, target_id: str,
    project: str, diagnostics_root: Path, request_dir: Path,
    request_container_path: str, attestation_container_path: str,
    engine_before: Mapping[str, Any], target_after: Mapping[str, Any],
    client: Callable[..., Any], run_maintenance: Callable[..., dict[str, Any]],
) -> dict[str, Any]:
    """Resume only immutable evidence left by a prior stop.

    A stopped target without the request/attestation pair is deliberately
    unrecoverable here.  That prevents a second prepare/stop or any inferred
    replacement request after a crash.
    """
    require(_is_factually_stopped(target_after),
            "existing orphan evidence can resume only after factual target exit")
    request_path = request_dir / "request.json"
    attestation_path = request_dir / "attestation.json"
    request = _read_json_record(request_path, "orphan request")
    attestation = _read_json_record(attestation_path, "teardown attestation")
    validate_request, validate_attestation = _pure_validators()
    try:
        validate_request(request)
        validate_attestation(request, attestation)
    except Exception as error:
        raise RecoveryUnknown(f"immutable orphan replay evidence is invalid: {error}") from error
    require(request.get("request_id") == str(pins.get("request_id")),
            "orphan replay request ID differs from the reviewed pins")
    pins_record = _read_json_record(request_dir / "pins-sha256.json", "orphan pins digest")
    require(pins_record.get("schema") == "fullmag.docker.orphan-pins-digest.v1" and
            pins_record.get("sha256") == _pins_digest(pins, pins_sha256),
            "immutable orphan request is not bound to the current exact pins")
    _, _, canonical_json_sha256, finalize, _ = _pure_module()
    request_containers = request.get("containers")
    require(isinstance(request_containers, list) and len(request_containers) == 1 and
            isinstance(request_containers[0], Mapping),
            "immutable orphan request has no exact container binding")
    request_container = request_containers[0]
    current_host = target_after.get("HostConfig")
    require(isinstance(current_host, Mapping) and
            current_host.get("DeviceRequests") == request_container.get("device_requests"),
            "immutable orphan request targets changed device requests")
    require(request_container.get("container_id") == target_after.get("Id") and
            request_container.get("image_id") == target_after.get("Image") and
            request_container.get("config_sha256") == canonical_json_sha256(
                target_after.get("Config", {})),
            "immutable orphan request targets changed container identity")
    if "docker_engine_id_sha256" in request:
        engine_id = engine_before.get("ID")
        require(isinstance(engine_id, str) and request["docker_engine_id_sha256"] ==
                hashlib.sha256(engine_id.encode("utf-8")).hexdigest(),
                "immutable orphan request targets a different Docker engine")

    manifest_path = request_dir / "teardown-manifest.json"
    manifest = _read_json_record(manifest_path, "teardown manifest")
    manifest_sha = hashlib.sha256(_regular_bytes(manifest_path, "teardown manifest")).hexdigest()
    require(attestation.get("manifest_sha256") == manifest_sha,
            "teardown attestation is not bound to the immutable manifest")
    observed_after = _manifest_observation(target_after, stopped=True)
    require(manifest.get("after") == observed_after,
            "stopped target differs from the recorded teardown observation")
    attested_containers = attestation.get("containers")
    require(isinstance(attested_containers, list) and len(attested_containers) == 1 and
            isinstance(attested_containers[0], Mapping),
            "teardown attestation has no exact container observation")
    attested_container = attested_containers[0]
    attested_after = attested_container.get("after")
    require(attested_container.get("container_id") == target_after.get("Id") and
            attested_container.get("image_id") == target_after.get("Image") and
            attested_container.get("config_sha256") == request_container.get("config_sha256") and
            isinstance(attested_after, Mapping) and
            attested_after.get("state") == observed_after["state"] and
            attested_after.get("pid") == observed_after["pid"] and
            attested_after.get("finished_at") == observed_after["finished_at"] and
            attested_after.get("descendant_count") == observed_after["descendant_count"] and
            attested_after.get("private_pid_namespace") is True and
            attested_after.get("host_pid") is False and
            attested_after.get("device_requests_sha256") == canonical_json_sha256(
                current_host["DeviceRequests"]),
            "teardown attestation does not bind the current stopped target")
    pinned_release = _validate_release_pin(
        pins, request["resource_id"], stopped_replay=True)
    attested_release = attestation.get("device_release")
    require(isinstance(pinned_release, Mapping) and isinstance(attested_release, Mapping) and
            attested_release.get("resource_id") == pinned_release.get("resource_id") and
            attested_release.get("mapping_sha256") == pinned_release.get("mapping_sha256") and
            attested_release.get("gpu_uuid") == pinned_release.get("gpu_uuid") and
            attested_release.get("mapping_detached") is True,
            "teardown attestation does not bind the reviewed device release")

    final_path = request_dir / "final-receipt.json"
    complete_path = request_dir / "complete-result.json"
    if _record_exists(complete_path, "complete result"):
        complete_phase_path = request_dir / "complete-phase.json"
        require(_record_exists(complete_phase_path, "complete phase evidence"),
                "stored native completion lacks its terminal maintenance evidence")
        complete_phase = _read_json_record(complete_phase_path, "complete phase evidence")
        require(complete_phase.get("schema") ==
                "fullmag.docker.orphan-maintenance-phase.v1" and
                complete_phase.get("phase") in {"complete", "complete-replay"} and
                isinstance(complete_phase.get("container_id"), str) and
                re.fullmatch(r"[0-9a-f]{64}", complete_phase["container_id"]),
                "stored native completion lacks exact maintenance identity")
        complete_result = _validate_native_result(
            _read_json_record(complete_path, "complete result"),
            "completed", canonical_json_sha256(request),
        )
        if _record_exists(final_path, "final receipt"):
            try:
                expected_receipt = finalize(request, attestation, complete_result)
            except Exception as error:
                raise RecoveryUnknown(
                    f"stored native completion failed final validation: {error}"
                ) from error
            require(isinstance(expected_receipt, Mapping),
                    "stored native completion produced no final receipt")
            expected_receipt = dict(expected_receipt)
            expected_receipt["request_sha256"] = canonical_json_sha256(request)
            receipt = _validate_replayed_receipt(
                _read_json_record(final_path, "final receipt"), request, attestation
            )
            require(canonical_json_sha256(receipt) == canonical_json_sha256(expected_receipt),
                    "existing final receipt differs from validated native completion")
            _cleanup_maintenance(client, complete_phase)
            return {
                "status": "completed", "request_id": request["request_id"],
                "request_sha256": canonical_json_sha256(request),
                "attestation_sha256": canonical_json_sha256(attestation),
                "receipt": receipt, "diagnostics": str(request_dir),
            }
        try:
            receipt = finalize(request, attestation, complete_result)
        except Exception as error:
            raise RecoveryUnknown(f"stored native completion failed final validation: {error}") from error
        receipt["request_sha256"] = canonical_json_sha256(request)
        _write_record(request_dir / "final-receipt.json", receipt)
        _cleanup_maintenance(client, complete_phase)
        return {
            "status": "completed", "request_id": request["request_id"],
            "request_sha256": canonical_json_sha256(request),
            "attestation_sha256": canonical_json_sha256(attestation),
            "receipt": receipt, "diagnostics": str(request_dir),
        }

    if _record_exists(final_path, "final receipt"):
        raise RecoveryUnknown(
            "final receipt is not sufficient for replay without validated complete result and phase"
        )
    if _record_exists(request_dir / "complete-phase.json", "complete phase evidence"):
        raise RecoveryUnknown(
            "stored native completion phase lacks its validated complete result"
        )

    sdk_record = _read_json_record(request_dir / "sdk-loader-probe.json", "SDK loader probe")
    sdk_result = sdk_record.get("result")
    require(isinstance(sdk_result, Mapping) and sdk_result.get("status") == "ready" and
            isinstance(sdk_result.get("stub_sha256"), str) and
            re.fullmatch(r"[0-9a-f]{64}", sdk_result["stub_sha256"]),
            "replay lacks a valid pinned SDK loader proof")
    loader_record = _read_json_record(request_dir / "loader-probe.json", "loader probe")
    require(isinstance(loader_record.get("result"), Mapping) and
            loader_record["result"].get("status") == "ready",
            "replay lacks a completed noncompute loader proof")
    complete_context = _grant_context(target_after, request, "complete")
    complete_command = noncompute_command(
        native_arguments("complete", request_container_path, attestation_container_path),
        sdk_result["stub_sha256"], complete_context,
    )
    _, final_target = _revalidate_before_stop(
        client, target_id, target_after, engine_before, pins, request, pins_sha256)
    require(_manifest_observation(final_target, stopped=True) == observed_after,
            "stopped target lifecycle changed before native completion replay")
    try:
        complete_phase = run_maintenance(
            final_target, "complete", complete_command, False, "complete-replay"
        )
    except RecoveryUnknown:
        raise
    except BaseException as error:
        raise RecoveryUnknown(f"native orphan replay complete failed: {error}") from error
    _validate_phase_grant(complete_phase, complete_context)
    complete_result = complete_phase.get("result")
    require(isinstance(complete_result, Mapping), "native replay complete did not return a result")
    complete_result = _validate_native_result(
        complete_result, "completed", canonical_json_sha256(request)
    )
    try:
        receipt = finalize(request, attestation, complete_result)
    except Exception as error:
        raise RecoveryUnknown(f"native replay result failed final validation: {error}") from error
    receipt["request_sha256"] = canonical_json_sha256(request)
    _write_record(request_dir / "complete-result.json", complete_result)
    _write_record(request_dir / "complete-phase.json",
                 _phase_evidence(complete_phase, "complete-replay"))
    _write_record(request_dir / "final-receipt.json", receipt)
    _cleanup_maintenance(client, complete_phase)
    return {
        "status": "completed", "request_id": request["request_id"],
        "request_sha256": canonical_json_sha256(request),
        "attestation_sha256": canonical_json_sha256(attestation),
        "receipt": receipt, "diagnostics": str(request_dir),
    }


def recover_orphan(pins: Mapping[str, Any], target_container_id: str, project: str,
                   diagnostics_root: str | Path, *, pins_sha256: str = "",
                   docker_client: Callable[..., Any] | None = None,
                   maintenance_runner: Callable[..., dict[str, Any]] | None = None,
                   stop_timeout: int = 30, resume_before_stop: bool = False) -> dict[str, Any]:
    """Perform one bounded, explicitly pinned orphan recovery.

    The caller supplies all ledger/run/source pins. Docker observations are
    refreshed at each fence. ``maintenance_runner`` is injectable for tests;
    the default runner uses one labeled, networkless container per phase.
    """

    require(isinstance(pins, Mapping), "orphan recovery pins must be an object")
    require(re.fullmatch(r"[0-9a-f]{64}", target_container_id),
            "target container ID is invalid")
    require_request_id(str(pins.get("request_id")))
    require(isinstance(project, str) and re.fullmatch(r"fullmag-(?:master|worktree-[a-z0-9._-]+)", project),
            "invalid checkout Compose project")
    require(isinstance(stop_timeout, int) and 1 <= stop_timeout <= 300,
            "stop timeout is outside its bound")
    client = docker_client
    if client is None:
        try:
            from fullmag_docker_runtime import docker  # type: ignore
        except ImportError as error:  # pragma: no cover
            raise RuntimeError("fullmag_docker_runtime is unavailable") from error
        client = docker
    root = Path(diagnostics_root)
    request_id = str(pins["request_id"])
    request_container_path = f"/state/diagnostics/orphan/{request_id}/request.json"
    attestation_container_path = f"/state/diagnostics/orphan/{request_id}/attestation.json"
    engine_before = _engine(client)
    target_before = _inspect(client, target_container_id)
    _manifest_observation(target_before, stopped=_is_factually_stopped(target_before))
    backend_cache = pins.get("backend_cache")
    if "backend_cache" in pins:
        _validate_backend_volume_cache_target(target_before, backend_cache, client)
    else:
        target_mounts = {
            item.get("Destination"): item
            for item in target_before.get("Mounts", [])
            if isinstance(item, Mapping)
        }
        if any(target_mounts.get(destination, {}).get("Type") == "volume"
               for destination in ("/build", "/opt/fullmag/package")):
            raise RecoveryAborted(
                "named-volume backend requires an explicit ready v2 cache proof"
            )
    running = _running_containers(client)
    assert_shared_clients_quiescent(target_before, running)
    root = _assert_diagnostics_binding(target_before, root)
    request_dir = root / "orphan" / request_id
    # Inspect every existing ancestor before mkdir: mkdir(parents=True) would
    # otherwise follow an orphaned symlink and publish evidence outside /state.
    _absolute_no_follow(request_dir, "orphan recovery evidence directory")
    request_dir.mkdir(parents=True, exist_ok=True)
    _absolute_no_follow(request_dir, "orphan recovery evidence directory")
    # Both probes are read-only and precede every native mutation or target stop.
    run_maintenance = maintenance_runner
    if run_maintenance is None:
        run_maintenance = lambda target, name, command, preflight, phase: _maintenance_run(  # noqa: E731
            client, target, project, request_id, command, preflight=preflight, phase=phase,
            backend_cache=backend_cache)
    request_path = request_dir / "request.json"
    probe_dir = request_dir
    request_exists = _record_exists(request_path, "orphan request")
    require(not resume_before_stop or request_exists,
            "pre-stop resume requires an existing immutable request")
    if request_exists:
        if not _is_factually_stopped(target_before) and not resume_before_stop:
            raise RecoveryUnknown(
                "immutable orphan request exists before factual target exit; refusing replay"
            )
        if _is_factually_stopped(target_before):
            try:
                return _resume_existing_recovery(
                    pins=pins, pins_sha256=pins_sha256, target_id=target_container_id,
                    project=project, diagnostics_root=root, request_dir=request_dir,
                    request_container_path=request_container_path,
                    attestation_container_path=attestation_container_path,
                    engine_before=engine_before, target_after=target_before,
                    client=client, run_maintenance=run_maintenance,
                )
            except RecoveryUnknown:
                raise
            except BaseException as error:
                raise RecoveryUnknown(
                    f"immutable orphan replay failed after target stop: {error}"
                ) from error
        # An operator may retry administrative prepare with the exact immutable
        # request. This never retries Solve and does not infer target exit.
        prior_request = _read_json_record(request_path, "orphan request")
        prior_pins = _read_json_record(request_dir / "pins-sha256.json", "orphan pins digest")
        require(prior_pins.get("schema") == "fullmag.docker.orphan-pins-digest.v1" and
                prior_pins.get("sha256") == _pins_digest(pins, pins_sha256),
                "pre-stop resume pins differ from the immutable request")
        require(prior_request.get("request_id") == request_id,
                "pre-stop resume request ID differs from pins")
        for name in ("prepare-result.json", "prepare-phase.json", "teardown-manifest.json",
                     "attestation.json", "complete-result.json", "final-receipt.json"):
            require(not _record_exists(request_dir / name, "later recovery evidence"),
                    "pre-stop resume is only permitted before confirmed prepare or teardown")
        # New read-only probe evidence is retained separately; original evidence
        # is never replaced. The rebuilt request must still match byte-for-byte.
        probe_dir = request_dir / "pre-stop-resume" / str(uuid.uuid4())
        _absolute_no_follow(probe_dir, "pre-stop resume evidence directory")
        probe_dir.mkdir(parents=True, exist_ok=False)
    if _is_factually_stopped(target_before):
        raise RecoveryUnknown(
            "target is already stopped without an immutable orphan request; refusing reconstruction"
        )
    pin_digest = _pins_digest(pins, pins_sha256)
    pins_digest_path = request_dir / "pins-sha256.json"
    if _record_exists(pins_digest_path, "orphan pins digest"):
        existing_pins_digest = _read_json_record(pins_digest_path, "orphan pins digest")
        require(existing_pins_digest.get("schema") ==
                "fullmag.docker.orphan-pins-digest.v1" and
                existing_pins_digest.get("sha256") == pin_digest,
                "existing orphan pins digest differs from the current pins")
    else:
        _write_record(pins_digest_path, {
            "schema": "fullmag.docker.orphan-pins-digest.v1",
            "sha256": pin_digest,
        })
    package_command = ["/usr/local/bin/python3", "-c", PACKAGE_PROBE_SCRIPT]
    package_phase = run_maintenance(target_before, "package", package_command, True, "package-probe")
    package_probe = _probe_package_output(package_phase["output"], target_before)
    _write_record(probe_dir / "package-probe.json", {
        **_phase_evidence(package_phase, "package-probe"), "result": package_probe,
    })
    _cleanup_maintenance(client, package_phase)
    sdk_phase = _probe_image_loader(client, target_before, project, request_id, run_maintenance)
    sdk_result = sdk_phase.get("result")
    _write_record(probe_dir / "sdk-loader-probe.json", {
        **_phase_evidence(sdk_phase, "sdk-loader-probe"), "result": sdk_result,
    })
    _cleanup_maintenance(client, sdk_phase)
    loader_digest = str(sdk_result["stub_sha256"])
    frozen_pins = copy.deepcopy(dict(pins))
    frozen_pins.pop("pins_path", None)
    package = frozen_pins.get("cached_package")
    require(isinstance(package, Mapping), "cached_package is missing from explicit pins")
    frozen_pins["cached_package"] = {**dict(package), "package_probe": package_probe}
    loader_command = noncompute_command(
        [NATIVE_PROGRAM, "--fullmag-recovery-loader-probe"], loader_digest)
    loader_phase = run_maintenance(target_before, "loader", loader_command, True, "loader-probe")
    loader_result = loader_phase.get("result", {})
    require(isinstance(loader_result, Mapping) and loader_result.get("status") == "ready",
            "maintenance loader probe did not complete")
    _write_record(probe_dir / "loader-probe.json", {
        **_phase_evidence(loader_phase, "loader-probe"), "result": loader_result,
    })
    _cleanup_maintenance(client, loader_phase)
    build_request, build_attestation, canonical_json_sha256, finalize, _ = _pure_module()
    try:
        request = build_request(frozen_pins, engine_before, target_before)
    except Exception as error:
        raise RecoveryAborted(f"orphan request pins failed closed before stop: {error}") from error
    request_path = request_dir / "request.json"
    # Reject malformed or all-zero release evidence before native prepare as
    # well as at the post-prepare fence.
    try:
        _validate_release_pin(frozen_pins, request["resource_id"])
    except RecoveryUnknown:
        raise
    except BaseException as error:
        raise RecoveryAborted(
            f"device release evidence failed before native prepare: {error}"
        ) from error
    # Read-only probes may take time. Refresh engine, target and shared-ledger
    # clients before native prepare, while no native state has been mutated.
    current_engine = _engine(client)
    current_target = _inspect(client, target_container_id)
    if current_engine != engine_before:
        raise RecoveryAborted("Docker engine identity changed before native prepare")
    current_state = current_target.get("State", {})
    if (_container_identity(current_target) != _container_identity(target_before) or
            not isinstance(current_state, Mapping) or
            current_state.get("Running") is not True or
            current_state.get("Status") != "running"):
        raise RecoveryAborted("backend identity or running state changed before native prepare")
    assert_shared_clients_quiescent(current_target, _running_containers(client))
    require(_pins_digest(pins, pins_sha256) == pin_digest,
            "orphan recovery pins changed during read-only probes")
    request_sha = _write_record(request_path, request)
    prepare_context = _grant_context(target_before, request, "prepare")
    if prepare_context is not None:
        _assert_failed_keeper_only(client, current_target)
    prepare_command = noncompute_command(
        native_arguments("prepare", request_container_path), loader_digest, prepare_context)
    try:
        prepare_phase = run_maintenance(target_before, "prepare", prepare_command, False, "prepare")
    except RecoveryUnknown:
        raise
    except BaseException as error:
        raise RecoveryAborted(f"native orphan prepare failed; target was not stopped: {error}") from error
    try:
        _validate_phase_grant(prepare_phase, prepare_context)
        prepare_result = prepare_phase.get("result")
        require(isinstance(prepare_result, Mapping), "native prepare did not return a result")
        prepare_result = _validate_native_result(
            prepare_result, "prepared", canonical_json_sha256(request))
        _write_record(request_dir / "prepare-result.json", prepare_result)
        _write_record(request_dir / "prepare-phase.json",
                     _phase_evidence(prepare_phase, "prepare"))
    except RecoveryUnknown:
        raise
    except BaseException as error:
        raise RecoveryUnknown(
            f"native prepare evidence became uncertain after maintenance: {error}"
        ) from error
    _cleanup_maintenance(client, prepare_phase)
    _, current_target = _revalidate_before_stop(
        client, target_container_id, target_before, engine_before, pins,
        request, pins_sha256)
    if prepare_context is not None:
        _assert_failed_keeper_only(client, current_target)
    try:
        release = _validate_release_pin(frozen_pins, request["resource_id"])
    except RecoveryUnknown:
        raise
    except BaseException as error:
        raise RecoveryUnknown(
            f"device release evidence became invalid after native prepare: {error}"
        ) from error
    try:
        _docker_call(client, "stop", "--time", str(stop_timeout), target_container_id,
                     timeout=stop_timeout + 30)
    except RecoveryUnknown:
        raise
    except BaseException as error:
        raise RecoveryUnknown(f"target stop became uncertain; no release was inferred: {error}") from error
    try:
        target_after = _inspect(client, target_container_id)
        after_state = target_after.get("State", {})
        if (not isinstance(after_state, Mapping) or after_state.get("Status") != "exited" or
                after_state.get("Running") is not False or after_state.get("Pid") != 0 or
                not after_state.get("FinishedAt")):
            raise RecoveryUnknown("target stop did not produce factual Exited/Pid-0/FinishedAt evidence")
        if _container_identity(target_after) != _container_identity(target_before):
            raise RecoveryUnknown("target identity changed during stop; release remains unproven")
        manifest = {
            "before": _manifest_observation(target_before, stopped=False),
            "after": _manifest_observation(target_after, stopped=True),
            # This observation exists only after Docker proves the exact
            # private namespace exited. The reviewed pin makes no future claim.
            "device_release": {**release, "mapping_detached": True},
        }
        manifest_path = request_dir / "teardown-manifest.json"
        manifest_sha = _write_record(manifest_path, manifest)
        engine_after = _engine(client)
    except RecoveryUnknown:
        raise
    except BaseException as error:
        raise RecoveryUnknown(
            f"post-stop teardown evidence became uncertain: {error}"
        ) from error
    manifest_pin = {"path": str(manifest_path), "sha256": manifest_sha}
    try:
        attestation = build_attestation(
            request, engine_before, engine_after, target_before, target_after, manifest_pin)
    except Exception as error:
        raise RecoveryUnknown(f"teardown evidence failed closed; native complete not called: {error}") from error
    attestation_path = request_dir / "attestation.json"
    try:
        _write_record(attestation_path, attestation)
    except RecoveryUnknown:
        raise
    except BaseException as error:
        raise RecoveryUnknown(
            f"teardown attestation publication became uncertain: {error}"
        ) from error
    complete_context = _grant_context(target_after, request, "complete")
    complete_command = noncompute_command(
        native_arguments("complete", request_container_path, attestation_container_path),
        loader_digest, complete_context)
    try:
        complete_phase = run_maintenance(target_after, "complete", complete_command, False, "complete")
    except RecoveryUnknown:
        raise
    except BaseException as error:
        raise RecoveryUnknown(f"native orphan complete failed; release remains unconfirmed: {error}") from error
    try:
        _validate_phase_grant(complete_phase, complete_context)
        complete_result = complete_phase.get("result")
        require(isinstance(complete_result, Mapping), "native complete did not return a result")
        complete_result = _validate_native_result(
            complete_result, "completed", canonical_json_sha256(request))
        receipt = finalize(request, attestation, complete_result)
        receipt["request_sha256"] = canonical_json_sha256(request)
        _write_record(request_dir / "complete-result.json", complete_result)
        _write_record(request_dir / "complete-phase.json",
                     _phase_evidence(complete_phase, "complete"))
        _write_record(request_dir / "final-receipt.json", receipt)
    except Exception as error:
        raise RecoveryUnknown(f"native complete result failed final validation: {error}") from error
    _cleanup_maintenance(client, complete_phase)
    return {
        "status": "completed", "request_id": request_id,
        "request_sha256": request_sha, "attestation_sha256": canonical_json_sha256(attestation),
        "receipt": receipt, "diagnostics": str(request_dir),
    }


def run_from_pins(pins_path: str | Path, target_container_id: str, project: str,
                  diagnostics_root: str | Path, *, docker_client: Callable[..., Any] | None = None,
                  maintenance_runner: Callable[..., dict[str, Any]] | None = None,
                  stop_timeout: int = 30, resume_before_stop: bool = False) -> dict[str, Any]:
    pins, pins_sha = _load_pins(Path(pins_path))
    pins["pins_path"] = str(Path(pins_path))
    return recover_orphan(
        pins, target_container_id, project, diagnostics_root,
        pins_sha256=pins_sha, docker_client=docker_client,
        maintenance_runner=maintenance_runner, stop_timeout=stop_timeout,
        resume_before_stop=resume_before_stop)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pins", type=Path, required=True,
                        help="explicit reviewed pins JSON; no automatic state discovery")
    parser.add_argument("--target-container", required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--diagnostics-root", type=Path, required=True)
    parser.add_argument("--stop-timeout", type=int, default=30)
    parser.add_argument("--resume-before-stop", action="store_true",
                        help="explicitly retry prepare with the same immutable request before any stop")
    args = parser.parse_args(argv)
    require(re.fullmatch(r"[0-9a-f]{64}", args.target_container),
            "target container ID is invalid")
    require(re.fullmatch(r"fullmag-(?:master|worktree-[a-z0-9._-]+)", args.project),
            "invalid checkout Compose project")
    require(isinstance(args.stop_timeout, int) and 1 <= args.stop_timeout <= 300,
            "stop timeout is outside its bound")
    return args


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        result = run_from_pins(
            args.pins, args.target_container, args.project, args.diagnostics_root,
            stop_timeout=args.stop_timeout, resume_before_stop=args.resume_before_stop)
    except RecoveryUnknown as error:
        print(json.dumps({"status": "unknown", "error": str(error)}, sort_keys=True), flush=True)
        return 2
    except (RecoveryAborted, ValueError, OSError) as error:
        print(json.dumps({"status": "aborted", "error": str(error)}, sort_keys=True), flush=True)
        return 1
    print(json.dumps(result, sort_keys=True), flush=True)
    return 0


if __name__ == "__main__":  # pragma: no cover - exercised by operator
    raise SystemExit(main())
