"""Fail before API startup when device access or durable state is unavailable."""
import ctypes
import hashlib
import json
import os
import re
import subprocess
import sys
import signal
import stat
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit


STARTUP_ACTIVATION_DIAGNOSTIC_SCHEMA = "fullmag.startup-activation-diagnostic.v1"
DEVICE_ACCESS_CPU = "cpu"
DEVICE_ACCESS_GPU = "gpu"
CUDA_COMPATIBILITY_ROOT = Path("/usr/local/cuda/compat")
RUNTIME_CONTROL_ROOT = Path("/opt/fullmag/runtime-control")
FEM_MESH_CACHE_ROOT = Path("/build/cache/fem-mesh")
CUDA_CACHE_ROOT = Path("/build/cache/cuda-compute")
LINUX_STORAGE_PROFILE = "linux-native-v1"
LINUX_HOST_CERTIFICATE = Path("/run/fullmag/host-admission/linux-native-host.json")
LINUX_OWNER_MARKER = ".fullmag-linux-native-owner.json"
LINUX_PROBE_RECEIPT = ".fullmag-linux-native-probe.json"
LINUX_MAX_ID = 2**31 - 1
LINUX_SHA256 = re.compile(r"^[0-9a-f]{64}$")
LINUX_IMAGE_ID = re.compile(r"^sha256:[0-9a-f]{64}$")
LINUX_GIT_OBJECT = re.compile(r"^[0-9a-f]{40}$")


def _linux_json(data: bytes, label: str) -> dict:
    def reject_duplicates(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise RuntimeError(f"Native Linux {label} contains a duplicate key")
            result[key] = value
        return result

    try:
        value = json.loads(data.decode("utf-8"), object_pairs_hook=reject_duplicates)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Native Linux {label} is not valid JSON") from error
    if not isinstance(value, dict):
        raise RuntimeError(f"Native Linux {label} must be an object")
    return value


def _read_linux_owned_at(
    probe, parent_fd, name, *, maximum=1024 * 1024, private_parent=False
):
    parent_metadata = os.fstat(parent_fd)
    if (
        not stat.S_ISDIR(parent_metadata.st_mode)
        or (parent_metadata.st_uid, parent_metadata.st_gid) != (os.getuid(), os.getgid())
        or (private_parent and stat.S_IMODE(parent_metadata.st_mode) & 0o077)
    ):
        raise RuntimeError("Native Linux evidence directory is not private and caller-owned")
    descriptor = os.open(
        name,
        os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | getattr(os, "O_CLOEXEC", 0),
        dir_fd=parent_fd,
    )
    try:
        metadata = os.fstat(descriptor)
        if metadata.st_size > maximum:
            raise RuntimeError("Native Linux host evidence is oversized")
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_nlink != 1
            or (metadata.st_uid, metadata.st_gid) != (os.getuid(), os.getgid())
            or stat.S_IMODE(metadata.st_mode) & 0o077
        ):
            raise RuntimeError("Native Linux host evidence must be a private owned regular file")
        return probe._read_fd(descriptor, maximum)
    finally:
        os.close(descriptor)


def _write_linux_readback(probe, directory_fd, name, payload, *, create_only=False):
    flags = (
        os.O_WRONLY
        | os.O_CREAT
        | os.O_NOFOLLOW
        | os.O_NONBLOCK
        | getattr(os, "O_CLOEXEC", 0)
    )
    if create_only:
        flags |= os.O_CREAT | os.O_EXCL
    try:
        descriptor = os.open(name, flags, 0o600, dir_fd=directory_fd)
    except FileExistsError:
        if create_only:
            raise RuntimeError(f"Native Linux {name} already exists")
        descriptor = os.open(
            name,
            os.O_WRONLY | os.O_NOFOLLOW | os.O_NONBLOCK | getattr(os, "O_CLOEXEC", 0),
            dir_fd=directory_fd,
        )
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_nlink != 1
            or (metadata.st_uid, metadata.st_gid) != (os.getuid(), os.getgid())
            or stat.S_IMODE(metadata.st_mode) & 0o077
        ):
            raise RuntimeError(f"Native Linux {name} is not a private owned regular file")
        os.fchmod(descriptor, 0o600)
        os.ftruncate(descriptor, 0)
        offset = 0
        while offset < len(payload):
            written = os.write(descriptor, payload[offset:])
            if written <= 0:
                raise RuntimeError(f"Short write while publishing native Linux {name}")
            offset += written
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    probe._sync_dir_fd(directory_fd)


def _validate_linux_host_certificate(host, image):
    if not isinstance(host, dict):
        raise RuntimeError("Invalid native Linux host admission")
    if (
        host.get("schema") != "fullmag.linux-native-host-certificate.v1"
        or host.get("storage_profile") != LINUX_STORAGE_PROFILE
        or host.get("role") != "session"
        or host.get("owner_scope") != "docker-local-unix"
        or not LINUX_IMAGE_ID.fullmatch(image)
        or host.get("image_id") != image
    ):
        raise RuntimeError("Native Linux host certificate profile or image is invalid")
    owner_token = host.get("owner_token")
    if not isinstance(owner_token, str) or not re.fullmatch(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
        owner_token,
    ):
        raise RuntimeError("Native Linux host owner token is invalid")
    if not isinstance(host.get("engine_id"), str) or not host["engine_id"].strip():
        raise RuntimeError("Native Linux Docker engine identity is missing")
    docker_host = host.get("docker_host")
    if not isinstance(docker_host, dict):
        raise RuntimeError("Native Linux Docker endpoint evidence is missing")
    endpoint = docker_host.get("endpoint")
    selection = docker_host.get("selection")
    context_name = docker_host.get("context_name")
    parsed_endpoint = urlsplit(endpoint) if isinstance(endpoint, str) else None
    if (
        docker_host.get("profile") != LINUX_STORAGE_PROFILE
        or selection not in {"DOCKER_CONTEXT", "DOCKER_HOST", "active-context"}
        or not isinstance(docker_host.get("daemon_id"), str)
        or not docker_host["daemon_id"]
        or parsed_endpoint is None
        or parsed_endpoint.scheme != "unix"
        or parsed_endpoint.netloc
        or not parsed_endpoint.path.startswith("/")
        or parsed_endpoint.query
        or parsed_endpoint.fragment
        or ".." in Path(parsed_endpoint.path).parts
        or str(Path(parsed_endpoint.path)) != parsed_endpoint.path
        or (context_name is None and selection != "DOCKER_HOST")
        or (context_name is not None and (
            not isinstance(context_name, str) or not context_name
        ))
    ):
        raise RuntimeError("Native Linux Docker endpoint must be a local Unix socket")
    host_root = host.get("host_root")
    if (
        not isinstance(host_root, str)
        or not host_root.startswith("/")
        or ".." in Path(host_root).parts
        or str(Path(host_root)) != host_root
    ):
        raise RuntimeError("Native Linux storage root is not canonical")
    filesystem = host.get("filesystem")
    device = host.get("device")
    if filesystem not in {"ext4", "xfs", "btrfs"} or isinstance(device, bool) or not isinstance(device, int) or device < 0:
        raise RuntimeError("Native Linux filesystem identity is invalid")
    uid, gid = os.getuid(), os.getgid()
    if (
        uid <= 0 or gid <= 0 or uid > LINUX_MAX_ID or gid > LINUX_MAX_ID
        or host.get("runtime_uid") != uid or host.get("runtime_gid") != gid
        or isinstance(host.get("runtime_uid"), bool) or isinstance(host.get("runtime_gid"), bool)
    ):
        raise RuntimeError("Native Linux runtime identity differs from the current non-root user")
    if not LINUX_GIT_OBJECT.fullmatch(str(host.get("source_commit", ""))):
        raise RuntimeError("Native Linux source commit is invalid")
    hashes = host.get("binary_hashes")
    if not isinstance(hashes, dict) or not hashes or any(
        not isinstance(name, str) or not name or not isinstance(digest, str)
        or not LINUX_SHA256.fullmatch(digest) for name, digest in hashes.items()
    ):
        raise RuntimeError("Native Linux binary hashes are invalid")
    if not LINUX_SHA256.fullmatch(str(host.get("artifact_receipt_sha256", ""))):
        raise RuntimeError("Native Linux artifact receipt digest is invalid")
    expected_restart = hashlib.sha256((owner_token + ":" + image).encode("ascii")).hexdigest()
    if host.get("restart_expected_sha256") != expected_restart or type(host.get("restart_verified")) is not bool:
        raise RuntimeError("Native Linux restart certificate is invalid")
    delegation = host.get("development_build")
    required_delegation = {
        "schema", "cargo_profile", "toolchain_image_id", "package_root",
        "provenance_path", "group_identity", "source_identity",
    }
    cargo_profile = os.environ.get("FULLMAG_BACKEND_CARGO_PROFILE", "")
    if delegation is None:
        if cargo_profile != "release":
            raise RuntimeError("Native Linux development mode requires its build delegation")
        return
    if not isinstance(delegation, dict) or set(delegation) != required_delegation:
        raise RuntimeError("Native Linux development build delegation is invalid")
    source_identity = delegation.get("source_identity")
    if (
        delegation.get("schema") != "fullmag.linux-native-development-build.v1"
        or cargo_profile not in {"backend-dev", "release"}
        or delegation.get("cargo_profile") != cargo_profile
        or not LINUX_IMAGE_ID.fullmatch(str(delegation.get("toolchain_image_id", "")))
        or delegation.get("package_root") != "/opt/fullmag/package"
        or delegation.get("provenance_path") != "/opt/fullmag/control/backend/runtime-provenance.json"
        or delegation.get("group_identity") != os.environ.get("FULLMAG_COMPOSE_PROJECT")
        or not isinstance(source_identity, dict)
        or not LINUX_GIT_OBJECT.fullmatch(str(source_identity.get("commit", "")))
        or any(not LINUX_SHA256.fullmatch(str(source_identity.get(field, ""))) for field in (
            "source_digest", "source_snapshot_sha256", "native_source_identity_sha256"
        ))
    ):
        raise RuntimeError("Native Linux development build delegation does not match this group")


def linux_storage_probe(
    require_restart,
    root=Path("/state"),
    certificate=LINUX_HOST_CERTIFICATE,
    owner_marker=None,
):
    """Probe native Linux storage under the exact non-root owner certificate."""

    import windows_folder_probe as probe

    root = Path(root)
    owner_marker = Path(owner_marker) if owner_marker is not None else root / LINUX_OWNER_MARKER
    certificate = Path(certificate)
    cert_parent_fd, cert_name = probe._open_pinned_parent(certificate)
    root_fd = probe._open_pinned_directory(root)
    try:
        cert_bytes = _read_linux_owned_at(
            probe, cert_parent_fd, cert_name, private_parent=True
        )
        owner_bytes = _read_linux_owned_at(probe, root_fd, owner_marker.name)
        if cert_bytes != owner_bytes:
            raise RuntimeError("Native Linux host certificate and owner marker differ")
        host = _linux_json(cert_bytes, "host certificate")
        image = os.environ.get("FULLMAG_RUNTIME_IMAGE_ID", "")
        _validate_linux_host_certificate(host, image)
        payload = (host["owner_token"] + ":" + image).encode("ascii")

        sentinel_name = ".linux-native-sentinel"
        if probe._exists_at(root_fd, sentinel_name):
            if probe._read_regular_at(root_fd, sentinel_name, 256) != payload:
                raise RuntimeError("Native Linux host sentinel mismatch")
        elif host["restart_verified"]:
            raise RuntimeError("Native Linux host sentinel is missing after restart")
        else:
            _write_linux_readback(probe, root_fd, sentinel_name, payload, create_only=True)
            if probe._read_regular_at(root_fd, sentinel_name, 256) != payload:
                raise RuntimeError("Native Linux host sentinel failed readback")

        restart_name = ".linux-native-restart"
        restart_existed = probe._exists_at(root_fd, restart_name)
        if restart_existed:
            if probe._read_regular_at(root_fd, restart_name, 256) != payload:
                raise RuntimeError("Native Linux restart sentinel changed")
        elif host["restart_verified"] or require_restart:
            raise RuntimeError("Native Linux restart sentinel is missing")
        else:
            _write_linux_readback(probe, root_fd, restart_name, payload, create_only=True)

        directory_fd = probe._ensure_directory_at(root_fd, ".linux-native-probe")
        try:
            probe._publish_at(directory_fd, "publication.bin", b"before")
            probe._publish_at(directory_fd, "publication.bin", payload)
            if probe._read_regular_at(directory_fd, "publication.bin", 256) != payload:
                raise RuntimeError("Native Linux atomic publication mismatch")
            probe._child_lock_probe(directory_fd)
            probe._sqlite_probe(directory_fd, host["owner_token"])
        finally:
            os.close(directory_fd)
        if require_restart and not host["restart_verified"]:
            raise RuntimeError("Native Linux host has not confirmed restart readback")
        result = {
            "schema": "fullmag.linux-native-probe.v1",
            "storage_profile": LINUX_STORAGE_PROFILE,
            "image_id": image,
            "owner_token": host["owner_token"],
            "restart_expected_sha256": host["restart_expected_sha256"],
            "checks": {
                "file_sync": True,
                "directory_sync": True,
                "atomic_replace": True,
                "process_lock": True,
                "sqlite_transactions": True,
                "restart_readback": restart_existed,
            },
        }
        _write_linux_readback(
            probe, root_fd, LINUX_PROBE_RECEIPT,
            (json.dumps(result, ensure_ascii=True, sort_keys=True, indent=2) + "\n").encode("utf-8"),
        )
        return result
    finally:
        os.close(root_fd)
        os.close(cert_parent_fd)


def _technical_path(name, default):
    """Resolve one container-owned technical path without traversal."""

    path = Path(os.environ.get(name, str(default)))
    if not path.is_absolute() or any(part == ".." for part in path.parts):
        raise RuntimeError(f"{name} must be an absolute path without parent traversal")
    return path


def technical_paths():
    """Return the control and compiler-cache paths expected on named volumes.

    ``/state`` is reserved for the Windows-backed user namespace.  A runtime
    control path may be a nested named-volume mount below the native store
    compatibility path, but compiler caches must never fall back there.
    """

    control = _technical_path("FULLMAG_RUNTIME_CONTROL_ROOT", RUNTIME_CONTROL_ROOT)
    fem_mesh = _technical_path("FULLMAG_FEM_MESH_CACHE_DIR", FEM_MESH_CACHE_ROOT)
    cuda_cache = _technical_path("CUDA_CACHE_PATH", CUDA_CACHE_ROOT)
    state_root = Path("/state")
    for path, name in ((fem_mesh, "FULLMAG_FEM_MESH_CACHE_DIR"),
                       (cuda_cache, "CUDA_CACHE_PATH")):
        try:
            path.relative_to(state_root)
        except ValueError:
            continue
        raise RuntimeError(f"{name} must remain outside the Windows /state bind")
    if control == state_root:
        raise RuntimeError("FULLMAG_RUNTIME_CONTROL_ROOT must not be the user /state root")
    return control, fem_mesh, cuda_cache


def _configure_device_access():
    """Validate the minted device mode and prepare the CPU CUDA ABI path.

    The full image contains the real user-mode CUDA driver compatibility
    package under the fixed, image-owned path.  CPU access may use that
    package for native components compiled with CUDA support.  The entrypoint
    skips only its hardware-specific CUDA preflight in CPU mode; the native
    runtime may perform its own ABI/readiness checks.  GPU access retains the
    image's existing loader environment and is checked by ``preflight`` below.
    """

    access = os.environ.get("FULLMAG_DOCKER_DEVICE_ACCESS", DEVICE_ACCESS_GPU)
    if access not in {DEVICE_ACCESS_CPU, DEVICE_ACCESS_GPU}:
        raise RuntimeError("FULLMAG_DOCKER_DEVICE_ACCESS must be cpu or gpu")
    if access == DEVICE_ACCESS_CPU:
        compatibility_library = CUDA_COMPATIBILITY_ROOT / "libcuda.so.1"
        if (not CUDA_COMPATIBILITY_ROOT.is_dir()
                or not compatibility_library.is_file()):
            raise RuntimeError(
                "CPU device access requires the image-owned CUDA compatibility library"
            )
        current = [item for item in os.environ.get("LD_LIBRARY_PATH", "").split(os.pathsep)
                   if item]
        os.environ["LD_LIBRARY_PATH"] = os.pathsep.join(
            dict.fromkeys([*current, str(CUDA_COMPATIBILITY_ROOT)])
        )
    return access


class StartupActivationOutcome(Exception):
    """A typed activation outcome after the durable started marker exists."""

    def __init__(self, diagnostic):
        self.diagnostic = diagnostic
        super().__init__(diagnostic.get("error", "startup activation outcome is unknown"))


def preflight():
    device_access = _configure_device_access()
    kind = subprocess.check_output(["stat", "-f", "-c", "%t", "/state"], text=True).strip()
    profile = os.environ.get("FULLMAG_SESSION_STORAGE_PROFILE")
    normalized_kind = kind.lower().lstrip("0")
    if profile == LINUX_STORAGE_PROFILE:
        if normalized_kind not in {"ef53", "58465342", "9123683e"}:
            raise RuntimeError(
                f"Unsupported native Linux durable filesystem 0x{kind}; use ext4, XFS or Btrfs"
            )
        linux_storage_probe(require_restart="--storage-probe" not in sys.argv)
    elif profile == "windows-folder-v1":
        from windows_folder_probe import run
        run(require_restart="--storage-probe" not in sys.argv)
    else:
        raise RuntimeError("Docker session storage requires a supported host admission profile")
    if device_access == DEVICE_ACCESS_GPU:
        driver = ctypes.CDLL("libcuda.so.1")
        if driver.cuInit(0) != 0:
            raise RuntimeError("NVIDIA CUDA driver initialization failed")
        count = ctypes.c_int()
        if driver.cuDeviceGetCount(ctypes.byref(count)) != 0 or count.value < 1:
            raise RuntimeError("No NVIDIA CUDA GPU available")
    control_root, fem_mesh_cache, cuda_cache = technical_paths()
    for directory in (control_root, fem_mesh_cache, cuda_cache):
        directory.mkdir(parents=True, exist_ok=True)
    probe = control_root / (".write-probe-" + uuid.uuid4().hex)
    with probe.open("xb") as stream:
        stream.write(b"fullmag-state-preflight\n")
        stream.flush()
        os.fsync(stream.fileno())
    probe.unlink()


def activate_startup_script():
    """Activate the optional host-attested script through the live API only."""
    if os.environ.get("FULLMAG_STARTUP_ENABLED") != "1":
        if any(name in os.environ for name in (
                "FULLMAG_STARTUP_SCRIPT", "FULLMAG_STARTUP_PROVENANCE",
                "FULLMAG_STARTUP_API", "FULLMAG_STARTUP_PROVENANCE_SHA256",
                "FULLMAG_STARTUP_HELPER_SHA256")):
            raise RuntimeError("startup activation environment is incomplete")
        return None
    helper_path = Path("/opt/fullmag/docker_startup_script.py")
    expected_hash = os.environ.get("FULLMAG_STARTUP_HELPER_SHA256", "")
    if len(expected_hash) != 64 or any(character not in "0123456789abcdef" for character in expected_hash):
        raise RuntimeError("startup helper hash is missing or invalid")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = None
    try:
        descriptor = os.open(helper_path, flags)
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 1024 * 1024:
            raise RuntimeError("startup helper is not a bounded regular file")
        checksum = hashlib.sha256()
        for block in iter(lambda: os.read(descriptor, 64 * 1024), b""):
            checksum.update(block)
        if checksum.hexdigest() != expected_hash:
            raise RuntimeError("startup helper differs from the image-attested bytes")
    except OSError as error:
        raise RuntimeError("Docker startup-script helper is unavailable from the image") from error
    finally:
        if descriptor is not None:
            os.close(descriptor)
    try:
        import importlib.util

        helper_root = "/opt/fullmag"
        if helper_root not in sys.path:
            sys.path.insert(0, helper_root)
        spec = importlib.util.spec_from_file_location("docker_startup_script", helper_path)
        if spec is None or spec.loader is None:
            raise RuntimeError("Docker startup-script helper cannot be loaded")
        docker_startup_script = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = docker_startup_script
        spec.loader.exec_module(docker_startup_script)
        try:
            return docker_startup_script.run_from_environment()
        except Exception as error:
            diagnostic = _startup_activation_failure(docker_startup_script, error)
            if diagnostic is not None:
                raise StartupActivationOutcome(diagnostic) from error
            raise
    except (ImportError, OSError, RuntimeError) as error:
        raise RuntimeError("Docker startup-script helper is missing from the image") from error


def _startup_activation_failure(helper, error):
    """Return only the helper's typed, post-marker unknown diagnostic."""

    unknown_error = getattr(helper, "StartupActivationOutcomeUnknown", None)
    if not isinstance(unknown_error, type) or not isinstance(error, unknown_error):
        return None
    diagnostic = getattr(error, "diagnostic", None)
    if not isinstance(diagnostic, dict):
        return None
    if (diagnostic.get("schema") != STARTUP_ACTIVATION_DIAGNOSTIC_SCHEMA
            or diagnostic.get("state") != "unknown"
            or diagnostic.get("durable_state") != "started"
            or not isinstance(diagnostic.get("request_id"), str)
            or not isinstance(diagnostic.get("source_sha256"), str)
            or not isinstance(diagnostic.get("source_relative"), str)
            or not isinstance(diagnostic.get("error"), str)):
        return None
    return dict(diagnostic)


def _retain_liveness_observation(receipt, error):
    observation = getattr(error, "liveness_observation", None)
    if isinstance(observation, dict):
        receipt["api_liveness"] = observation


def _supervise_once(service, handle, *, full_api_probe, now, degraded_since):
    """Run one check and bound only typed transient observation failures."""

    try:
        service.check(handle, full_api_probe=full_api_probe)
    except service.RuntimeServiceTransient as error:
        if degraded_since is None:
            degraded_since = now
            print(
                "[fullmag-backend] Runtime observation degraded; retrying for "
                f"{service.SUPERVISION_GRACE_SECONDS:.0f}s: {str(error)[-2048:]}",
                file=sys.stderr,
                flush=True,
            )
        if now - degraded_since < service.SUPERVISION_GRACE_SECONDS:
            return degraded_since
        unknown = service.RuntimeServiceUnknown(
            "runtime observation stayed degraded for "
            f"{now - degraded_since:.0f}s: {error}"
        )
        observation = getattr(error, "liveness_observation", None)
        if isinstance(observation, dict):
            unknown.liveness_observation = observation
        raise unknown from error
    if degraded_since is not None:
        print(
            "[fullmag-backend] Runtime observation recovered after "
            f"{now - degraded_since:.0f}s",
            flush=True,
        )
    return None


def serve():
    import runtime_service as service
    stopping = threading.Event()
    for number in (signal.SIGTERM, signal.SIGINT):
        signal.signal(number, lambda *_: stopping.set())
    paths = service.prepare_storage()
    bootstrap = service.initialize_accepted_store(paths)
    container_recovery = service.recover_container_namespace(paths)
    # An explicit host authorization is the only route that may transition a
    # stale failed owner.  It must complete before configuration generation
    # rotation; ordinary startup never invokes this path.
    runtime_recovery = service.recover_idle_failure(paths)
    with service.container_recovery_configuration_override(paths, container_recovery):
        configuration = service.ensure_configuration(paths)
    print("[fullmag-backend] Starting API and runtime service", flush=True)
    api = subprocess.Popen(["/opt/fullmag/package/bin/fullmag-api"],
                           env=service.process_environment(paths))
    handle = None
    receipt = {"schema": "fullmag.docker-process-tree.v1", "state": "starting",
               "api_pid": api.pid, "accepted_store": str(paths.store),
               "bootstrap": bootstrap, "qualification": "NOT VERIFIED"}
    if runtime_recovery is not None:
        receipt["runtime_recovery"] = runtime_recovery
    if container_recovery is not None:
        receipt["container_recovery"] = container_recovery
        receipt["container_recovery_authorization"] = (
            service.container_recovery_authorization_metadata(paths, container_recovery)
        )
    receipt_path = service.process_receipt_path(paths)
    result = 1
    last_full_api_probe = 0.0
    degraded_since = None
    try:
        service._atomic_json(receipt_path, receipt, "process tree receipt")
        handle = service.start(paths, api_port=8081, expected_binding=bootstrap["binding"],
                               configuration=configuration)
        # Persist the authenticated owner before optional startup activation.
        # Activation may reject or fail after service.start has pinned the
        # native owner; the terminal drain receipt must retain that identity.
        receipt["service_owner"] = handle.owner
        service._atomic_json(receipt_path, receipt, "process tree receipt")
        last_full_api_probe = time.monotonic()
        try:
            startup_result = activate_startup_script()
        except StartupActivationOutcome as outcome:
            # The helper has already validated the durable started marker. A
            # server/transport outcome may have committed the run, so keep
            # the API and native owner supervised and never retry the POST.
            startup_result = outcome.diagnostic
            print(
                "[fullmag-backend] Startup activation outcome is unknown; "
                "API and runtime remain available: "
                + startup_result["error"],
                file=sys.stderr,
                flush=True,
            )
        if startup_result is not None:
            receipt["startup_activation"] = startup_result
            if startup_result.get("state") == "rejected":
                print(
                    "[fullmag-backend] Startup script rejected; API and runtime remain available: "
                    + startup_result["rejection"]["message"],
                    file=sys.stderr, flush=True,
                )
        receipt.update(state="ready", service_owner=handle.owner)
        service._atomic_json(receipt_path, receipt, "process tree receipt")
        print("[fullmag-backend] Ready: API and runtime service", flush=True)
        while not stopping.wait(1):
            status = api.poll()
            if status is not None:
                raise RuntimeError(f"Fullmag API exited unexpectedly ({status})")
            now = time.monotonic()
            full_api_probe = now - last_full_api_probe >= 5.0
            degraded_since = _supervise_once(
                service,
                handle,
                full_api_probe=full_api_probe,
                now=now,
                degraded_since=degraded_since,
            )
            if full_api_probe:
                last_full_api_probe = now
        result = 0
    except Exception as error:
        pinned_handle = getattr(error, "pinned_handle", None)
        if isinstance(pinned_handle, service.RuntimeHandle):
            handle = pinned_handle
            receipt["service_owner"] = handle.owner
            if getattr(error, "owner_pin_durable", False):
                receipt["owner_pin"] = str(service._owner_pin_path(paths, handle.owner))
                receipt["owner_pin_state"] = "durably-pinned-before-startup-observation"
            else:
                try:
                    receipt["owner_pin_candidate"] = str(
                        service._owner_pin_path(paths, handle.owner)
                    )
                except Exception:
                    pass
                receipt["owner_pin_state"] = (
                    "confirmed-owner-awaiting-authenticated-reprobe"
                )
        _retain_liveness_observation(receipt, error)
        receipt.update(state="failed_outcome_retained", error=str(error))
        print(f"[fullmag-backend] Startup or runtime failed; admission closed: {str(error)[-4096:]}. "
              f"Process receipt: {receipt_path}", file=sys.stderr, flush=True)
        if api.poll() is None:
            api.terminate()
        try:
            receipt["api_exit_code"] = api.wait(timeout=10)
        except subprocess.TimeoutExpired:
            receipt["api_shutdown"] = "unknown"
        service._atomic_json(receipt_path, receipt, "process tree receipt")
        # Failed observation must preserve a possibly live detached service.
        # Keep PID 1 alive with admission closed until an explicit stop.
        while not stopping.wait(1):
            pass
    finally:
        # Close this container's admission before draining its authenticated
        # scheduler owner. Never infer completion from an unconfirmed timeout.
        if api.poll() is None:
            api.terminate()
        try:
            receipt["api_exit_code"] = api.wait(timeout=10)
            if handle is not None:
                receipt["terminal_service_owner"] = service.stop(handle, timeout=30)
                receipt["state"] = "drained"
            else:
                receipt.update(
                    state="shutdown_unknown",
                    shutdown_error="no pinned runtime service owner was available for authenticated drain",
                )
        except Exception as error:
            receipt.update(state="shutdown_unknown", shutdown_error=str(error))
            raise
        finally:
            service._atomic_json(receipt_path, receipt, "process tree receipt")
    return result


def serve_frontend():
    import frontend_dev
    stopping = threading.Event()
    for number in (signal.SIGTERM, signal.SIGINT):
        signal.signal(number, lambda *_: stopping.set())
    handle = None
    try:
        handle = frontend_dev.start(stopping)
        while not stopping.wait(1):
            frontend_dev.check(handle)
        return 0
    except Exception as error:
        handle = getattr(error, "frontend_handle", handle)
        raise
    finally:
        if handle is not None:
            frontend_dev.stop(handle)


if __name__ == "__main__":
    role = os.environ.get("FULLMAG_DOCKER_ROLE", "backend")
    if role == "frontend":
        if "--storage-probe" in sys.argv:
            raise RuntimeError("Frontend cannot run the session storage probe")
        sys.exit(serve_frontend())
    if role != "backend":
        raise RuntimeError("Unsupported Fullmag Docker role")
    preflight()
    if "--storage-probe" in sys.argv:
        sys.exit(0)
    sys.exit(serve())
