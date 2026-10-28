"""Supervise runtime execution while retaining API diagnostics on startup failure."""
import ctypes
import hashlib
import os
import re
import secrets
import subprocess
import sys
import signal
import stat
import threading
import time
import uuid
from pathlib import Path


STARTUP_ACTIVATION_DIAGNOSTIC_SCHEMA = "fullmag.startup-activation-diagnostic.v1"
DEVICE_ACCESS_CPU = "cpu"
DEVICE_ACCESS_GPU = "gpu"
CUDA_COMPATIBILITY_ROOT = Path("/usr/local/cuda/compat")
RUNTIME_CONTROL_ROOT = Path("/opt/fullmag/runtime-control")
BUILD_CONTROL_BACKEND_ROOT = Path("/opt/fullmag/control/backend")
FEM_MESH_CACHE_ROOT = Path("/build/cache/fem-mesh")
CUDA_CACHE_ROOT = Path("/build/cache/cuda-compute")

OPERATOR_CAPABILITY_ENV = "FULLMAG_LOCAL_COMPUTE_OPERATOR_TOKEN"
OPERATOR_CAPABILITY_DIRNAME = "operator-capability"
OPERATOR_CAPABILITY_FILENAME = "token"
OPERATOR_CAPABILITY_TOKEN_BYTES = 16
OPERATOR_CAPABILITY_MAX_BYTES = 64
_CONTROL_VOLUME_NAME_RE = re.compile(r"[a-z0-9][a-z0-9_.-]{0,127}")
_OPERATOR_TOKEN_RE = re.compile(r"[0-9a-f]{32}")


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


def _operator_capability_enabled():
    """Enable the private operator capability only for direct DEV backends."""

    if os.environ.get("FULLMAG_DOCKER_ROLE") != "backend":
        return False
    volume = os.environ.get("FULLMAG_BUILD_CONTROL_VOLUME")
    if not isinstance(volume, str) or not volume:
        return False
    if _CONTROL_VOLUME_NAME_RE.fullmatch(volume) is None:
        raise RuntimeError("FULLMAG_BUILD_CONTROL_VOLUME is invalid")
    return True


def _operator_assert_no_links(path, name):
    """Reject symlinks and Windows reparse points in a capability path."""

    path = Path(path)
    if not path.is_absolute() or any(part == ".." for part in path.parts):
        raise RuntimeError(f"{name} must be absolute without parent traversal")
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            continue
        except OSError as error:
            raise RuntimeError(f"cannot inspect {name}") from error
        if stat.S_ISLNK(metadata.st_mode) or bool(
                getattr(metadata, "st_file_attributes", 0) & 0x400):
            raise RuntimeError(f"{name} traverses a link or reparse point")


def _operator_metadata(path, name):
    try:
        return Path(path).lstat()
    except FileNotFoundError:
        return None
    except OSError as error:
        raise RuntimeError(f"cannot inspect {name}") from error


def _operator_require_directory(path, name, *, create=False, mode=None):
    path = Path(path)
    _operator_assert_no_links(path, name)
    metadata = _operator_metadata(path, name)
    if metadata is None and create:
        try:
            path.mkdir(mode=0o700)
        except FileExistsError:
            pass
        metadata = _operator_metadata(path, name)
    if (metadata is None or not stat.S_ISDIR(metadata.st_mode)
            or metadata.st_uid != os.getuid()
            or (mode is not None and stat.S_IMODE(metadata.st_mode) != mode)):
        raise RuntimeError(f"{name} must be a private directory owned by the backend")
    return path


def operator_capability_path(control_root=BUILD_CONTROL_BACKEND_ROOT):
    """Return the fixed backend control-volume path for the capability token."""

    backend_root = _operator_require_directory(control_root, "backend control namespace")
    return backend_root / OPERATOR_CAPABILITY_DIRNAME / OPERATOR_CAPABILITY_FILENAME


def _operator_require_file(path, name):
    metadata = _operator_metadata(path, name)
    if (metadata is None or not stat.S_ISREG(metadata.st_mode)
            or metadata.st_nlink != 1
            or metadata.st_uid != os.getuid()
            or stat.S_IMODE(metadata.st_mode) != 0o600
            or bool(getattr(metadata, "st_file_attributes", 0) & 0x400)):
        raise RuntimeError(f"{name} must be one private regular file")
    return metadata


def read_operator_capability(control_root=BUILD_CONTROL_BACKEND_ROOT):
    """Read and validate the image-private operator token for a fixed backend."""

    if not _operator_capability_enabled():
        return None
    path = operator_capability_path(control_root)
    _operator_require_directory(path.parent, "operator capability directory", mode=0o700)
    _operator_assert_no_links(path.parent, "operator capability parent")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise RuntimeError("operator capability is unavailable") from error
    try:
        metadata = os.fstat(descriptor)
        if (not stat.S_ISREG(metadata.st_mode)
                or metadata.st_size > OPERATOR_CAPABILITY_MAX_BYTES
                or metadata.st_nlink != 1
                or metadata.st_uid != os.getuid()
                or stat.S_IMODE(metadata.st_mode) != 0o600
                or bool(getattr(metadata, "st_file_attributes", 0) & 0x400)):
            raise RuntimeError("operator capability file is not private and regular")
        raw = bytearray()
        while len(raw) <= OPERATOR_CAPABILITY_MAX_BYTES:
            chunk = os.read(descriptor, OPERATOR_CAPABILITY_MAX_BYTES + 1 - len(raw))
            if not chunk:
                break
            raw.extend(chunk)
        if len(raw) > OPERATOR_CAPABILITY_MAX_BYTES:
            raise RuntimeError("operator capability file is too large")
    except OSError as error:
        raise RuntimeError("operator capability cannot be read") from error
    finally:
        os.close(descriptor)
    if len(raw) != OPERATOR_CAPABILITY_TOKEN_BYTES * 2 + 1 or raw[-1:] != b"\n":
        raise RuntimeError("operator capability has an invalid format")
    try:
        token = bytes(raw[:-1]).decode("ascii", "strict")
    except UnicodeDecodeError as error:
        raise RuntimeError("operator capability has an invalid format") from error
    if _OPERATOR_TOKEN_RE.fullmatch(token) is None:
        raise RuntimeError("operator capability has an invalid format")
    return token


def prepare_operator_capability(control_root=BUILD_CONTROL_BACKEND_ROOT):
    """Rotate the private token once before API startup in direct DEV mode."""

    if not _operator_capability_enabled():
        return None
    path = operator_capability_path(control_root)
    _operator_require_directory(path.parent, "operator capability directory", create=True, mode=0o700)
    _operator_assert_no_links(path.parent, "operator capability parent")
    existing = _operator_metadata(path, "operator capability")
    if existing is not None:
        _operator_require_file(path, "operator capability")
    token = secrets.token_hex(OPERATOR_CAPABILITY_TOKEN_BYTES)
    payload = (token + "\n").encode("ascii")
    temporary = path.parent / f".{path.name}.{uuid.uuid4().hex}.tmp"
    flags = (os.O_WRONLY | os.O_CREAT | os.O_EXCL
             | getattr(os, "O_NOFOLLOW", 0)
             | getattr(os, "O_CLOEXEC", 0))
    descriptor = None
    temporary_created = False
    try:
        try:
            descriptor = os.open(temporary, flags, 0o600)
            temporary_created = True
            metadata = os.fstat(descriptor)
            if (not stat.S_ISREG(metadata.st_mode)
                    or metadata.st_nlink != 1
                    or metadata.st_uid != os.getuid()
                    or stat.S_IMODE(metadata.st_mode) != 0o600):
                raise RuntimeError("operator capability temporary file is not private and regular")
            offset = 0
            while offset < len(payload):
                offset += os.write(descriptor, payload[offset:])
            os.fsync(descriptor)
        except OSError as error:
            raise RuntimeError("operator capability cannot be published") from error
        finally:
            if descriptor is not None:
                os.close(descriptor)
        try:
            _operator_require_file(temporary, "operator capability temporary file")
            _operator_assert_no_links(path.parent, "operator capability parent")
            existing = _operator_metadata(path, "operator capability")
            if existing is not None:
                _operator_require_file(path, "operator capability")
            os.replace(temporary, path)
            directory_descriptor = os.open(
                path.parent,
                os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0),
            )
            try:
                os.fsync(directory_descriptor)
            finally:
                os.close(directory_descriptor)
            if read_operator_capability(control_root) != token:
                raise RuntimeError("operator capability changed after publication")
            return token
        except OSError as error:
            raise RuntimeError("operator capability cannot be durably published") from error
    finally:
        if temporary_created:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass
            except OSError:
                pass


def _api_environment_with_operator_capability(api_environment, control_root=BUILD_CONTROL_BACKEND_ROOT):
    """Give only the API child a freshly rotated private operator token."""

    environment = dict(api_environment)
    if not _operator_capability_enabled():
        return environment
    if OPERATOR_CAPABILITY_ENV in os.environ:
        raise RuntimeError("operator capability must not be supplied through the environment")
    environment.pop(OPERATOR_CAPABILITY_ENV, None)
    token = prepare_operator_capability(control_root)
    if token is not None:
        environment[OPERATOR_CAPABILITY_ENV] = token
    return environment


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
    if os.environ.get("FULLMAG_SESSION_STORAGE_PROFILE") == "linux-native-v1":
        from linux_native_probe import run
        run(require_restart="--storage-probe" not in sys.argv)
    # Same supported writer filesystem types as the managed browser route.
    if kind.lower().lstrip("0") == "1021997" and os.environ.get("FULLMAG_SESSION_STORAGE_PROFILE") == "windows-folder-v1":
        from windows_folder_probe import run
        run(require_restart="--storage-probe" not in sys.argv)
    elif kind.lower().lstrip("0") not in {"ef53", "58465342", "9123683e", "1021994", "794c7630"}:
        raise RuntimeError(f"Unsupported durable session filesystem 0x{kind}; "
                           "configure supported project storage; no ephemeral fallback")
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
                "FULLMAG_STARTUP_HELPER_SHA256", "FULLMAG_STARTUP_RECEIPT_KEY")):
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
        receipt_key = os.environ.get("FULLMAG_STARTUP_RECEIPT_KEY")
        if receipt_key is not None:
            docker_startup_script.ACTIVATION_RECEIPT_PATH = (
                docker_startup_script.activation_receipt_path_for_key(receipt_key)
            )
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


def _retain_diagnostic_api(service, handle, api, fence_path, error):
    """Fence new operations before retaining the exact API for diagnostics.

    The marker is private to this API incarnation and is never removed by
    recovery of a transient observation. In-flight work is not replayed.
    """
    if api.poll() is not None:
        return False
    if handle is not None and handle.api_identity:
        api_identity, api_port = handle.api_identity, handle.api_port
        stage = "runtime_supervision"
    elif isinstance(error, service.RuntimeServiceOwnerStartupFailure):
        api_identity, api_port = error.api_identity, error.api_port
        stage = "runtime_startup"
    else:
        return False
    service._atomic_json(fence_path, {
        "schema": "fullmag.api-runtime-failure-fence.v1",
        "api_pid": api.pid,
        "api_instance_id": api_identity["api_instance_id"],
        "stage": stage,
        "reason": str(error)[-4096:],
        "next_action": "Inspect runtime diagnostics and repair before a managed restart; do not replay Compute.",
    }, "runtime failure admission fence")
    # A matching health response acknowledges that this binary has latched
    # the fence. Older binaries cannot silently remain admission-open.
    deadline = time.monotonic() + 15.0
    while api.poll() is None and time.monotonic() < deadline:
        try:
            status, headers, body = service._http_json(
                api_port, "/v2/platform/health", timeout=2.0
            )
            if (status == 200 and body.get("status") == "degraded"
                    and service._single_header(headers, "x-fullmag-api-instance")
                    == api_identity["api_instance_id"]):
                return True
        except (service.RuntimeServiceError, OSError):
            pass
        time.sleep(0.25)
    return False


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


def _serve_startup_diagnostics(service, paths, stopping, error):
    """Keep the API observable without claiming or recovering runtime ownership."""
    fence_path = service.process_receipt_path(paths).parent / (
        "api-failure-" + uuid.uuid4().hex + ".json"
    )
    # Publish before spawn: the API must skip all execution/restore setup,
    # not merely reject HTTP mutations after startup has already changed state.
    service._atomic_json(fence_path, {
        "schema": "fullmag.api-runtime-failure-fence.v1",
        "stage": "runtime_startup",
        "reason": str(error)[-4096:],
        "next_action": "Inspect the startup error; execution is blocked. No task was replayed.",
    }, "startup diagnostic fence")
    environment = service.process_environment(paths)
    environment["FULLMAG_API_RUNTIME_FAILURE_FENCE"] = str(fence_path)
    api = subprocess.Popen(
        ["/opt/fullmag/package/bin/fullmag-api"], env=environment,
        stdin=subprocess.DEVNULL,
    )
    print(
        "[fullmag-backend] Runtime startup failed; starting diagnostic API only: "
        + str(error)[-4096:] + ". Diagnostic: " + str(fence_path),
        file=sys.stderr, flush=True,
    )
    # Do not replace OWNER/process-tree evidence from the interrupted runtime.
    # This child has no runtime owner, does not run recovery and is never retried.
    try:
        while not stopping.wait(1):
            status = api.poll()
            if status is not None:
                print(f"[fullmag-backend] Diagnostic API exited ({status}); no automatic restart.",
                      file=sys.stderr, flush=True)
                return status if status != 0 else 1
        return 0
    finally:
        if api.poll() is None:
            api.terminate()
        try:
            api.wait(timeout=10)
        except subprocess.TimeoutExpired:
            print("[fullmag-backend] Diagnostic API shutdown is unconfirmed.",
                  file=sys.stderr, flush=True)


def _start_cache_maintenance(service, receipt_path, ready_receipt):
    if os.environ.get("FULLMAG_AUTO_CACHE_MAINTENANCE", "0") != "1":
        return None
    try:
        import backend_auto_maintenance
        return backend_auto_maintenance.start(receipt_path, service._atomic_json, ready_receipt)
    except Exception as error:
        print(f"[fullmag-backend] Cache maintenance could not start: {error}", file=sys.stderr, flush=True)
        return None


def _observe_cache_maintenance(maintenance, *, stopping=False):
    if maintenance is None:
        return
    try:
        if stopping:
            maintenance.stop()
        else:
            maintenance.poll()
    except Exception as error:
        print(f"[fullmag-backend] Cache maintenance failed: {error}", file=sys.stderr, flush=True)
        if not stopping:
            try:
                maintenance.stop()
            except Exception as stop_error:
                print(f"[fullmag-backend] Cache maintenance shutdown failed: {stop_error}", file=sys.stderr, flush=True)


def serve():
    import runtime_service as service
    import runtime_service_unclaimed_cancellation as unclaimed_cancellation
    stopping = threading.Event()
    for number in (signal.SIGTERM, signal.SIGINT):
        signal.signal(number, lambda *_: stopping.set())
    paths = service.prepare_storage()
    try:
        bootstrap = service.initialize_accepted_store(paths)
    except Exception as error:
        return _serve_startup_diagnostics(service, paths, stopping, error)
    cancellation = unclaimed_cancellation.run(paths, service, stopping)
    if cancellation is not None:
        print(
            "[fullmag-backend] Unclaimed cancellation maintenance receipt: "
            + cancellation["receipt_path"],
            flush=True,
        )
        native_result = cancellation["native_result"]
        if native_result["disposition"] != "cancelled":
            raise RuntimeError(
                "unclaimed cancellation projection is deferred; API startup and "
                "configuration rotation remain stopped"
            )
        # This explicit one-shot operation is a maintenance stop. The host must
        # inspect the immutable receipt, capture the post-cancel catalog pins,
        # and issue a separate recovery/start operation.
        print(
            "[fullmag-backend] Maintenance completed successfully; stopping with exit code 0. "
            "API was not started. Explicit recovery/start is required; no simulation was replayed.",
            flush=True,
        )
        return 0
    try:
        accepted_preflight = service.accepted_reattach_preflight(paths)
        container_recovery = service.recover_container_namespace(paths)
        # These legacy paths still require explicit authorization. Ordinary
        # startup never repairs an old owner or retries a previous script.
        runtime_recovery = service.recover_idle_failure(paths)
        with service.container_recovery_configuration_override(paths, container_recovery):
            if (os.environ.get(service.POST_BUILD_START_ENV) is not None
                    or os.environ.get(service.POST_BUILD_START_SHA_ENV) is not None):
                configuration = service.ensure_configuration(
                    paths, accepted_preflight=accepted_preflight
                )
            else:
                configuration = service.ensure_configuration(paths)
    except Exception as error:
        return _serve_startup_diagnostics(service, paths, stopping, error)
    print("[fullmag-backend] Starting API and runtime service", flush=True)
    failure_fence = service.process_receipt_path(paths).parent / (
        "api-failure-" + uuid.uuid4().hex + ".json"
    )
    with service.accepted_reattach_api_input(paths, preflight=accepted_preflight) as (api_environment, restore_input):
        api_environment = _api_environment_with_operator_capability(api_environment)
        api_environment["FULLMAG_API_RUNTIME_FAILURE_FENCE"] = str(failure_fence)
        api = subprocess.Popen(["/opt/fullmag/package/bin/fullmag-api"],
                               env=api_environment, stdin=restore_input)
    handle = None
    maintenance = None
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
    accepted_runtime = None
    try:
        service._atomic_json(receipt_path, receipt, "process tree receipt")
        api_startup_timeout = (
            service.ACCEPTED_REATTACH_API_STARTUP_TIMEOUT_SECONDS
            if accepted_preflight is not None
            else None
        )
        handle = service.start(paths, api_port=8081, expected_binding=bootstrap["binding"],
                               configuration=configuration,
                               api_startup_timeout=api_startup_timeout,
                               api_process_poll=api.poll)
        # Persist the authenticated owner before optional startup activation.
        # Activation may reject or fail after service.start has pinned the
        # native owner; the terminal drain receipt must retain that identity.
        receipt["service_owner"] = handle.owner
        service._atomic_json(receipt_path, receipt, "process tree receipt")
        if accepted_preflight is not None:
            # The native API writes an immutable, API-instance-bound
            # acknowledgement after restoring the run.  Its restore_mode is
            # the native proof-backed outcome (held or terminally consumed);
            # do not infer it from a mutable workspace marker or old bytes.
            accepted_runtime = service.accepted_reattach_runtime_ack(
                paths, preflight=accepted_preflight, handle=handle
            )
            receipt["accepted_reattach"] = accepted_runtime
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
        maintenance = _start_cache_maintenance(service, receipt_path, receipt)
        while not stopping.wait(1):
            _observe_cache_maintenance(maintenance)
            status = api.poll()
            if status is not None:
                raise RuntimeError(f"Fullmag API exited unexpectedly ({status})")
            now = time.monotonic()
            full_api_probe = (
                now - last_full_api_probe >= service.SUPERVISION_FULL_API_PROBE_SECONDS
            )
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
        diagnostic_api = False
        try:
            diagnostic_api = _retain_diagnostic_api(service, handle, api, failure_fence, error)
        except Exception as fence_error:
            receipt["api_fence_error"] = str(fence_error)[-2048:]
        receipt["api_diagnostic_only"] = diagnostic_api
        receipt["api_failure_fence"] = str(failure_fence)
        if diagnostic_api:
            print("[fullmag-backend] API retained for diagnostics; new operations are fenced. "
                  "No simulation will be replayed automatically.", file=sys.stderr, flush=True)
        else:
            # An unconfirmed fence must never leave an admission-open API.
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
            _observe_cache_maintenance(maintenance)
    finally:
        # Close this container's admission before draining its authenticated
        # scheduler owner. Never infer completion from an unconfirmed timeout.
        if api.poll() is None:
            api.terminate()
        _observe_cache_maintenance(maintenance, stopping=True)
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
            if receipt.get("state") == "drained" and accepted_runtime is not None:
                # The immutable successor-drain record is published only after
                # the drained process receipt is durable.  If this publication
                # fails, the next start remains fail-closed and requires recovery.
                service.accepted_reattach_record_drain(
                    paths, runtime=accepted_runtime, receipt_path=receipt_path
                )
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
