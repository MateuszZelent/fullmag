#!/usr/bin/env python3
"""Cold archive integrity gate using an existing managed production CLI.

No build is performed. Linux executes the exact ELF artifact directly; Windows
executes that same artifact inside the pinned FEM CPU Compose image. The
original store is read only; export, import and deliberate corruption operate
on private copies retained beside the receipt.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager, ExitStack
import hashlib
import json
import os
from pathlib import Path
from pathlib import PurePosixPath
import re
import shlex
import shutil
import stat
import subprocess
import sys
import uuid

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
import fullmag_storage as storage
from local_runner.build_executor import validate_build_receipt

SCHEMA = "fullmag.saved_fem_archive_roundtrip.v1"
MAX_STORE_BYTES = 1024 ** 3
MAX_FILES = 50_000
OPERATIONAL_FILES = {"WRITER.lock", "WRITER.owner.json"}
ARCHIVE_PROJECT_LEAFS = {"main.py", "problem_ir.json", "scene_document.json",
                         "script_builder.json", "model_builder_graph.json", "ui_state.json"}
WINDOWS_FEM_CPU_SERVICE = "fullmag-windows-fem-cpu"
CONTAINER_ROUNDTRIP_ROOT = PurePosixPath("/workspace/.fullmag-roundtrip")
CONTAINER_BUILD_ROOT = PurePosixPath("/workspace/.fullmag/pinned-build")
CONTAINER_PATH_RE = re.compile(r"^/[A-Za-z0-9._/-]+$")
IMAGE_REF_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9./:_@-]{0,255}$")
CONTAINER_ID_RE = re.compile(r"^[0-9a-f]{64}$")
WINDOWS_CONTAINER_LAUNCH_TIMEOUT_SECONDS = 30
WINDOWS_DOCKER_CONTROL_TIMEOUT_SECONDS = 30
WINDOWS_SYSTEM_MOUNT_TARGETS = frozenset({
    "/etc/hosts",
    "/etc/hostname",
    "/etc/resolv.conf",
})
OBSERVATION_PENDING_COMMAND_STATES = frozenset({
    "observation_timeout_process_retained",
    "observation_timeout_container_retained",
    "wait_failed_container_retained",
    "wait_error_container_retained",
    "wait_ambiguous_container_retained",
    "container_attestation_failed_container_retained",
    "terminal_cleanup_failed_container_retained",
    "launch_timeout_container_unknown",
    "launch_error_container_unknown",
    "launch_nonzero_container_unknown",
    "launch_ambiguous_container_unknown",
    "terminal_missing_output_container_retained",
    "terminal_output_decode_failed_container_retained",
})


@contextmanager
def source_read_lock(root: Path):
    """Hold the existing native descriptor without changing its data/owner."""
    path = storage.validate_path(root / "WRITER.lock", root, "source lock descriptor")
    with path.open("r+b") as stream:
        descriptor = b"fullmag.writer.lock.v1\n"
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size != len(descriptor) or stream.read(len(descriptor)) != descriptor:
            raise ValueError("source native lock descriptor is missing or unsupported")
        stream.seek(0)
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes
            import msvcrt
            class Overlapped(ctypes.Structure):
                _fields_ = [("Internal", ctypes.c_size_t), ("InternalHigh", ctypes.c_size_t),
                            ("Offset", wintypes.DWORD), ("OffsetHigh", wintypes.DWORD), ("hEvent", wintypes.HANDLE)]
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel.LockFileEx.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD,
                                         wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(Overlapped)]
            kernel.LockFileEx.restype = wintypes.BOOL
            kernel.UnlockFileEx.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD,
                                           wintypes.DWORD, ctypes.POINTER(Overlapped)]
            kernel.UnlockFileEx.restype = wintypes.BOOL
            handle = wintypes.HANDLE(msvcrt.get_osfhandle(stream.fileno()))
            overlapped = Overlapped()
            # Shared native lease: permit inventory reads, refuse any exclusive
            # Rust writer lock. FAIL_IMMEDIATELY prevents observation waits.
            if not kernel.LockFileEx(handle, 1, 0, 0xffffffff, 0xffffffff, ctypes.byref(overlapped)):
                raise ctypes.WinError(ctypes.get_last_error())
        else:
            import fcntl
            fcntl.flock(stream.fileno(), fcntl.LOCK_SH | fcntl.LOCK_NB)
        lease = {"acquired": True, "released": False, "owner_document_modified": False,
                 "scope": "entire_copy_export_import_observation"}
        try:
            yield lease
        finally:
            stream.seek(0)
            if os.name == "nt":
                if not kernel.UnlockFileEx(handle, 0, 0xffffffff, 0xffffffff, ctypes.byref(overlapped)):
                    raise ctypes.WinError(ctypes.get_last_error())
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
            lease["released"] = True


def check_archive_source(root: Path, files: dict, pinned: dict) -> dict:
    unsupported = sorted(name for name in files if name.startswith("project/")
                         and name.removeprefix("project/") not in ARCHIVE_PROJECT_LEAFS)
    if unsupported:
        raise ValueError(f"archive reachability is not qualified for project documents: {unsupported}; no files removed")
    if not files.get("project/main.py", {}).get("size"):
        raise ValueError("archive qualification requires nonempty project/main.py")
    with (root / "CURRENT").open("rb") as stream:
        current_bytes = stream.read(4097)
    if len(current_bytes) > 4096:
        raise ValueError("CURRENT exceeds metadata budget")
    current = current_bytes.decode("utf-8").strip()
    if current in {".", ".."} or not re.fullmatch(r"[A-Za-z0-9._-]{1,200}", current):
        raise ValueError("invalid CURRENT generation")
    session_path = storage.validate_path(root / "manifests" / f"{current}.json", root)
    session = read_json(session_path, 1024 * 1024)
    run_id = pinned.get("run_id", "")
    if not isinstance(run_id, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,200}", run_id) or run_id in {".", ".."}:
        raise ValueError("invalid pinned run id")
    run_ref = f"runs/{run_id}/run_manifest.json"
    if session.get("format") != "fullmag.session.v1" or run_ref not in session.get("run_refs", []) \
            or run_ref not in files or f"runs/{run_id}/artifact_catalog.json" not in files:
        raise ValueError("CURRENT does not include pinned run manifest and artifact catalog")
    return {"current_generation": current, "manifest_sha256": digest(session_path),
            "pinned_run_ref": run_ref, "project_documents": sorted(name for name in files if name.startswith("project/"))}


def read_json(path: Path, limit: int = 16 * 1024) -> dict:
    with path.open("rb") as stream:
        raw = stream.read(limit + 1)
    if len(raw) > limit:
        raise ValueError(f"metadata budget exceeded: {path}")
    result = json.loads(raw)
    if not isinstance(result, dict):
        raise ValueError(f"expected a JSON object: {path}")
    return result


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def container_roundtrip_path(path: Path, run_root: Path) -> str:
    """Translate one run-owned host path into the fixed container mount."""
    candidate = Path(path).resolve(strict=False)
    base = Path(run_root).resolve(strict=False)
    try:
        relative = candidate.relative_to(base)
    except ValueError as error:
        raise ValueError(f"path escapes the roundtrip mount: {candidate}") from error
    translated = PurePosixPath(CONTAINER_ROUNDTRIP_ROOT, *relative.parts).as_posix()
    if not CONTAINER_PATH_RE.fullmatch(translated):
        raise ValueError(f"invalid translated roundtrip path: {translated}")
    return translated


def _compose_host_path(path: Path) -> str:
    candidate = Path(path).resolve(strict=False)
    if not candidate.is_absolute():
        raise ValueError(f"Docker bind source must be absolute: {candidate}")
    return candidate.as_posix()


def _normalized_host_path(value: object) -> str:
    raw = str(value or "")
    if os.name == "nt":
        raw = raw.replace("/", "\\")
        host_alias = re.fullmatch(r"\\host_mnt\\([A-Za-z])\\(.*)", raw)
        desktop_alias = re.fullmatch(r"\\run\\desktop\\mnt\\host\\([A-Za-z])\\(.*)", raw)
        if host_alias or desktop_alias:
            alias = host_alias or desktop_alias
            raw = f"{alias.group(1).upper()}:\\{alias.group(2)}"
        if raw.startswith("\\\\?\\"):
            raw = raw[4:]
    return os.path.normcase(os.path.abspath(raw))


def _network_settings_are_isolated(networks: object) -> bool:
    """Accept Docker's empty or explicit none-network representation only."""
    if networks == {}:
        return True
    if not isinstance(networks, dict) or set(networks) != {"none"}:
        return False
    none_network = networks.get("none")
    if not isinstance(none_network, dict):
        return False
    for field in (
        "IPAddress",
        "GlobalIPv6Address",
        "Gateway",
        "IPv6Gateway",
        "EndpointID",
        "MacAddress",
        "LinkLocalIPv6Address",
    ):
        if none_network.get(field, "") not in ("", None):
            return False
    for field in ("IPPrefixLen", "GlobalIPv6PrefixLen", "IPv6PrefixLen"):
        if none_network.get(field, 0) not in (0, None):
            return False
    return True


def attest_windows_container_image(image_ref: str, expected_image_digest: str) -> dict:
    """Require the existing Windows Docker image to match the build receipt."""
    if not IMAGE_REF_RE.fullmatch(image_ref):
        raise ValueError("Windows FEM image reference is invalid")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", expected_image_digest):
        raise ValueError("Windows FEM image digest is invalid")
    if image_ref != expected_image_digest:
        raise ValueError("Windows FEM image must use the verified immutable digest")
    result = subprocess.run(
        ["docker", "image", "inspect", image_ref],
        capture_output=True,
        text=True,
        check=False,
        timeout=WINDOWS_DOCKER_CONTROL_TIMEOUT_SECONDS,
    )
    if result.returncode != 0:
        raise ValueError(f"Windows FEM image is unavailable: {image_ref}")
    try:
        inspected = json.loads(result.stdout)
    except (TypeError, ValueError) as error:
        raise ValueError("Docker image inspection returned invalid JSON") from error
    if not isinstance(inspected, list) or len(inspected) != 1:
        raise ValueError("Docker image inspection returned an ambiguous image")
    image = inspected[0]
    if image.get("Id") != expected_image_digest:
        raise ValueError("Windows FEM image identity differs from the build receipt")
    if image.get("Config", {}).get("Volumes"):
        raise ValueError("Windows FEM image declares anonymous volumes")
    return image


def build_windows_container_command(
    *,
    repo_root: Path,
    run_root: Path,
    artifact_root: Path,
    state_root: Path,
    args: list[object],
    output_path: Path,
    error_path: Path,
    image_ref: str,
    expected_image_digest: str,
    compose_mount_root: Path,
    compose_override_path: Path,
    project_name: str,
    container_name: str,
) -> tuple[list[str], dict[str, str], dict]:
    """Build the immutable-artifact command for the existing Windows Compose lane."""
    repo_root = Path(repo_root).resolve(strict=False)
    run_root = Path(run_root).resolve(strict=False)
    artifact_root = Path(artifact_root).resolve(strict=False)
    compose_mount_root = Path(compose_mount_root).resolve(strict=False)
    compose_override_path = Path(compose_override_path).resolve(strict=False)
    if not IMAGE_REF_RE.fullmatch(image_ref):
        raise ValueError("Windows FEM image reference is invalid")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", expected_image_digest):
        raise ValueError("Windows FEM image digest is invalid")
    if image_ref != expected_image_digest:
        raise ValueError("Windows FEM image must use the verified immutable digest")

    translated_args = []
    for value in args:
        if isinstance(value, (Path, os.PathLike)):
            translated_args.append(container_roundtrip_path(Path(value), run_root))
        else:
            translated_args.append(str(value))
    translated_state = container_roundtrip_path(Path(state_root), run_root)
    mesh_cache = container_roundtrip_path(run_root / "mesh-cache", run_root)
    translated_output = container_roundtrip_path(Path(output_path), run_root)
    translated_error = container_roundtrip_path(Path(error_path), run_root)
    binary = (CONTAINER_BUILD_ROOT / "bin" / "fullmag-bin").as_posix()
    shell_command = "exec " + shlex.join([binary, *translated_args])
    shell_command += " > " + shlex.quote(translated_output)
    shell_command += " 2> " + shlex.quote(translated_error)

    mount_root = compose_mount_root
    runtime_root = mount_root / "runtime"
    build_root = mount_root / "build"
    cache_root = mount_root / "cache"
    temp_root = mount_root / "temp"
    frontend_root = mount_root / "frontend"
    cargo_home = cache_root / "cargo"
    rustup_home = cache_root / "rustup"
    pnpm_root = cache_root / "pnpm"
    node_modules = frontend_root / "node_modules"
    control_room_node_modules = frontend_root / "apps" / "control-room" / "node_modules"
    compose_env = dict(os.environ)
    compose_env.update({
        "COMPOSE_PROJECT_NAME": project_name,
        "COMPOSE_PROFILES": "",
        "FULLMAG_WINDOWS_REPO": _compose_host_path(repo_root),
        "FULLMAG_WINDOWS_STATE_ROOT": _compose_host_path(runtime_root),
        "FULLMAG_WINDOWS_BUILD_ROOT": _compose_host_path(build_root),
        "FULLMAG_WINDOWS_CACHE_ROOT": _compose_host_path(cache_root),
        "FULLMAG_WINDOWS_TEMP_ROOT": _compose_host_path(temp_root),
        "FULLMAG_WINDOWS_CARGO_HOME": _compose_host_path(cargo_home),
        "FULLMAG_WINDOWS_RUSTUP_HOME": _compose_host_path(rustup_home),
        "FULLMAG_WINDOWS_PNPM_ROOT": _compose_host_path(pnpm_root),
        "FULLMAG_WINDOWS_NODE_MODULES_ROOT": _compose_host_path(node_modules),
        "FULLMAG_WINDOWS_CONTROL_ROOM_NODE_MODULES_ROOT": _compose_host_path(control_room_node_modules),
        "FULLMAG_WINDOWS_FRONTEND_ROOT": _compose_host_path(frontend_root),
        "FULLMAG_WINDOWS_FEM_CPU_IMAGE": image_ref,
        "FULLMAG_WINDOWS_WEB_PORT": "0",
    })
    container_env = {
        "FULLMAG_REPO_ROOT": "/workspace",
        "FULLMAG_STATE_ROOT": translated_state,
        "FULLMAG_FEM_MESH_CACHE_DIR": mesh_cache,
        "FULLMAG_RUNTIME_ROOT": "/workspace/.fullmag",
        "FULLMAG_DISABLE_MANAGED_FEM_GPU_RUNTIME": "1",
        "FULLMAG_FORCE_LOCAL_FEM_CPU": "1",
        "FULLMAG_FEM_EXECUTION": "cpu",
        "FULLMAG_FEM_MFEM_DEVICE": "cpu",
        "FULLMAG_MANAGED_FEM_DEVICE": "cpu",
        "FULLMAG_FEM_REQUIRE_GPU": "0",
        "FULLMAG_FEM_REQUIRE_CEED": "0",
        "FULLMAG_FEM_WITH_SLEPC": "OFF",
        "FULLMAG_FDM_EXECUTION": "cpu",
        "FULLMAG_API_PORT": "0",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONPATH": "/workspace/packages/fullmag-py/src:/workspace/.fullmag/pinned-build",
        "LD_LIBRARY_PATH": "/workspace/.fullmag/pinned-build/lib:/opt/fullmag-deps/lib",
    }
    compose_file = repo_root / "compose.windows.yaml"
    if not compose_file.is_file():
        raise ValueError(f"Windows FEM Compose file is missing: {compose_file}")
    if not compose_override_path.is_file():
        raise ValueError(f"Windows FEM Compose network override is missing: {compose_override_path}")
    command = [
        "docker", "compose", "-f", str(compose_file), "-f", str(compose_override_path),
        "--project-name", project_name,
        "run", "--no-deps", "--detach", "-T", "--name", container_name,
    ]
    for key, value in container_env.items():
        command.extend(("-e", f"{key}={value}"))
    command.extend((
        "-v", f"{_compose_host_path(repo_root)}:/workspace:ro",
        "-v", f"{_compose_host_path(run_root)}:{CONTAINER_ROUNDTRIP_ROOT.as_posix()}:rw",
        "-v", f"{_compose_host_path(artifact_root)}:{CONTAINER_BUILD_ROOT.as_posix()}:ro",
        WINDOWS_FEM_CPU_SERVICE, "bash", "-lc", shell_command,
    ))
    evidence = {
        "service": WINDOWS_FEM_CPU_SERVICE,
        "compose_override": str(compose_override_path),
        "image_ref": image_ref,
        "expected_image_digest": expected_image_digest,
        "artifact_mount_source": _compose_host_path(artifact_root),
        "artifact_mount_target": CONTAINER_BUILD_ROOT.as_posix(),
        "artifact_mount_read_only": True,
        "repository_mount_target": "/workspace",
        "repository_mount_read_only": True,
        "roundtrip_mount_source": _compose_host_path(run_root),
        "roundtrip_mount_target": CONTAINER_ROUNDTRIP_ROOT.as_posix(),
        "roundtrip_mount_read_write": True,
        "container_name": container_name,
    }
    return command, compose_env, evidence


def _container_id_from_launch(output: str) -> str:
    candidates = [line.strip() for line in output.splitlines() if line.strip()]
    container_id = candidates[-1] if candidates else ""
    if not CONTAINER_ID_RE.fullmatch(container_id):
        raise ValueError("Docker Compose did not return a full container ID")
    return container_id


def has_pending_observation(command_records: list[dict]) -> bool:
    return any(
        command.get("state") in OBSERVATION_PENDING_COMMAND_STATES
        for command in command_records
    )


def observe_windows_container_launch(
    *,
    command: list[str],
    compose_env: dict[str, str],
    launch_stdout_path: Path,
    launch_stderr_path: Path,
    container_name: str,
    command_record: dict,
    receipt: dict,
    receipt_path: Path,
) -> str:
    """Observe Compose launch without guessing whether the daemon created a container."""
    with launch_stdout_path.open("wb") as launch_stdout, launch_stderr_path.open("wb") as launch_stderr:
        try:
            launch = subprocess.run(
                command,
                env=compose_env,
                stdout=launch_stdout,
                stderr=launch_stderr,
                check=False,
                timeout=WINDOWS_CONTAINER_LAUNCH_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired as error:
            command_record["state"] = "launch_timeout_container_unknown"
            command_record["launch_timeout_seconds"] = WINDOWS_CONTAINER_LAUNCH_TIMEOUT_SECONDS
            command_record["launch_stdout_sha256"] = digest(launch_stdout_path)
            command_record["launch_stderr_sha256"] = digest(launch_stderr_path)
            storage.atomic_json(receipt_path, receipt)
            raise ValueError(
                "Docker Compose launch observation timed out; container identity is unknown "
                f"and deterministic name is retained for reconciliation: {container_name}"
            ) from error
        except OSError as error:
            command_record["state"] = "launch_error_container_unknown"
            command_record["launch_stdout_sha256"] = digest(launch_stdout_path)
            command_record["launch_stderr_sha256"] = digest(launch_stderr_path)
            storage.atomic_json(receipt_path, receipt)
            raise ValueError(
                "Docker Compose launch failed before its outcome was observable; "
                f"container identity is unknown: {container_name}"
            ) from error

    command_record["launch_exit_code"] = launch.returncode
    command_record["launch_stdout_sha256"] = digest(launch_stdout_path)
    command_record["launch_stderr_sha256"] = digest(launch_stderr_path)
    if launch.returncode != 0:
        command_record["state"] = "launch_nonzero_container_unknown"
        storage.atomic_json(receipt_path, receipt)
        raise ValueError(
            f"Docker Compose launch returned {launch.returncode}; container identity is unknown: "
            f"{container_name}"
        )
    try:
        launch_output = launch_stdout_path.read_text(encoding="utf-8")
        if not launch_output.strip():
            launch_output = launch_stderr_path.read_text(encoding="utf-8")
        container_id = _container_id_from_launch(launch_output)
    except (OSError, UnicodeError, ValueError) as error:
        command_record["state"] = "launch_ambiguous_container_unknown"
        storage.atomic_json(receipt_path, receipt)
        raise ValueError(
            "Docker Compose launch did not yield a full container ID; container identity is "
            f"unknown and deterministic name is retained for reconciliation: {container_name}"
        ) from error
    command_record["container_id"] = container_id
    storage.atomic_json(receipt_path, receipt)
    return container_id


def attest_windows_container(
    container_id: str,
    expected_image_digest: str,
    repo_root: Path,
    artifact_root: Path,
    run_root: Path,
    compose_mount_root: Path,
) -> dict:
    if not CONTAINER_ID_RE.fullmatch(container_id):
        raise ValueError("Docker returned an invalid container ID")
    result = subprocess.run(
        ["docker", "inspect", container_id],
        capture_output=True,
        text=True,
        check=False,
        timeout=WINDOWS_DOCKER_CONTROL_TIMEOUT_SECONDS,
    )
    if result.returncode != 0:
        raise ValueError("Docker container inspection failed")
    try:
        inspected = json.loads(result.stdout)
    except (TypeError, ValueError) as error:
        raise ValueError("Docker container inspection returned invalid JSON") from error
    if not isinstance(inspected, list) or len(inspected) != 1:
        raise ValueError("Docker container inspection returned an ambiguous container")
    container = inspected[0]
    if container.get("Image") != expected_image_digest:
        raise ValueError("Runtime container image differs from the build receipt")
    mount_root = Path(compose_mount_root).resolve(strict=False)
    expected_mounts = {
        "/workspace": (Path(repo_root).resolve(strict=False), False),
        "/workspace/.fullmag": (mount_root / "runtime", True),
        "/workspace/.fullmag-build": (mount_root / "build", True),
        "/workspace/.fullmag-cache": (mount_root / "cache", True),
        "/workspace/.fullmag-cargo": (mount_root / "cache" / "cargo", True),
        "/workspace/.fullmag-rustup": (mount_root / "cache" / "rustup", True),
        "/pnpm": (mount_root / "cache" / "pnpm", True),
        "/workspace/node_modules": (mount_root / "frontend" / "node_modules", True),
        "/workspace/apps/control-room/node_modules": (
            mount_root / "frontend" / "apps" / "control-room" / "node_modules", True
        ),
        "/fullmag-frontend": (mount_root / "frontend", True),
        "/tmp/fullmag-windows": (mount_root / "temp", True),
        CONTAINER_ROUNDTRIP_ROOT.as_posix(): (Path(run_root).resolve(strict=False), True),
        CONTAINER_BUILD_ROOT.as_posix(): (Path(artifact_root).resolve(strict=False), False),
    }
    mounts = container.get("Mounts", [])
    if not isinstance(mounts, list):
        raise ValueError("Runtime container mount inspection is invalid")
    actual_mounts = {}
    for mount in mounts:
        if not isinstance(mount, dict) or not isinstance(mount.get("Destination"), str):
            raise ValueError("Runtime container has an invalid mount record")
        destination = mount["Destination"]
        if destination in actual_mounts:
            raise ValueError(f"Runtime container has duplicate mount target: {destination}")
        actual_mounts[destination] = mount
    unexpected = set(actual_mounts) - set(expected_mounts) - WINDOWS_SYSTEM_MOUNT_TARGETS
    missing = set(expected_mounts) - set(actual_mounts)
    if unexpected:
        raise ValueError(f"Runtime container has unexpected mounts: {sorted(unexpected)}")
    if missing:
        raise ValueError(f"Runtime container is missing expected mounts: {sorted(missing)}")
    for destination, (expected_source, expected_rw) in expected_mounts.items():
        mount = actual_mounts[destination]
        if mount.get("Type") != "bind":
            raise ValueError(f"Runtime container mount is not a bind: {destination}")
        observed_source = _normalized_host_path(mount.get("Source", ""))
        if observed_source != _normalized_host_path(expected_source):
            raise ValueError(f"Runtime container mount source differs: {destination}")
        if mount.get("RW") is not expected_rw:
            raise ValueError(f"Runtime container mount read/write mode differs: {destination}")
    system_mounts = {}
    for destination in sorted(WINDOWS_SYSTEM_MOUNT_TARGETS.intersection(actual_mounts)):
        mount = actual_mounts[destination]
        if mount.get("Type") != "bind" or not mount.get("Source"):
            raise ValueError(f"Runtime container system mount is invalid: {destination}")
        system_mounts[destination] = {
            "source": mount.get("Source"),
            "read_write": mount.get("RW") is True,
        }
    network_mode = container.get("HostConfig", {}).get("NetworkMode")
    networks = container.get("NetworkSettings", {}).get("Networks")
    if network_mode != "none" or not _network_settings_are_isolated(networks):
        raise ValueError("Runtime container has network access")
    artifact_mount = actual_mounts[CONTAINER_BUILD_ROOT.as_posix()]
    roundtrip_mount = actual_mounts[CONTAINER_ROUNDTRIP_ROOT.as_posix()]
    return {
        "container_id": container_id,
        "container_image_digest": container.get("Image"),
        "network_mode": network_mode,
        "network_settings_isolated": True,
        "unexpected_mounts_rejected": True,
        "system_mounts": system_mounts,
        "artifact_mount": {
            "source": artifact_mount.get("Source"),
            "target": artifact_mount.get("Destination"),
            "read_only": artifact_mount.get("RW") is False,
        },
        "roundtrip_mount": {
            "source": roundtrip_mount.get("Source"),
            "target": roundtrip_mount.get("Destination"),
            "read_write": roundtrip_mount.get("RW") is True,
        },
        "writable_mounts": sorted(
            destination for destination, (_, expected_rw) in expected_mounts.items() if expected_rw
        ),
    }


def prepare_windows_container_mounts(run_root: Path, layout: dict) -> Path:
    """Create only private Compose mount roots below the resolved storage run."""
    build_storage = Path(layout["build_storage_root"]).resolve(strict=False)
    mount_root = storage.validate_path(Path(run_root) / "container-mounts", build_storage,
                                       "Windows FEM container mount root")
    paths = (
        mount_root,
        mount_root / "runtime",
        mount_root / "build",
        mount_root / "cache",
        mount_root / "cache" / "cargo",
        mount_root / "cache" / "rustup",
        mount_root / "cache" / "pnpm",
        mount_root / "temp",
        mount_root / "frontend",
        mount_root / "frontend" / "node_modules",
        mount_root / "frontend" / "apps" / "control-room" / "node_modules",
    )
    for path in paths:
        storage.validate_path(path, build_storage, "Windows FEM container mount")
        path.mkdir(parents=True, exist_ok=True)
    return mount_root


def write_windows_network_override(run_root: Path) -> Path:
    """Create a private Compose override that gives the verification container no network."""
    override = storage.validate_path(
        Path(run_root) / "compose.network-none.yaml",
        Path(run_root),
        "Windows FEM Compose network override",
    )
    override.write_text(
        "services:\n"
        "  fullmag-windows-fem-gpu:\n"
        "    profiles: [\"disabled\"]\n"
        f"  {WINDOWS_FEM_CPU_SERVICE}:\n"
        "    network_mode: \"none\"\n",
        encoding="utf-8",
        newline="\n",
    )
    return override


def execute_windows_container(
    *,
    label: str,
    state_root: Path,
    args: list[object],
    reject_corruption: bool,
    run_root: Path,
    repo_root: Path,
    binary: Path,
    entry: dict,
    expected_image_digest: str,
    layout: dict,
    command_records: list[dict],
    receipt: dict,
    receipt_path: Path,
    expected_commit: str,
    expected_snapshot: str,
) -> str:
    """Run one archive command in the pinned Windows FEM CPU image."""
    # Compose accepts the immutable image ID directly (the managed exporter
    # uses the same pattern); never resolve this execution through a mutable
    # Windows image tag.
    image_ref = expected_image_digest
    image = attest_windows_container_image(image_ref, expected_image_digest)
    if Path(binary).stat().st_size != entry.get("size") or digest(Path(binary)) != entry.get("sha256"):
        raise ValueError("pinned FEM binary changed after managed receipt validation")
    artifact_root = Path(binary).resolve(strict=False).parent.parent
    artifact_root = storage.validate_path(
        artifact_root, Path(layout["build_storage_root"]), "pinned FEM build artifact"
    )
    mount_root = prepare_windows_container_mounts(run_root, layout)
    compose_override = write_windows_network_override(run_root)
    safe_label = re.sub(r"[^A-Za-z0-9_.-]", "-", label)
    project_name = f"fullmag-saved-fem-{Path(run_root).name}"
    container_name = f"{project_name}-{safe_label}"
    out = Path(run_root) / f"{label}.stdout.log"
    err = Path(run_root) / f"{label}.stderr.log"
    launch_out = Path(run_root) / f"{label}.compose.stdout.log"
    launch_err = Path(run_root) / f"{label}.compose.stderr.log"
    (Path(run_root) / "mesh-cache").mkdir(parents=True, exist_ok=True)
    out.touch(exist_ok=False)
    err.touch(exist_ok=False)
    launch_out.touch(exist_ok=False)
    launch_err.touch(exist_ok=False)
    command, compose_env, evidence = build_windows_container_command(
        repo_root=repo_root,
        run_root=run_root,
        artifact_root=artifact_root,
        state_root=state_root,
        args=args,
        output_path=out,
        error_path=err,
        image_ref=image_ref,
        expected_image_digest=expected_image_digest,
        compose_mount_root=mount_root,
        compose_override_path=compose_override,
        project_name=project_name,
        container_name=container_name,
    )
    record = {
        "label": label,
        "state": "observing",
        "stdout": str(out),
        "stderr": str(err),
        "launch_stdout": str(launch_out),
        "launch_stderr": str(launch_err),
        "execution": "windows-docker-compose-exact-artifact",
        "image_id": image.get("Id"),
        **evidence,
    }
    command_records.append(record)
    storage.atomic_json(receipt_path, receipt)
    container_id = observe_windows_container_launch(
        command=command,
        compose_env=compose_env,
        launch_stdout_path=launch_out,
        launch_stderr_path=launch_err,
        container_name=container_name,
        command_record=record,
        receipt=receipt,
        receipt_path=receipt_path,
    )
    try:
        waited = subprocess.run(
            ["docker", "wait", container_id],
            capture_output=True,
            text=True,
            check=False,
            timeout=300,
        )
    except subprocess.TimeoutExpired as error:
        record["state"] = "observation_timeout_container_retained"
        storage.atomic_json(receipt_path, receipt)
        raise ValueError(
            f"observation timeout; container retained id={container_id}; see {err}"
        ) from error
    except OSError as error:
        record["state"] = "wait_error_container_retained"
        storage.atomic_json(receipt_path, receipt)
        raise ValueError(
            f"Docker wait failed before its outcome was observable; container retained id={container_id}"
        ) from error
    if waited.returncode != 0:
        record["state"] = "wait_failed_container_retained"
        storage.atomic_json(receipt_path, receipt)
        raise ValueError(f"Docker wait failed for container {container_id}")
    raw_exit = waited.stdout.strip()
    if not re.fullmatch(r"[0-9]+", raw_exit):
        record["state"] = "wait_ambiguous_container_retained"
        storage.atomic_json(receipt_path, receipt)
        raise ValueError(f"Docker wait returned an invalid exit code for {container_id}")
    exit_code = int(raw_exit)
    try:
        container_evidence = attest_windows_container(
            container_id, expected_image_digest, repo_root, artifact_root, run_root, mount_root
        )
    except Exception:
        record["state"] = "container_attestation_failed_container_retained"
        storage.atomic_json(receipt_path, receipt)
        raise
    record.update(container_evidence)
    if not out.is_file() or not err.is_file():
        record["state"] = "terminal_missing_output_container_retained"
        storage.atomic_json(receipt_path, receipt)
        raise ValueError(
            f"Windows FEM container did not produce command logs; container retained: {label}"
        )
    try:
        stdout_text = out.read_text(encoding="utf-8")
        stderr_text = err.read_text(encoding="utf-8")
        record.update(
            state="terminal",
            exit_code=exit_code,
            stdout_sha256=digest(out),
            stderr_sha256=digest(err),
        )
    except (OSError, UnicodeError) as error:
        record["state"] = "terminal_output_decode_failed_container_retained"
        storage.atomic_json(receipt_path, receipt)
        raise ValueError(
            f"Windows FEM container produced unreadable command logs; container retained: {label}"
        ) from error
    storage.atomic_json(receipt_path, receipt)
    failure = None
    try:
        check_stamp(stderr_text, expected_commit, expected_snapshot)
        if reject_corruption:
            if exit_code == 0 or "CAS integrity error" not in stderr_text:
                raise ValueError("corrupt CAS field chunk was not rejected for integrity failure")
        elif exit_code != 0:
            raise ValueError(f"qualification command failed: {label}, see {err}")
    except Exception as error:  # Preserve container evidence before propagating validation failure.
        failure = error
    try:
        cleanup = subprocess.run(
            ["docker", "rm", container_id],
            capture_output=True,
            text=True,
            check=False,
            timeout=WINDOWS_DOCKER_CONTROL_TIMEOUT_SECONDS,
        )
    except (subprocess.TimeoutExpired, OSError) as error:
        record["state"] = "terminal_cleanup_failed_container_retained"
        record["cleanup_error"] = f"{type(error).__name__}: {error}"
        storage.atomic_json(receipt_path, receipt)
        if failure is None:
            failure = ValueError(f"Docker container cleanup failed; container retained: {container_id}")
        cleanup = None
    if cleanup is None:
        pass
    elif cleanup.returncode != 0:
        record["state"] = "terminal_cleanup_failed_container_retained"
        record["cleanup_stderr_sha256"] = hashlib.sha256(cleanup.stderr.encode("utf-8")).hexdigest()
        storage.atomic_json(receipt_path, receipt)
        if failure is None:
            failure = ValueError(f"Docker container cleanup failed: {container_id}")
    else:
        record["container_cleanup"] = "removed"
        storage.atomic_json(receipt_path, receipt)
    if failure is not None:
        raise failure
    return stdout_text


def driver_identity() -> dict:
    return {name: digest(SCRIPT_DIR / name) for name in (
        "verify_saved_fem_archive_roundtrip.py", "fullmag_storage.py",
        "local_runner/build_executor.py", "local_runner/worker_entrypoint.py",
        "local_runner/build_entrypoint.py")}


def inventory(root: Path) -> dict[str, dict]:
    """Reject links, devices and unbounded inputs before copying any data."""
    storage.absolute(root, "store root")
    result = {}
    size = 0
    seen = 0
    def scan_error(error):
        raise error
    for current, directories, files in os.walk(root, followlinks=False, onerror=scan_error):
        for name in directories + files:
            seen += 1
            if seen > MAX_FILES:
                raise ValueError("store exceeds qualification member budget")
            path = Path(current) / name
            storage.absolute(path, "store member")
            info = path.lstat()
            if stat.S_ISDIR(info.st_mode):
                continue
            if not stat.S_ISREG(info.st_mode):
                raise ValueError(f"store contains a non-regular member: {path}")
            size += info.st_size
            if size > MAX_STORE_BYTES or len(result) >= MAX_FILES:
                raise ValueError("store exceeds qualification copy budget")
            result[path.relative_to(root).as_posix()] = {"size": info.st_size, "sha256": digest(path)}
    return result


def copy_store(source: Path, destination: Path, expected: dict) -> None:
    if destination.exists():
        raise ValueError("qualification destination already exists")
    # Native lock descriptors/owner records are process state, never copied to
    # another repository. All durable documents and CAS bytes remain identical.
    def ignore(directory, names):
        return OPERATIONAL_FILES.intersection(names) if Path(directory) == source else set()
    shutil.copytree(source, destination, ignore=ignore, symlinks=True)
    copied = inventory(destination)
    durable = {name: entry for name, entry in expected.items() if name not in OPERATIONAL_FILES}
    if copied != durable or inventory(source) != expected:
        raise ValueError("store changed during qualification copy")


def check_stamp(stderr: str, commit: str, snapshot: str) -> None:
    stamps = [line for line in stderr.splitlines() if line.startswith("[fullmag] build:")]
    match = re.fullmatch(r"\[fullmag\] build: [^|\r\n]+ \| commit: ([0-9a-f]{40}) \| (clean|dirty) \| source snapshot: ([0-9a-f]{64})",
                         stamps[0]) if len(stamps) == 1 else None
    if match is None or match.groups() != (commit, "clean", snapshot):
        raise ValueError("CLI startup identity differs from exact managed build")


def check_integrity_result(payload: dict, pinned: dict, artifact_id: str) -> dict:
    if payload.get("schema") != "fullmag.saved_native_fem_snapshot_integrity.v1" \
            or payload.get("status") != "pass" or payload.get("source") != pinned \
            or payload.get("source_artifact_id") != artifact_id \
            or payload.get("scientific_qualification") != "not_verified" \
            or payload.get("archive_roundtrip") != "not_verified":
        raise ValueError("saved snapshot result does not identify the requested source")
    receipt = payload.get("native_snapshot_receipt")
    if not isinstance(receipt, dict) or any(
        not isinstance(receipt.get(key), str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", receipt[key])
        for key in ("values_sha256", "native_node_map_sha256", "native_indexed_geometry_sha256")
    ):
        raise ValueError("saved snapshot result has incomplete native integrity receipts")
    return receipt


def run(repo_root: Path, config_path: Path) -> tuple[int, dict]:
    profile = "windows-saved-fem-archive-roundtrip" if os.name == "nt" else "linux-saved-fem-archive-roundtrip"
    layout = storage.resolve_layout(repo_root, profile)
    storage.initialize(layout)
    base = Path(layout["storage_root"])
    run_root = storage.validate_path(Path(layout["build_root"]) / "runs" / uuid.uuid4().hex,
                                    Path(layout["build_storage_root"]))
    run_root.mkdir(parents=True, exist_ok=False)
    receipt = {"schema": SCHEMA, "state": "running", "qualification": "NOT VERIFIED",
               "run_root": str(run_root), "driver_sources": driver_identity(), "profile": profile,
               "python": sys.version, "platform": sys.platform}
    receipt_path = run_root / "receipt.json"
    command_records = []
    receipt["commands"] = command_records
    storage.atomic_json(receipt_path, receipt)
    result_code = 2
    try:
        with storage.file_lock(run_root / "qualification.lock", str(run_root)), ExitStack() as resources:
            config_path = storage.validate_path(config_path, base, "qualification config")
            config = read_json(config_path)
            required = {"build_run_root", "store", "pinned_source", "source_artifact_id",
                        "expected_commit", "expected_native_source_snapshot_sha256"}
            if set(config) != required or not all(isinstance(value, str) for value in config.values()):
                raise ValueError("qualification config has missing or unknown fields")
            if not re.fullmatch(r"[0-9a-f]{40}", config["expected_commit"]) \
                    or not re.fullmatch(r"[0-9a-f]{64}", config["expected_native_source_snapshot_sha256"]):
                raise ValueError("qualification requires full canonical source identities")
            build_root = storage.validate_path(Path(config["build_run_root"]), base, "managed build root")
            journal = read_json(build_root / "receipt.json", 64 * 1024)
            context = read_json(build_root / "trusted/context.json", 64 * 1024)
            if build_root.name != context.get("job_id") or any(
                journal.get(key) != context.get(key)
                for key in ("job_id", "profile", "source_digest", "image_digest")
            ):
                raise ValueError("managed coordinator and execution context identities differ")
            if journal.get("phase") != "terminal" or journal.get("state") != "succeeded" \
                    or journal.get("exit_code") != 0 or journal.get("profile") != "fem-cpu-release":
                raise ValueError("managed FEM CPU build is not terminal and successful")
            for name, expected in journal.get("trusted_hashes", {}).items():
                member = storage.validate_path(build_root / "trusted" / name, build_root / "trusted")
                if digest(member) != expected:
                    raise ValueError("managed trusted execution document hash mismatch")
            if set(journal.get("trusted_hashes", {})) != {"context.json", "build_entrypoint.py", "worker_entrypoint.py"}:
                raise ValueError("managed build trusted documents are incomplete")
            native = context.get("native_source_identity", {})
            if native.get("head_commit_full") != config["expected_commit"] \
                    or native.get("source_snapshot_sha256") != config["expected_native_source_snapshot_sha256"] \
                    or native.get("source_snapshot_dirty") is not False:
                raise ValueError("managed build source identity differs from qualification request")
            job = {"job_id": context["job_id"], "source_digest": context["source_digest"],
                   "profile": context["profile"], "payload": {"native_source_identity": native}}
            built = validate_build_receipt(build_root / "artifacts", job, journal)
            binary_relative = "outputs/.fullmag/local/bin/fullmag-bin"
            binary = storage.validate_path(build_root / "artifacts" / binary_relative, build_root / "artifacts")
            entry = next((entry for entry in built["artifacts"] if entry["path"] == binary_relative), None)
            if entry is None or entry["size"] == 0:
                raise ValueError("managed production CLI artifact is missing")
            source = storage.validate_path(Path(config["store"]), base, "source qualification store")
            if not source.is_dir() or storage.inside(run_root, source) or storage.inside(source, run_root):
                raise ValueError("source store is missing or overlaps qualification output")
            receipt["source_native_read_lock"] = resources.enter_context(source_read_lock(source))
            before = inventory(source)
            if "LOCK" in before:
                raise ValueError("legacy store lock requires explicit recovery outside qualification")
            if "WRITER.owner.json" in before:
                owner = read_json(source / "WRITER.owner.json")
                if owner.get("schema") != "fullmag.writer.v1" or owner.get("released") is not True:
                    raise ValueError("qualification requires a cold store with released writer record")
            pinned_path = storage.validate_path(Path(config["pinned_source"]), base, "pinned source file")
            pinned = read_json(pinned_path)
            receipt["pinned_source_file_sha256"] = digest(pinned_path)
            receipt["archive_source_preflight"] = check_archive_source(source, before, pinned)
            storage.atomic_json(run_root / "pinned-source.json", pinned)
            pinned_path = run_root / "pinned-source.json"
            bytes_total = sum(entry["size"] for entry in before.values())
            if shutil.disk_usage(run_root).free < bytes_total * 6 + 512 * 1024 ** 2:
                raise ValueError("insufficient capacity for retained archive qualification copies")
            source_state = run_root / "source-state"
            cloned = source_state / "local-live/session-store"
            copy_store(source, cloned, before)
            env = os.environ.copy()
            env["FULLMAG_REPO_ROOT"] = str(repo_root)
            library_root = binary.parent.parent / "lib"
            env["LD_LIBRARY_PATH"] = str(library_root) + os.pathsep + env.get("LD_LIBRARY_PATH", "")
            env["PYTHONDONTWRITEBYTECODE"] = "1"
            def execute(label, state_root, args, *, reject_corruption=False):
                if os.name == "nt":
                    return execute_windows_container(
                        label=label,
                        state_root=state_root,
                        args=list(args),
                        reject_corruption=reject_corruption,
                        run_root=run_root,
                        repo_root=repo_root,
                        binary=binary,
                        entry=entry,
                        expected_image_digest=context["image_digest"],
                        layout=layout,
                        command_records=command_records,
                        receipt=receipt,
                        receipt_path=receipt_path,
                        expected_commit=config["expected_commit"],
                        expected_snapshot=config["expected_native_source_snapshot_sha256"],
                    )
                command_env = dict(env, FULLMAG_STATE_ROOT=str(state_root))
                out = run_root / f"{label}.stdout.log"
                err = run_root / f"{label}.stderr.log"
                record = {"label": label, "state": "observing", "stdout": str(out), "stderr": str(err)}
                command_records.append(record)
                with out.open("wb") as stdout, err.open("wb") as stderr:
                    process = subprocess.Popen([str(binary), *map(str, args)], cwd=repo_root,
                                               env=command_env, stdout=stdout, stderr=stderr)
                    record["pid"] = process.pid
                    storage.atomic_json(receipt_path, receipt)
                    try:
                        process.wait(timeout=300)
                    except subprocess.TimeoutExpired:
                        record["state"] = "observation_timeout_process_retained"
                        raise ValueError(f"observation timeout; process retained pid={process.pid}; see {err}")
                stdout_text = out.read_text(encoding="utf-8")
                stderr_text = err.read_text(encoding="utf-8")
                record.update(state="terminal", exit_code=process.returncode,
                              stdout_sha256=digest(out), stderr_sha256=digest(err))
                check_stamp(stderr_text, config["expected_commit"], config["expected_native_source_snapshot_sha256"])
                if reject_corruption:
                    if process.returncode == 0 or "CAS integrity error" not in stderr_text:
                        raise ValueError("corrupt CAS field chunk was not rejected for integrity failure")
                elif process.returncode != 0:
                    raise ValueError(f"qualification command failed: {label}, see {err}")
                return stdout_text

            def verify(label, state_root, store):
                raw = execute(label, state_root, ["runtime", "verify-saved-fem-snapshot", "--store", store,
                              "--source", pinned_path, "--source-artifact-id", config["source_artifact_id"]])
                return check_integrity_result(json.loads(raw), pinned, config["source_artifact_id"])

            first = verify("before-export", source_state, cloned)
            archive = run_root / "snapshot.fms"
            execute("export", source_state, ["session", "save", archive, "--profile", "archive"])
            import_state = run_root / "import-state"
            execute("import", import_state, ["session", "open", archive])
            imported = import_state / "local-live/session-store"
            second = verify("after-import", import_state, imported)
            if first != second:
                raise ValueError("native snapshot receipt changed across archive roundtrip")
            damaged_state = run_root / "damaged-state"
            damaged = damaged_state / "local-live/session-store"
            copy_store(imported, damaged, inventory(imported))
            tensor_ref = pinned.get("tensor_object_ref", "")
            if not re.fullmatch(r"[0-9a-f]{64}", tensor_ref):
                raise ValueError("invalid pinned tensor hash")
            tensor = read_json(damaged / "objects/sha256" / tensor_ref, 4 * 1024 ** 2)
            chunks = tensor.get("chunks", [])
            chunk_ref = chunks[0].get("object_ref", "") if chunks else ""
            if not re.fullmatch(r"[0-9a-f]{64}", chunk_ref):
                raise ValueError("saved tensor has no canonical field chunk")
            corrupt_path = storage.validate_path(damaged / "objects/sha256" / chunk_ref, damaged)
            with corrupt_path.open("r+b") as stream:
                original = stream.read(1)
                if not original:
                    raise ValueError("cannot corrupt an empty field chunk")
                stream.seek(0)
                stream.write(bytes([original[0] ^ 1]))
            execute("reject-corrupt-field", damaged_state, ["runtime", "verify-saved-fem-snapshot", "--store", damaged,
                    "--source", pinned_path, "--source-artifact-id", config["source_artifact_id"]], reject_corruption=True)
            if inventory(source) != before or digest(binary) != entry["sha256"]:
                raise ValueError("original store or production binary changed during qualification")
            if driver_identity() != receipt["driver_sources"]:
                raise ValueError("qualification driver sources changed during observation")
            receipt.update(state="passed", exit_code=0, source=pinned, native_snapshot_receipt=second,
                           commands=command_records, build_job_id=context["job_id"],
                           build_source=native, binary_sha256=entry["sha256"],
                           archive={"path": str(archive), "sha256": digest(archive), "bytes": archive.stat().st_size},
                           original_store_unchanged=True, corrupted_chunk_rejected=chunk_ref,
                           qualification="archive_integrity_only", scientific_qualification="NOT VERIFIED")
            result_code = 0
    except Exception as error:
        pending = has_pending_observation(command_records)
        receipt.update(state="observation_pending" if pending else "failed", exit_code=2,
                       error=f"{type(error).__name__}: {error}")
    finally:
        storage.atomic_json(receipt_path, receipt)
    print(json.dumps({"receipt": str(receipt_path), "state": receipt["state"], "error": receipt.get("error")}))
    return result_code, receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=SCRIPT_DIR.parent)
    args = parser.parse_args()
    config = os.environ.get("FULLMAG_SAVED_FEM_ROUNDTRIP_CONFIG")
    if not config:
        parser.error("FULLMAG_SAVED_FEM_ROUNDTRIP_CONFIG must name a managed-storage JSON config")
    return run(args.repo_root.resolve(), Path(config))[0]


if __name__ == "__main__":
    raise SystemExit(main())
