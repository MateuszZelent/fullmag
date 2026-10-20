"""Fail before API startup when device access or durable state is unavailable."""
import ctypes
import hashlib
import os
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
FEM_MESH_CACHE_ROOT = Path("/build/cache/fem-mesh")
CUDA_CACHE_ROOT = Path("/build/cache/cuda-compute")


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
    accepted_preflight = service.accepted_reattach_preflight(paths)
    container_recovery = service.recover_container_namespace(paths)
    # An explicit host authorization is the only route that may transition a
    # stale failed owner.  It must complete before configuration generation
    # rotation; ordinary startup never invokes this path.
    runtime_recovery = service.recover_idle_failure(paths)
    with service.container_recovery_configuration_override(paths, container_recovery):
        configuration = service.ensure_configuration(paths)
    print("[fullmag-backend] Starting API and runtime service", flush=True)
    with service.accepted_reattach_api_input(paths, preflight=accepted_preflight) as (api_environment, restore_input):
        api = subprocess.Popen(["/opt/fullmag/package/bin/fullmag-api"],
                               env=api_environment, stdin=restore_input)
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
    accepted_runtime = None
    try:
        service._atomic_json(receipt_path, receipt, "process tree receipt")
        handle = service.start(paths, api_port=8081, expected_binding=bootstrap["binding"],
                               configuration=configuration)
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
