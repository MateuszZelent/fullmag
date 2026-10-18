#!/usr/bin/env python3
"""Start Fullmag's direct, fixed two-container Docker development workspace.

``up`` prepares one registered Windows checkout, starts the persistent backend
service and frontend service, and waits for the backend service to publish its
receipt-validated package and runtime provenance.  The backend compiles inside
that same long-lived service; no host package transfer or one-shot backend
container is used.  ``build`` is an explicit alias for this service-owned
build gate and leaves both services running so the receipt remains observable.

The existing runtime launcher still owns Windows storage attestation, the
frontend cache, host ledger, startup-script admission, and final Compose
readiness.  The canonical Windows heavy-build lease covers only preparation
of the image, toolchain, cache, and backend-start receipt.  The long-lived
backend service owns its compile after that lease is released.  Frontend edits
remain HMR-driven; an ordinary restart of the fixed backend service re-observes
the live readonly source and rebuilds incrementally without a host ``up`` or
``build`` invocation.
"""

from __future__ import annotations

import argparse
from collections.abc import Mapping, Sequence
from contextlib import nullcontext
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import time
import uuid


DEFAULT_COMPOSE_PROJECT = "fullmag-master"
STORAGE_PROFILE = "docker-all-gpu"
DEFAULT_IMAGE = "fullmag/fullmag-dev:local"
DEFAULT_BASE_IMAGE = "fullmag/development-base:local"
DEVELOPMENT_BASE_SERVICE = "development-base"
COMPOSE_BUILD_FILE = "compose.backend-build.yaml"
COMPOSE_LIVE_BUILD_FILE = "compose.backend-build-live.yaml"
COMPOSE_RUNTIME_FILE = "compose.dev.yaml"
TOOLCHAIN_BOOTSTRAP_RECEIPT = "index/docker-toolchain-bootstrap.json"
TOOLCHAIN_MANIFEST_PATH = "/opt/fullmag-deps/share/fullmag/dependency-versions.json"
TOOLCHAIN_MANIFEST_SCHEMA = "fullmag.docker.fem-gpu-dependencies.v1"
DEVELOPMENT_BASE_CONTEXT_SCHEMA = "fullmag.direct-compose.development-base-context.v1"
DEVELOPMENT_IMAGE_SCHEMA = "fullmag.direct-compose.development-image.v1"
RUNTIME_IMAGE_CONTEXT_SCHEMA = "fullmag.direct-compose.runtime-image-context.v1"
BACKEND_START_INPUTS_SCHEMA = "fullmag.direct-compose.backend-start-inputs.v1"
BASE_CONTEXT_FILES = (
    ("Dockerfile.dev", "docker/all-in-one/Dockerfile.dev"),
    ("Dockerfile.dev.dockerignore", "docker/all-in-one/Dockerfile.dev.dockerignore"),
    ("entrypoint.py", "docker/all-in-one/entrypoint.py"),
    ("windows_folder_probe.py", "docker/all-in-one/windows_folder_probe.py"),
    ("runtime_service.py", "docker/all-in-one/runtime_service.py"),
    ("frontend_dev.py", "docker/all-in-one/frontend_dev.py"),
    ("healthcheck.py", "docker/all-in-one/healthcheck.py"),
    ("docker_startup_script.py", "scripts/docker_startup_script.py"),
    ("fullmag_storage.py", "scripts/fullmag_storage.py"),
)
RUNTIME_IMAGE_CONTEXT_FILES = (
    ("Dockerfile.backend", "docker/all-in-one/Dockerfile.backend"),
    ("backend_dev.py", "docker/all-in-one/backend_dev.py"),
    ("backend_source.py", "docker/all-in-one/backend_source.py"),
    (
        "backend_volume_cache_maintenance.py",
        "docker/all-in-one/backend_volume_cache_maintenance.py",
    ),
)
REQUIRED_LANES = ("fdm-cpu", "fdm-gpu", "fem-cpu", "fem-gpu")
BUILD_PROFILE_TO_CARGO_PROFILE = {
    "dev": "backend-dev",
    "release": "release",
}
DEFAULT_BUILD_PROFILE = "dev"
SUPPORTED_CARGO_PROFILES = frozenset(BUILD_PROFILE_TO_CARGO_PROFILE.values())
BACKEND_CARGO_PROFILE = BUILD_PROFILE_TO_CARGO_PROFILE[DEFAULT_BUILD_PROFILE]
GPU_ACCESS_CHOICES = frozenset({"auto", "required", "disabled"})
DEVICE_ACCESS_CHOICES = frozenset({"cpu", "gpu"})
GPU_UUID_RE = re.compile(
    r"^GPU-[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$"
)
CUDA_DEVICE_PROBE = (
    "import ctypes; "
    "driver=ctypes.CDLL('libcuda.so.1'); "
    "rc=driver.cuInit(0); "
    "count=ctypes.c_int(); "
    "rc = rc or driver.cuDeviceGetCount(ctypes.byref(count)); "
    "raise SystemExit(1 if rc != 0 or count.value < 1 else 0)"
)
REQUIRED_STARTUP_HELPERS = (
    "docker_startup_script.py",
    "fullmag_storage.py",
)
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
IMAGE_ID_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
CONTROL_RELATIVE_RE = re.compile(r"^[a-z0-9][a-z0-9._/-]*[a-z0-9]$")
MAX_CONTROL_RECORD_BYTES = 8 * 1024 * 1024
CONTROL_NAMESPACE = "docker-dev"


class DirectDockerError(RuntimeError):
    """A direct Docker build or launch could not be admitted safely."""


class DirectDockerOutcomeUnknown(DirectDockerError):
    """The Docker client timed out while the daemon may still own resources."""


def _bootstrap_module():
    """Load the selected-checkout bootstrap contract lazily.

    Importing this module lazily keeps source-only helpers usable in tests and
    makes the control-volume boundary explicit: all writes go through the
    bootstrap's Compose helper, never through ``fullmag_storage``.
    """

    import bootstrap_docker_toolchain

    return bootstrap_docker_toolchain


def _control_relative_path(value: str) -> str:
    if (not isinstance(value, str) or not value or value.startswith("/")
            or "\\" in value or ".." in value.split("/")):
        raise _fail("Docker control record path is unsafe")
    if CONTROL_RELATIVE_RE.fullmatch(value) is None:
        raise _fail("Docker control record path contains unsupported characters")
    return value


def _control_guest_path(relative: str) -> str:
    relative = _control_relative_path(relative)
    return f"{_bootstrap_module().CONTROL_ROOT}/{relative}"


def _control_volume_name(project: str) -> str:
    """Return the exact control volume identity shared with bootstrap."""

    try:
        return str(_bootstrap_module().control_volume_name(project))
    except Exception as error:
        raise _fail(f"cannot derive Docker control volume for {project!r}: {error}") from error


def _toolchain_image_reference(project: str) -> str:
    """Return the exact stable toolchain tag used by bootstrap."""

    try:
        return str(_bootstrap_module().toolchain_image_reference(project))
    except Exception as error:
        raise _fail(f"cannot derive Docker toolchain image for {project!r}: {error}") from error


def _control_record_path(kind: str, project: str, identity: str, suffix: str = ".json") -> str:
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]*", kind):
        raise _fail("Docker control record kind is unsafe")
    digest = _sha256_bytes(f"{project}\0{kind}\0{identity}".encode("utf-8"))
    return _control_guest_path(f"{CONTROL_NAMESPACE}/{kind}/{digest[:32]}{suffix}")


def _control_relative_from_guest(path: str) -> str:
    root = _bootstrap_module().CONTROL_ROOT.rstrip("/") + "/"
    if not isinstance(path, str) or not path.startswith(root):
        raise _fail("Docker control path is outside the shared control volume")
    return _control_relative_path(path[len(root):])


def _write_control(repo: Path, project: str, relative: str, data: bytes) -> str:
    relative = _control_relative_path(relative)
    if not isinstance(data, bytes) or len(data) > MAX_CONTROL_RECORD_BYTES:
        raise _fail("Docker control record is missing or exceeds the bounded size")
    try:
        _bootstrap_module().ensure_control_volume(project)
        _bootstrap_module().write_control(repo, project, relative, data)
    except Exception as error:
        raise _fail(f"cannot persist Docker control record {relative}: {error}") from error
    return _control_guest_path(relative)


def _write_control_json(repo: Path, project: str, relative: str,
                        value: Mapping[str, object]) -> str:
    data = (json.dumps(value, ensure_ascii=True, indent=2, sort_keys=True) + "\n").encode("utf-8")
    return _write_control(repo, project, relative, data)


def _read_control(repo: Path, project: str, relative: str) -> bytes:
    relative = _control_relative_path(relative)
    try:
        data = _bootstrap_module().read_control(repo, project, relative)
    except Exception as error:
        raise _fail(f"cannot read Docker control record {relative}: {error}") from error
    if len(data) > MAX_CONTROL_RECORD_BYTES:
        raise _fail("Docker control record exceeds the bounded size")
    return data


def _read_control_json(repo: Path, project: str, relative: str,
                       label: str) -> dict[str, object]:
    raw = _read_control(repo, project, relative)
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise _fail(f"{label} in the Docker control volume is invalid") from error
    if not isinstance(value, dict):
        raise _fail(f"{label} in the Docker control volume is not an object")
    return value



def _fail(message: str) -> DirectDockerError:
    return DirectDockerError(message)


def _cargo_profile_for_build(profile: str) -> str:
    try:
        cargo_profile = BUILD_PROFILE_TO_CARGO_PROFILE[profile]
    except (KeyError, TypeError) as error:
        allowed = ", ".join(sorted(BUILD_PROFILE_TO_CARGO_PROFILE))
        raise _fail(f"build profile must be one of: {allowed}") from error
    return cargo_profile


def _validate_cargo_profile(profile: str) -> str:
    if profile not in SUPPORTED_CARGO_PROFILES:
        allowed = ", ".join(sorted(SUPPORTED_CARGO_PROFILES))
        raise _fail(f"backend Cargo profile must be one of: {allowed}")
    return profile


def _repo_default() -> Path:
    return Path(__file__).resolve().parents[1]


def _require_native_windows() -> None:
    if os.name != "nt":
        raise _fail(
            "direct Docker Compose development must run with native Windows Python; "
            "invoke it from PowerShell, not from WSL"
        )


def _resolve_gpu_access(requested: str | None) -> str:
    """Resolve host GPU access before any backend or Compose mutation."""

    requested = requested or os.environ.get("FULLMAG_GPU_ACCESS", "auto")
    if requested not in GPU_ACCESS_CHOICES:
        raise _fail("--gpu-access must be auto, required, or disabled")
    if requested == "disabled":
        return "cpu"
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=uuid", "--format=csv,noheader,nounits"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=5,
        )
        lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
        available = result.returncode == 0 and bool(lines) and all(
            GPU_UUID_RE.fullmatch(line) for line in lines
        )
    except (OSError, subprocess.TimeoutExpired):
        available = False
    if available:
        return "gpu"
    if requested == "required":
        raise _fail("--gpu-access required a bounded NVIDIA host proof, but nvidia-smi was unavailable")
    return "cpu"


def _verify_docker_gpu_access(
    device_access: str, policy: str | None, image_id: str, compose_project: str
) -> str:
    """Confirm GPU visibility through Docker before publishing backend inputs."""

    if device_access != "gpu" or policy is None:
        return device_access
    try:
        _docker_capture(
            "run", "--rm", "--pull", "never", "--network", "none",
            "--gpus", "all",
            "--read-only", "--user", "65532:65532", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges:true", "--pids-limit", "64",
            "--memory", "256m",
            "--label", f"org.fullmag.compose.project={compose_project}",
            "--label", f"com.docker.compose.project={compose_project}",
            "--label", "com.docker.compose.service=backend-gpu-probe",
            "--entrypoint", "/usr/local/bin/python3", image_id, "-c", CUDA_DEVICE_PROBE,
            timeout=30,
        )
    except DirectDockerOutcomeUnknown:
        raise
    except DirectDockerError as error:
        if policy == "required":
            raise _fail("--gpu-access required Docker GPU visibility proof: " + str(error)) from error
        return "cpu"
    return "gpu"


def _docker_argv(arguments: Sequence[object]) -> list[str]:
    command = ["docker"]
    if os.name == "nt":
        command.extend(("--context", "desktop-linux"))
    return command + [str(value) for value in arguments]


def _docker_capture(*arguments: object, timeout: int = 60,
                    environment: Mapping[str, str] | None = None,
                    combined: bool = False) -> str:
    command = _docker_argv(arguments)
    try:
        result = subprocess.run(
            command,
            text=True,
            capture_output=True,
            timeout=timeout,
            env=None if environment is None else {**os.environ, **dict(environment)},
        )
    except subprocess.TimeoutExpired as error:
        raise DirectDockerOutcomeUnknown(
            f"Docker client timed out after {timeout}s; daemon ownership is unknown: "
            + " ".join(command)
        ) from error
    output = result.stdout + result.stderr if combined else result.stdout
    if result.returncode:
        message = (result.stderr or result.stdout).strip()
        raise _fail(message or f"Docker command failed ({result.returncode}): {' '.join(command)}")
    return output.strip()


def _docker_live(log_path: Path | None, *arguments: object, timeout: int,
                 environment: Mapping[str, str] | None = None,
                 control_repo: Path | None = None,
                 control_project: str | None = None,
                 control_relative: str | None = None) -> None:
    """Stream a mutating Docker command and retain a bounded log in control.

    ``log_path`` is retained as a source-compatible label for older callers;
    it is deliberately never opened. Build output is copied to the selected
    Compose group's named control volume after the Docker client terminates.
    This prevents a failed or repeated build from creating host-side logs.
    """

    supplied_control = (control_repo, control_project, control_relative)
    if any(value is not None for value in supplied_control) and not all(
            value is not None for value in supplied_control):
        raise _fail("Docker build log persistence requires repo, project and control path")
    command = _docker_argv(arguments)
    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            env=None if environment is None else {**os.environ, **dict(environment)},
        )
    except OSError as error:
        raise _fail(f"cannot start Docker client: {error}") from error

    deadline = time.monotonic() + timeout
    warned = False
    interrupted = False
    output = bytearray()
    truncated = False
    exit_code: int | None = None
    try:
        assert process.stdout is not None
        while True:
            try:
                line = process.stdout.readline()
            except KeyboardInterrupt:
                interrupted = True
                continue
            if not line:
                break
            sys.stdout.write(line)
            sys.stdout.flush()
            encoded = line.encode("utf-8", "replace")
            remaining = MAX_CONTROL_RECORD_BYTES - len(output)
            if remaining > 0:
                output.extend(encoded[:remaining])
                if len(encoded) > remaining:
                    truncated = True
            elif encoded:
                truncated = True
            if not warned and time.monotonic() > deadline:
                warned = True
                print(
                    "[docker-dev] Docker build exceeded its observation budget; "
                    "waiting for terminal client exit before releasing the heavy lease",
                    file=sys.stderr,
                    flush=True,
                )
        while True:
            try:
                exit_code = process.wait()
                break
            except KeyboardInterrupt:
                interrupted = True
    except OSError as error:
        raise _fail(f"Docker client failed while streaming build output: {error}") from error
    if control_repo is not None and control_project is not None and control_relative is not None:
        if truncated:
            marker = b"\n[docker-dev] log truncated at the configured control-volume bound\n"
            if len(output) + len(marker) <= MAX_CONTROL_RECORD_BYTES:
                output.extend(marker)
        try:
            _write_control(control_repo, control_project, control_relative, bytes(output))
        except DirectDockerError as error:
            raise _fail(
                f"Docker command completed but its control-volume log could not be persisted: {error}"
            ) from error
    if interrupted:
        raise KeyboardInterrupt
    if exit_code:
        location = _control_guest_path(control_relative) if control_relative else "the Docker control volume"
        raise _fail(f"Docker command failed with exit code {exit_code}; see {location}")


def _read_json_output(output: str, label: str) -> object:
    candidates = [output.strip()]
    candidates.extend(line.strip() for line in reversed(output.splitlines()))
    seen: set[str] = set()
    for candidate in candidates:
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            continue
    raise _fail(f"{label} did not return JSON")


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _canonical_json(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=True, sort_keys=True,
                      separators=(",", ":")).encode("utf-8")


def _sha256_file(path: Path, label: str) -> str:
    if path.is_symlink() or not path.is_file():
        raise _fail(f"{label} is not a regular file: {path}")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _read_json(path: Path, label: str) -> tuple[dict[str, object], bytes]:
    if path.is_symlink() or not path.is_file():
        raise _fail(f"{label} is not a regular file: {path}")
    raw = path.read_bytes()
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise _fail(f"{label} is not valid JSON: {path}") from error
    if not isinstance(value, dict):
        raise _fail(f"{label} must be a JSON object: {path}")
    return value, raw


def _write_json(path: Path, value: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(
            json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def _inspect_image(reference: str) -> tuple[str, dict[str, object]]:
    raw = _docker_capture("image", "inspect", reference, timeout=60)
    value = _read_json_output(raw, "docker image inspect")
    if not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], dict):
        raise _fail("docker image inspect did not return one image")
    document = value[0]
    image_id = document.get("Id")
    if not isinstance(image_id, str) or not IMAGE_ID_RE.fullmatch(image_id):
        raise _fail("Docker image has no immutable sha256 identity")
    config = document.get("Config")
    if not isinstance(config, dict) or config.get("Volumes") not in (None, {}):
        raise _fail("direct development image must not declare anonymous volumes")
    return image_id, document


def _image_reference_present(reference: str) -> bool:
    try:
        _docker_capture("image", "inspect", reference, timeout=60)
    except DirectDockerOutcomeUnknown:
        raise
    except DirectDockerError:
        return False
    return True


def _image_file(image: str, path: str) -> bytes:
    command = _docker_argv(
        ("run", "--rm", "--pull", "never", "--network", "none", "--read-only",
         "--entrypoint", "/bin/cat", image, path)
    )
    try:
        result = subprocess.run(command, capture_output=True, timeout=60)
    except subprocess.TimeoutExpired as error:
        raise DirectDockerOutcomeUnknown(
            f"Docker helper read timed out; daemon ownership is unknown: {' '.join(command)}"
        ) from error
    if result.returncode:
        message = result.stderr.decode("utf-8", "replace").strip()
        raise _fail(message or f"cannot read {path} from development image")
    return bytes(result.stdout)


def _image_helper_inventory(image: str, destination: Path | None = None) -> dict[str, str]:
    """Attest image-owned startup helpers without copying them to the host."""

    if destination is not None:
        raise _fail(
            "host helper staging is not permitted; startup helpers must remain image-owned"
        )
    hashes: dict[str, str] = {}
    for name in REQUIRED_STARTUP_HELPERS:
        data = _image_file(image, "/opt/fullmag/" + name)
        if not data or len(data) > 4 * 1024 * 1024:
            raise _fail(f"development image helper is missing or oversized: {name}")
        hashes[name] = _sha256_bytes(data)
    return hashes


def _development_base_context(repo: Path, run_root: Path, toolchain_id: str,
                              toolchain_manifest: Mapping[str, object]) -> dict[str, object]:
    """Hash the base image inputs in memory; never stage a host context.

    ``run_root`` remains in the signature for callers from the pre-volume
    launcher, but is intentionally ignored. Docker Compose receives the
    selected checkout as its readonly build context.
    """

    files: dict[str, str] = {}
    for destination_name, relative_source in BASE_CONTEXT_FILES:
        source = repo / relative_source
        files[destination_name] = _sha256_file(
            source, "development base input"
        )
    manifest_sha256 = _sha256_bytes(_canonical_json(toolchain_manifest))
    identity = {
        "schema": DEVELOPMENT_BASE_CONTEXT_SCHEMA,
        "toolchain_image_id": toolchain_id,
        "toolchain_manifest_sha256": manifest_sha256,
        "files": files,
    }
    context_sha256 = _sha256_bytes(_canonical_json(identity))
    return {
        "source_root": str(repo),
        "toolchain_image_id": toolchain_id,
        "context_sha256": context_sha256,
        "toolchain_manifest_sha256": manifest_sha256,
        "helper_hashes": files,
        "receipt": None,
    }


def _runtime_image_context(repo: Path) -> dict[str, object]:
    """Hash the files copied by Dockerfile.backend before reusing an image."""

    files: dict[str, str] = {}
    for name, relative_source in RUNTIME_IMAGE_CONTEXT_FILES:
        source = repo / relative_source
        if source.is_symlink() or not source.is_file():
            raise _fail(f"runtime image context input is not a regular file: {source}")
        before = source.lstat()
        digest = hashlib.sha256()
        with source.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        after = source.lstat()
        signature = lambda metadata: (
            metadata.st_dev, metadata.st_ino, metadata.st_size,
            metadata.st_mtime_ns, metadata.st_ctime_ns,
        )
        if signature(before) != signature(after):
            raise _fail(f"runtime image context input changed during capture: {source}")
        files[name] = digest.hexdigest()
    identity = {"schema": RUNTIME_IMAGE_CONTEXT_SCHEMA, "files": files}
    return {**identity, "context_sha256": _sha256_bytes(_canonical_json(identity))}


def _image_labels(document: Mapping[str, object]) -> dict[str, str]:
    config = document.get("Config")
    labels = config.get("Labels") if isinstance(config, dict) else None
    if not isinstance(labels, dict):
        return {}
    return {str(key): str(value) for key, value in labels.items() if isinstance(key, str)}


def _toolchain_setup_message(detail: str) -> DirectDockerError:
    return _fail(
        f"{detail}; Docker will not pull a FEM/GPU toolchain automatically. "
        "Run `just docker-dev-toolchain` in the native Windows checkout first."
    )


def _bootstrap_toolchain_reference(layout: Mapping[str, object]) -> str | None:
    """Read the bootstrap receipt from the selected group's control volume."""

    try:
        identity = _compose_identity(layout)
        project = identity["project_name"]
        repo_value = layout.get("repo_root")
        if not isinstance(repo_value, str) or not repo_value:
            raise _toolchain_setup_message("resolved layout has no selected checkout")
        repo = Path(repo_value).resolve(strict=True)
        receipt = _read_control_json(
            repo, project, _bootstrap_module().CONTROL_RECEIPT,
            "toolchain bootstrap receipt",
        )
    except DirectDockerError as error:
        # A missing control receipt is the normal first-run state. The
        # bootstrap command is the only supported way to create it.
        if any(marker in str(error).lower() for marker in (
            "no such file", "not found", "cannot read docker control record",
        )):
            return None
        raise
    if receipt.get("state") != "built":
        raise _toolchain_setup_message(
            f"toolchain bootstrap receipt is not ready: {receipt.get('state')!r}"
        )
    reference = receipt.get("image")
    expected = _toolchain_image_reference(project)
    if reference != expected:
        raise _toolchain_setup_message(
            "toolchain bootstrap receipt image does not match the selected Compose group"
        )
    return expected


def _configured_toolchain_reference(args: argparse.Namespace,
                                    layout: Mapping[str, object]) -> str:
    reference = (
        args.toolchain_image
        or os.environ.get("FULLMAG_TOOLCHAIN_IMAGE")
        or _bootstrap_toolchain_reference(layout)
    )
    if not isinstance(reference, str) or not reference.strip():
        raise _toolchain_setup_message("no local FEM/GPU toolchain image is configured")
    return reference


def _preflight_dependency_image(image_id: str) -> tuple[dict[str, object], str]:
    """Use the shared runtime preflight for one immutable dependency image."""

    try:
        from fullmag_docker_runtime import DockerOutcomeUnknown, _preflight_toolchain_image
        manifest = _preflight_toolchain_image(image_id)
    except DockerOutcomeUnknown as error:
        raise DirectDockerOutcomeUnknown(
            f"toolchain manifest probe timed out; daemon ownership is unknown: {image_id}"
        ) from error
    except Exception as error:
        raise _toolchain_setup_message(
            f"toolchain image {image_id} failed the dependency manifest preflight"
        ) from error
    if not isinstance(manifest, dict) or manifest.get("schema") != TOOLCHAIN_MANIFEST_SCHEMA:
        raise _toolchain_setup_message("toolchain dependency manifest schema is unsupported")
    return manifest, _sha256_bytes(_canonical_json(manifest))


def _direct_image_tag(reference: str, kind: str, context_sha256: str) -> str:
    base = reference.split("@", 1)[0]
    last_slash = base.rfind("/")
    colon = base.rfind(":")
    repository = base[:colon] if colon > last_slash else base
    if not repository or repository == "sha256":
        repository = "fullmag/fullmag-dev" if kind == "runtime" else "fullmag/development-base"
    return f"{repository}:direct-{kind}-{context_sha256[:20]}"


def _stable_project_image_reference(project: str, kind: str) -> str:
    """Return one replaceable image tag owned by a Compose project.

    The context digest is carried by image labels and receipts in the control
    volume. Keeping the tag stable lets BuildKit reuse layers across source
    changes and prevents one run UUID from producing an unbounded image list.
    """

    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", project):
        raise _fail("Invalid Compose project name for development image")
    suffix = _sha256_bytes(project.encode("utf-8"))[:16]
    segment = project[:80].rstrip("-_") or "fullmag"
    if kind == "base":
        return f"fullmag/{segment}-{suffix}-development-base:live-shadow-v1"
    if kind == "runtime":
        return f"fullmag/{segment}-{suffix}-dev:live-shadow-v1"
    raise _fail(f"unsupported stable development image kind: {kind}")


def _read_image_metadata(layout: Mapping[str, object], reference: str) -> None:
    """Compatibility hook; image metadata now lives in Docker/control volume."""

    return None


def _write_image_metadata(layout: Mapping[str, object], reference: str,
                          value: Mapping[str, object]) -> None:
    raise _fail(
        "host image metadata receipts are disabled; persist provenance in the Docker control volume"
    )


def _validate_development_base(reference: str, *, expected_toolchain_id: str | None = None,
                               expected_context_sha256: str | None = None) -> dict[str, object]:
    image_id, document = _inspect_image(reference)
    labels = _image_labels(document)
    if labels.get("org.fullmag.runtime") != "docker-all-gpu-v1":
        raise _fail("development base image is not a Fullmag all-in-Docker runtime")
    if labels.get("org.fullmag.development") != "source-bind-v1":
        raise _fail("development base image is not the source-bind development image")
    toolchain_id = labels.get("org.fullmag.toolchain.image-id")
    if not isinstance(toolchain_id, str) or not IMAGE_ID_RE.fullmatch(toolchain_id):
        raise _fail("development base image has no immutable toolchain label")
    if expected_toolchain_id is not None and toolchain_id != expected_toolchain_id:
        raise _fail("development base image toolchain label differs from the requested image")
    manifest, manifest_sha256 = _preflight_dependency_image(image_id)
    context_sha256 = labels.get("org.fullmag.direct-development.context-sha256")
    if expected_context_sha256 is not None and context_sha256 != expected_context_sha256:
        raise _fail(
            "development base image context label differs; the existing image will not be replaced"
        )
    return {
        "reference": reference,
        "image_id": image_id,
        "labels": labels,
        "toolchain_image_id": toolchain_id,
        "toolchain_manifest": manifest,
        "toolchain_manifest_sha256": manifest_sha256,
        "context_sha256": context_sha256,
        "built": False,
    }


def _ensure_development_base(args: argparse.Namespace, repo: Path,
                             layout: Mapping[str, object], run_root: Path) -> dict[str, object]:
    """Build/admit the development base through the selected Compose group."""

    compose_project = _compose_identity(layout)["project_name"]
    configured = os.environ.get("FULLMAG_DEVELOPMENT_BASE_IMAGE")
    requested = configured or _stable_project_image_reference(compose_project, "base")
    toolchain_reference = _configured_toolchain_reference(args, layout)
    try:
        toolchain_id, _ = _inspect_image(toolchain_reference)
    except DirectDockerOutcomeUnknown:
        raise
    except DirectDockerError as error:
        raise _toolchain_setup_message(
            f"configured toolchain image is unavailable locally: {toolchain_reference}"
        ) from error
    toolchain_manifest, toolchain_manifest_sha256 = _preflight_dependency_image(toolchain_id)
    context_info = _development_base_context(repo, run_root, toolchain_id, toolchain_manifest)
    context_sha256 = str(context_info["context_sha256"])

    # A stable project tag is reusable only when its image labels describe the
    # exact current helper context and toolchain. The old host receipt is not
    # part of admission; Docker image metadata is the source of truth.
    if _image_reference_present(requested):
        try:
            existing = _validate_development_base(
                requested,
                expected_toolchain_id=toolchain_id,
                expected_context_sha256=context_sha256,
            )
        except DirectDockerOutcomeUnknown:
            raise
        except DirectDockerError:
            existing = None
        if existing is not None:
            existing["context"] = context_info
            existing["built"] = False
            existing["toolchain_manifest"] = toolchain_manifest
            existing["toolchain_manifest_sha256"] = toolchain_manifest_sha256
            return existing

    base_reference = requested
    source_identity = _compose_identity(layout)
    control_root = _bootstrap_module().CONTROL_ROOT
    # Compose validates interpolation for every service even when the targeted
    # operation only builds the profile-scoped base image. Provide valid,
    # non-runtime values for the unrelated application service mounts.
    build_environment = {
        **_compose_identity_environment(layout),
        "FULLMAG_DEV_IMAGE": base_reference,
        "FULLMAG_RELEASE_IMAGE": base_reference,
        "FULLMAG_DEVELOPMENT_BASE_IMAGE": base_reference,
        "FULLMAG_TOOLCHAIN_IMAGE": toolchain_reference,
        "FULLMAG_TOOLCHAIN_IMAGE_ID": toolchain_id,
        "FULLMAG_DIRECT_DEVELOPMENT_CONTEXT_SCHEMA": DEVELOPMENT_BASE_CONTEXT_SCHEMA,
        "FULLMAG_DIRECT_DEVELOPMENT_CONTEXT_SHA256": context_sha256,
        "FULLMAG_BUILD_CONTROL_VOLUME": _control_volume_name(compose_project),
        "FULLMAG_SOURCE_ROOT": str(repo),
        "FULLMAG_SOURCE_GIT_COMMON": str(repo),
        "FULLMAG_SOURCE_WORKTREE_ID": source_identity["worktree_id"],
        "FULLMAG_SOURCE_COMMIT": "0" * 40,
        "FULLMAG_DOCKER_DEVICE_ACCESS": "cpu",
        "FULLMAG_BACKEND_HOSTNAME": "fullmag-base-build-" + compose_project[:32],
        "FULLMAG_STATE_ROOT": str(run_root / "state"),
        "FULLMAG_HOST_CERTIFICATE": str(run_root / "host-certificate.json"),
        "FULLMAG_WORKSPACE_STATE_ROOT": str(
            Path(str(layout["storage_root"])) / "user-data" / compose_project
        ),
        "FULLMAG_DEVELOPMENT_INPUTS_PATH": f"{control_root}/frontend/development-inputs.json",
        "FULLMAG_FRONTEND_HOST_PORT": str(getattr(args, "port", 3197)),
    }
    log_relative = _control_record_path("development-base-build", compose_project, context_sha256, ".log")
    _docker_live(
        None,
        *_compose_prefix(repo, [repo / COMPOSE_RUNTIME_FILE], compose_project),
        "build", "--pull=false", "--progress=plain", DEVELOPMENT_BASE_SERVICE,
        timeout=4 * 60 * 60,
        environment=build_environment,
        control_repo=repo,
        control_project=compose_project,
        control_relative=_control_relative_from_guest(log_relative),
    )
    base = _validate_development_base(
        base_reference,
        expected_toolchain_id=toolchain_id,
        expected_context_sha256=context_sha256,
    )
    if base.get("toolchain_manifest_sha256") != toolchain_manifest_sha256:
        raise _fail("development base dependency manifest differs from the selected toolchain")
    base["context"] = context_info
    base["toolchain_build_reference"] = toolchain_reference
    base["built"] = True
    base["toolchain_manifest_sha256"] = toolchain_manifest_sha256
    _write_control_json(repo, compose_project,
                        _control_relative_from_guest(_control_record_path(
                            "development-base", compose_project, context_sha256
                        )), {
        "schema": DEVELOPMENT_IMAGE_SCHEMA,
        "kind": "development-base",
        "image_reference": base_reference,
        "image_id": base["image_id"],
        "base_image_id": toolchain_id,
        "toolchain_image_id": toolchain_id,
        "toolchain_manifest_sha256": toolchain_manifest_sha256,
        "toolchain_build_reference": toolchain_reference,
        "context_sha256": context_sha256,
        "context": context_info,
    })
    return base


def _select_source(repo: Path, source_root: Path | None) -> tuple[Path, dict[str, object]]:
    from docker_development_inputs import select_checkout
    from fullmag_storage import initialize, resolve_layout

    selected = select_checkout(repo, source_root).resolve(strict=True)
    if not selected.is_dir() or selected.is_symlink():
        raise _fail(f"selected source is not a real checkout: {selected}")
    layout = resolve_layout(selected, STORAGE_PROFILE)
    initialize(layout)
    return selected, layout


def _source_git_common_directory(selected: Path) -> Path:
    """Resolve only the Git common directory needed for the readonly bind.

    Source bytes and dirty state are intentionally not captured on the host.
    ``backend_dev start`` observes the mounted checkout inside its trusted
    container immediately before building.
    """

    from docker_backend_inputs import _git_common_directory

    try:
        return _git_common_directory(selected)
    except Exception as error:
        raise _fail(f"selected checkout Git common directory is unavailable: {error}") from error


def _compose_identity(layout: Mapping[str, object]) -> dict[str, str]:
    from docker_compose_identity import compose_project_identity

    return compose_project_identity(layout)


def _compose_identity_environment(layout: Mapping[str, object]) -> dict[str, str]:
    identity = _compose_identity(layout)
    return {
        "FULLMAG_COMPOSE_PROJECT": identity["project_name"],
        "FULLMAG_COMPOSE_NETWORK": identity["network_name"],
        "FULLMAG_SOURCE_PROJECT_ID": identity["project_id"],
        "FULLMAG_SOURCE_WORKTREE_ID": identity["worktree_id"],
        "FULLMAG_SOURCE_CHECKOUT_KIND": identity["checkout_kind"],
    }


def _workspace_state_root(layout: Mapping[str, object], project: str) -> Path:
    """Resolve the durable per-Compose user-data root through the runtime guard."""

    from fullmag_docker_runtime import _workspace_user_data_root

    return _workspace_user_data_root(layout, project)


def _backend_build_state_root(layout: Mapping[str, object], run_root: Path) -> Path:
    """Return the daemon path for backend build scratch state.

    The ``Path`` return type is retained for the existing environment builder;
    this path is never resolved or created on Windows. Compose maps it into the
    backend cache build volume.
    """

    del layout, run_root
    return Path("/build/.fullmag-build-state")


def _new_run_root(layout: Mapping[str, object]) -> tuple[str, Path]:
    from fullmag_storage import validate_path

    # This directory is only the small runtime handoff namespace. All build
    # contexts, compiler state, image metadata, logs and receipts live in
    # named Docker volumes; never allocate a run under ``storage/builds``.
    runtime_root = Path(str(layout["runs_root"]))
    storage_root = Path(str(layout["storage_root"]))
    run_id = uuid.uuid4().hex
    parent = validate_path(runtime_root / "docker-dev", storage_root, "direct Compose runtime root")
    parent.mkdir(parents=True, exist_ok=True)
    root = validate_path(parent / run_id, storage_root, "direct Compose runtime root")
    root.mkdir(mode=0o700)
    return run_id, root


def _direct_recreate_source_root(args: argparse.Namespace) -> Path:
    """Resolve the explicitly reused checkout without initializing storage."""

    source_value = getattr(args, "source_root", None)
    if source_value is None:
        receipt, _ = _read_json(Path(args.run_receipt), "Docker runtime run receipt")
        source_value = receipt.get("frontend_source_root") or receipt.get("source_root")
        if not isinstance(source_value, str) or not source_value:
            raise _fail("Direct development recreate requires the run receipt's source checkout")
    candidate = Path(source_value)
    if candidate.is_symlink():
        raise _fail("Direct development recreate source checkout must not be a reparse point")
    try:
        selected = candidate.resolve(strict=True)
    except OSError as error:
        raise _fail(f"Direct development recreate source checkout is unavailable: {candidate}") from error
    if not selected.is_dir() or selected.is_symlink():
        raise _fail("Direct development recreate source checkout is not a real directory")
    return selected


def _prepare_direct_recreate_backend_start(
    args: argparse.Namespace, repo: Path, *, device_access: str = "gpu",
    gpu_access_policy: str | None = None,
) -> tuple[Path, dict[str, object]]:
    """Validate the old run, then prepare a new live-source generation."""

    from fullmag_docker_runtime import _load_reuse_run, _select_reuse_compose_identity
    from fullmag_storage import resolve_layout

    selected = _direct_recreate_source_root(args)
    layout = resolve_layout(selected, STORAGE_PROFILE)
    reuse = _load_reuse_run(
        layout,
        args.run_receipt,
        project_name=None,
        frontend="dev",
        previous_config_sha256=args.previous_config_sha256,
    )
    if reuse is None or reuse.get("source_root") is None:
        raise _fail("Direct development recreate could not validate the named run")
    if Path(reuse["source_root"]).resolve() != selected:
        raise _fail("Direct development recreate source checkout differs from the reused run")
    source_identity = _compose_identity(layout)
    if reuse.get("project") == source_identity["project_name"]:
        receipt = reuse.get("receipt")
        if not isinstance(receipt, Mapping):
            raise _fail("Direct development recreate has no validated source identity receipt")
        for receipt_field, identity_field in (
            ("source_project_id", "project_id"),
            ("source_worktree_id", "worktree_id"),
            ("source_checkout_kind", "checkout_kind"),
        ):
            if receipt.get(receipt_field) != source_identity[identity_field]:
                raise _fail(
                    "Direct development recreate source identity differs from the reused run: "
                    + receipt_field
                )
    _select_reuse_compose_identity(
        source_identity, source_identity["project_name"], reuse
    )

    direct_args = argparse.Namespace(**vars(args))
    direct_args.source_root = selected
    with _direct_heavy_lock(layout):
        run_id, run_root = _new_run_root(layout)
        backend_start, _ = _backend_start_inputs(
            direct_args,
            run_root=run_root,
            run_id=run_id,
            heavy_lock_held=True,
            device_access=device_access,
            gpu_access_policy=gpu_access_policy,
        )
    return selected, backend_start


def _direct_compose_files(
    repo: Path,
    cache: Mapping[str, object] | None = None,
    *,
    source_mode: str = "archive",
) -> list[Path]:
    if source_mode not in {"archive", "live-shadow-v1"}:
        raise _fail(f"unsupported direct backend source mode: {source_mode}")
    backend_name = COMPOSE_LIVE_BUILD_FILE if source_mode == "live-shadow-v1" else COMPOSE_BUILD_FILE
    backend = repo / backend_name
    runtime = repo / COMPOSE_RUNTIME_FILE
    if backend.is_file() and runtime.is_file():
        # The versioned backend-build overlay is the direct topology.  It is
        # layered over the normal two-service development contract so the
        # builder and runtime share exactly one image/service definition.
        files = [runtime, backend]
    else:
        missing = [str(path) for path in (backend, runtime) if not path.is_file()]
        raise _fail("direct Compose definition is missing: " + ", ".join(missing))
    if cache is not None:
        overlay = cache.get("compose_overlay")
        if overlay is not None:
            raise _fail(
                "backend cache returned a host Compose overlay; named volumes must be declared "
                "by the selected Compose group"
            )
    return files


def _compose_prefix(repo: Path, files: Sequence[Path], project: str = DEFAULT_COMPOSE_PROJECT) -> list[str]:
    arguments: list[str] = [
        "compose", "--project-name", project, "--project-directory", str(repo),
    ]
    for path in files:
        arguments.extend(("-f", str(path)))
    return arguments


def _compose_config(repo: Path, files: Sequence[Path], environment: Mapping[str, str], *,
                    project: str = DEFAULT_COMPOSE_PROJECT) -> dict[str, object]:
    raw = _docker_capture(
        *_compose_prefix(repo, files, project), "config", "--format", "json",
        timeout=120, environment=environment,
    )
    value = _read_json_output(raw, "direct Compose config")
    if not isinstance(value, dict) or not isinstance(value.get("services"), dict):
        raise _fail("direct Compose config has no service map")
    services = value["services"]
    if "backend" not in services or not isinstance(services["backend"], dict):
        raise _fail("direct Compose config has no backend service")
    return value


def _service_tokens(service: Mapping[str, object]) -> list[str]:
    tokens: list[str] = []
    for key in ("entrypoint", "command"):
        value = service.get(key)
        if isinstance(value, str):
            tokens.append(value)
        elif isinstance(value, list):
            tokens.extend(str(item) for item in value)
    return tokens


def _mount_targets(service: Mapping[str, object]) -> set[str]:
    result: set[str] = set()
    volumes = service.get("volumes")
    if not isinstance(volumes, list):
        return result
    for volume in volumes:
        if isinstance(volume, dict) and isinstance(volume.get("target"), str):
            result.add(volume["target"])
        elif isinstance(volume, str):
            target = volume.rsplit(":", 1)[-1].split(":", 1)[0]
            if target.startswith("/"):
                result.add(target)
    return result


def _prepare_override(service: Mapping[str, object], source_mode: str = "archive") -> list[str]:
    tokens = _service_tokens(service)
    if source_mode == "live-shadow-v1":
        expected_tokens = {
            "prepare", "--manifest", "/input/manifest.json", "--source-root",
            "/opt/fullmag/source", "--git-common-root", "/opt/fullmag/source-git",
            "--output", "/opt/fullmag/package", "--build-root", "/build",
        }
        if expected_tokens.issubset(set(tokens)):
            # The live overlay owns the complete worker command.  Keep the
            # host override empty when Compose has resolved that contract.
            mounts = _mount_targets(service)
            if {"/input/manifest.json", "/opt/fullmag/source-git"}.issubset(mounts):
                return []
        return [
            "prepare",
            "--manifest", "/input/manifest.json",
            "--source-root", "/opt/fullmag/source",
            "--git-common-root", "/opt/fullmag/source-git",
            "--output", "/opt/fullmag/package",
            "--build-root", "/build",
        ]
    expected = {"/input/backend-source.tar", "/input/manifest.json"}
    output_targets = {"/output", "/opt/fullmag/package"}
    if "prepare" in tokens and expected.issubset(set(tokens)) and output_targets.intersection(tokens):
        # The versioned compose file owns the worker's positional contract.
        return []
    # docker/all-in-one/backend_dev.py is the current worker implementation.
    # Its flags are intentionally fixed here; callers cannot supply a shell
    # command or alter the CUDA/FEM feature set.
    return [
        "prepare",
        "--source-tar", "/input/backend-source.tar",
        "--manifest", "/input/manifest.json",
        "--output", "/opt/fullmag/package",
        "--build-root", "/build",
    ]


def _validate_runtime_image(reference: str, expected_toolchain_id: str,
                            layout: Mapping[str, object], expected_context_sha256: str | None,
                            expected_base_id: str,
                            expected_label_ids: Sequence[str] = (),
                            expected_backend_context_sha256: str | None = None,
                            expected_runtime_context_sha256: str | None = None,
                            require_receipt: bool = True) -> tuple[str, dict[str, object]]:
    image_id, document = _inspect_image(reference)
    labels = _image_labels(document)
    if labels.get("org.fullmag.runtime") != "docker-all-gpu-v1":
        raise _fail("development image is not a Fullmag all-in-Docker runtime")
    if labels.get("org.fullmag.development") != "source-bind-v1":
        raise _fail("development image is not the source-bind image")
    accepted_label_ids = {expected_toolchain_id}
    accepted_label_ids.update(
        value for value in expected_label_ids
        if isinstance(value, str) and IMAGE_ID_RE.fullmatch(value)
    )
    if labels.get("org.fullmag.toolchain.image-id") not in accepted_label_ids:
        raise _fail("development image toolchain label differs from the admitted base")
    if expected_context_sha256 is not None and labels.get(
            "org.fullmag.direct-development.base-context-sha256",
            labels.get("org.fullmag.direct-development.context-sha256"),
    ) != expected_context_sha256:
        raise _fail("development image base context label differs from the admitted base")
    if expected_backend_context_sha256 is not None and labels.get(
            "org.fullmag.direct-development.backend-context-sha256"
    ) != expected_backend_context_sha256:
        raise _fail("development image backend context label differs from the checkout")
    if expected_runtime_context_sha256 is not None and labels.get(
            "org.fullmag.direct-development.runtime-context-sha256"
    ) != expected_runtime_context_sha256:
        raise _fail("development image runtime context label differs from the checkout")
    _image_file(reference, "/opt/fullmag/backend_dev.py")
    _image_file(reference, "/opt/fullmag/backend_volume_cache_maintenance.py")
    if require_receipt and not labels.get("org.fullmag.direct-development.receipt-schema"):
        raise _fail("development image has no pinned direct-build label")
    return image_id, document


def _runtime_image_reference(args: argparse.Namespace, repo: Path,
                            environment: dict[str, str], run_root: Path,
                            layout: Mapping[str, object],
                            base_info: Mapping[str, object],
                            project: str = DEFAULT_COMPOSE_PROJECT) -> tuple[str, str, dict[str, object], bool]:
    requested = args.image or os.environ.get("FULLMAG_DEV_IMAGE")
    requested = requested or _stable_project_image_reference(project, "runtime")
    toolchain_id = str(base_info["toolchain_image_id"])
    base_id = str(base_info["image_id"])
    base_labels = base_info.get("labels")
    inherited_label = (
        base_labels.get("org.fullmag.toolchain.image-id")
        if isinstance(base_labels, Mapping) else None
    )
    expected_label_ids = (inherited_label,) if isinstance(inherited_label, str) else ()
    context_sha256 = base_info.get("context_sha256")
    context_sha256 = context_sha256 if isinstance(context_sha256, str) else None
    backend_context = _runtime_image_context(repo)
    backend_context_sha256 = str(backend_context["context_sha256"])
    runtime_context_identity = {
        "schema": RUNTIME_IMAGE_CONTEXT_SCHEMA,
        "base_context_sha256": context_sha256,
        "base_image_id": base_id,
        "backend_context_sha256": backend_context_sha256,
        "toolchain_image_id": toolchain_id,
    }
    runtime_context_sha256 = _sha256_bytes(_canonical_json(runtime_context_identity))
    if _image_reference_present(requested):
        try:
            image_id, document = _validate_runtime_image(
                requested, toolchain_id, layout, context_sha256, base_id,
                expected_label_ids,
                backend_context_sha256, runtime_context_sha256,
            )
        except DirectDockerOutcomeUnknown:
            raise
        except DirectDockerError:
            image_id = None
            document = None
        else:
            return requested, image_id, document, False
    image_reference = requested

    build_environment = dict(environment)
    build_environment.update(
        FULLMAG_DEV_IMAGE=image_reference,
        FULLMAG_RELEASE_IMAGE=image_reference,
        FULLMAG_TOOLCHAIN_IMAGE=toolchain_id,
        FULLMAG_TOOLCHAIN_IMAGE_ID=toolchain_id,
        FULLMAG_DEVELOPMENT_BASE_IMAGE=str(base_info["reference"]),
        FULLMAG_DIRECT_DEVELOPMENT_CONTEXT_SCHEMA=RUNTIME_IMAGE_CONTEXT_SCHEMA,
        FULLMAG_DIRECT_DEVELOPMENT_BASE_CONTEXT_SHA256=context_sha256 or "none",
        FULLMAG_DIRECT_DEVELOPMENT_BACKEND_CONTEXT_SHA256=backend_context_sha256,
        FULLMAG_DIRECT_DEVELOPMENT_RUNTIME_CONTEXT_SHA256=runtime_context_sha256,
        FULLMAG_DIRECT_DEVELOPMENT_RECEIPT_SCHEMA=DEVELOPMENT_IMAGE_SCHEMA,
        FULLMAG_BUILD_CONTROL_VOLUME=_control_volume_name(project),
    )
    log_relative = _control_record_path("runtime-image-build", project, runtime_context_sha256, ".log")
    _docker_live(
        None,
        *_compose_prefix(repo, [repo / COMPOSE_RUNTIME_FILE], project),
        "build", "--pull=false", "--progress=plain",
        "--build-arg", "FULLMAG_DIRECT_DEVELOPMENT_CONTEXT_SCHEMA=" + RUNTIME_IMAGE_CONTEXT_SCHEMA,
        "--build-arg", "FULLMAG_DIRECT_DEVELOPMENT_BASE_CONTEXT_SHA256=" + (context_sha256 or "none"),
        "--build-arg", "FULLMAG_DIRECT_DEVELOPMENT_BACKEND_CONTEXT_SHA256=" + backend_context_sha256,
        "--build-arg", "FULLMAG_DIRECT_DEVELOPMENT_RUNTIME_CONTEXT_SHA256=" + runtime_context_sha256,
        "--build-arg", "FULLMAG_DIRECT_DEVELOPMENT_RECEIPT_SCHEMA=" + DEVELOPMENT_IMAGE_SCHEMA,
        "backend",
        timeout=4 * 60 * 60,
        environment=build_environment,
        control_repo=repo,
        control_project=project,
        control_relative=_control_relative_from_guest(log_relative),
    )
    if _runtime_image_context(repo) != backend_context:
        raise _fail("backend image helpers changed while Docker was building; image retained without receipt")
    image_id, document = _validate_runtime_image(
        image_reference, toolchain_id, layout, context_sha256, base_id,
        expected_label_ids,
        backend_context_sha256, runtime_context_sha256,
        require_receipt=True,
    )
    _preflight_dependency_image(image_id)
    metadata = {
        "schema": DEVELOPMENT_IMAGE_SCHEMA,
        "kind": "development-runtime",
        "image_reference": image_reference,
        "image_id": image_id,
        "base_image_id": base_id,
        "toolchain_image_id": toolchain_id,
        "toolchain_manifest_sha256": base_info.get("toolchain_manifest_sha256"),
        "context_sha256": context_sha256,
        "context": base_info.get("context"),
        "backend_context_schema": RUNTIME_IMAGE_CONTEXT_SCHEMA,
        "backend_context_sha256": backend_context_sha256,
        "backend_context": backend_context,
        "runtime_context_sha256": runtime_context_sha256,
        "runtime_context_identity": runtime_context_identity,
    }
    _write_control_json(
        repo,
        project,
        _control_relative_from_guest(_control_record_path(
            "runtime-image", project, runtime_context_sha256
        )),
        metadata,
    )
    return image_reference, image_id, document, True


def _prepare_backend_cache(layout: Mapping[str, object], repo: Path, image_id: str,
                           run_root: Path, selected: Path, toolchain_id: str) -> dict[str, object]:
    """Prepare the v2 Docker-VM named-volume pair and its fixed helper.

    The legacy loop-image adapter remains available to its existing callers.
    Direct Docker development uses this separate v2 identity, so a new cache
    pair is created beside (and never migrates or deletes) any v1 cache.
    """

    from docker_backend_volume_cache import (
        BackendVolumeCacheError,
        VolumeNotFound,
        prepare_ready,
    )

    def volume_docker(*arguments: object) -> str:
        try:
            return _docker_capture(*arguments)
        except DirectDockerError as error:
            # ``ensure_volume_pair`` needs a typed absence so a missing pair
            # can be created while every other inspect failure remains fatal.
            if (len(arguments) >= 3
                    and arguments[0] == "volume"
                    and arguments[1] == "inspect"
                    and any(
                        marker in str(error).lower()
                        for marker in ("no such volume", "volume not found")
                    )):
                raise VolumeNotFound(str(error)) from error
            raise

    project = str(_compose_identity(layout)["project_name"])
    control_volume = _control_volume_name(project)

    def running_consumers() -> tuple[Mapping[str, object], ...]:
        raw_ids = _docker_capture("ps", "--quiet", "--no-trunc", timeout=60)
        ids = tuple(line.strip() for line in raw_ids.splitlines() if line.strip())
        if not ids:
            return ()
        inspected = _read_json_output(
            _docker_capture("inspect", *ids, timeout=60),
            "running Docker cache-consumer inventory",
        )
        if not isinstance(inspected, list):
            raise _fail("running Docker cache-consumer inventory is not a list")
        consumers: list[Mapping[str, object]] = []
        for document in inspected:
            if not isinstance(document, Mapping):
                raise _fail("running Docker cache-consumer inventory is malformed")
            state = document.get("State")
            if not isinstance(state, Mapping) or state.get("Running") is not True:
                raise _fail("Docker cache-consumer inventory changed during inspection")
            consumers.append(document)
        return tuple(consumers)

    def maintenance(profile: Mapping[str, object], overlay: Mapping[str, object]) -> Mapping[str, object]:
        cache_environment = profile.get("environment")
        services = overlay.get("services")
        service = services.get("backend-cache-volume-maintenance") if isinstance(services, Mapping) else None
        service_environment = service.get("environment") if isinstance(service, Mapping) else None
        if not isinstance(cache_environment, Mapping) or not isinstance(service_environment, Mapping):
            raise _fail("backend cache did not return canonical runtime and maintenance environments")
        maintenance_environment = {
            **_compose_identity_environment(layout),
            **{str(key): str(value) for key, value in cache_environment.items()},
            **{str(key): str(value) for key, value in service_environment.items()},
            "FULLMAG_BUILD_CONTROL_VOLUME": control_volume,
            "FULLMAG_BACKEND_CACHE_CONTROL_VOLUME": control_volume,
        }
        output = _docker_capture(
            *_compose_prefix(repo, [repo / COMPOSE_RUNTIME_FILE], project),
            "run", "--rm", "--no-deps", "backend-cache-volume-maintenance",
            timeout=180, environment=maintenance_environment,
        )
        value = _read_json_output(output, "backend cache maintenance receipt")
        if not isinstance(value, dict):
            raise _fail("backend cache maintenance returned no JSON receipt")
        return value

    try:
        profile = prepare_ready(
            layout,
            repo,
            image_id,
            run_root,
            volume_docker,
            maintenance,
            source_root=selected,
            toolchain_image=toolchain_id,
            control_volume_name=control_volume,
            active_consumers=running_consumers,
        )
    except BackendVolumeCacheError as error:
        raise _fail(f"backend named-volume cache was not admitted: {error}") from error
    if not isinstance(profile, Mapping) or profile.get("state") != "ready":
        raise _fail("backend named-volume cache did not reach ready state")

    result = dict(profile)
    # The selected Compose file contains the named-volume declarations. Keep
    # the canonical in-memory profile for consumers, but never materialize an
    # overlay YAML on Windows storage.
    result["compose_overlay"] = None
    result["compose_overlay_sha256"] = None
    result["maintenance_compose_overlay"] = None
    result["control_volume_name"] = control_volume
    return result


def _backend_cache_package_root(cache: Mapping[str, object]) -> PurePosixPath:
    """Return the helper-attested daemon package target for the backend.

    The v2 helper owns a named-volume pair and creates both volumes with the
    container UID before Compose is evaluated.  Native Windows Python must
    pass the daemon path through unchanged; deriving a sibling under the run
    root would silently switch the package back to Windows storage.
    """

    package_value = cache.get("package_root")
    mount_value = cache.get("mount_root")
    environment = cache.get("environment")
    if not isinstance(package_value, str):
        raise _fail("backend cache did not return an absolute package_root")
    if not isinstance(mount_value, str):
        raise _fail("backend cache did not return an absolute mount_root")
    try:
        package = PurePosixPath(package_value)
        mount = PurePosixPath(mount_value)
    except (TypeError, ValueError) as error:
        raise _fail("backend cache paths are malformed") from error
    if (not package.is_absolute() or not mount.is_absolute()
            or any(part in {"", ".", ".."} for part in package.parts[1:])
            or any(part in {"", ".", ".."} for part in mount.parts[1:])):
        raise _fail("backend cache did not return safe absolute daemon paths")
    if not isinstance(environment, Mapping):
        raise _fail("backend cache did not return its resolved environment")
    if environment.get("FULLMAG_BACKEND_PACKAGE") != package_value:
        raise _fail("backend cache package environment differs from package_root")
    # v2 deliberately uses two daemon named volumes: the Cargo/build volume
    # is mounted at /build and the runtime package volume at /opt/fullmag/package.
    # They are a pair, not a host-visible ``/build/package`` subtree.  Keep the
    # exact paths here so a Windows path cannot be silently reinterpreted.
    if package != PurePosixPath("/opt/fullmag/package"):
        raise _fail("backend cache package_root is not the v2 daemon package target")
    if mount != PurePosixPath("/build"):
        raise _fail("backend cache mount_root is not the v2 daemon build target")
    return package


def _environment(layout: Mapping[str, object], selected: Path, run_root: Path,
                 source_bundle: Mapping[str, object], package: str | PurePosixPath,
                 image_ref: str,
                 image_id: str, toolchain_id: str, cache: Mapping[str, object],
                 base_reference: str, cargo_profile: str,
                 device_access: str = "gpu") -> dict[str, str]:
    if device_access not in DEVICE_ACCESS_CHOICES:
        raise _fail("resolved device access must be cpu or gpu")
    cargo_profile = _validate_cargo_profile(cargo_profile)
    manifest_value = source_bundle.get("manifest_path")
    manifest = Path(str(manifest_value)) if manifest_value is not None else None
    source_mode = str(source_bundle.get("source_mode", "archive"))
    if source_mode not in {"archive", "commit", "snapshot", "live-shadow-v1"}:
        raise _fail(f"unsupported backend source mode: {source_mode}")
    if source_mode != "live-shadow-v1":
        raise _fail("volume-only Docker development requires the live source mode")
    state = run_root / "state"
    state.mkdir(exist_ok=True)
    (run_root / "host-certificate.json").touch(exist_ok=True)
    compose_project = _compose_identity(layout)["project_name"]
    workspace_state_root = _workspace_state_root(layout, compose_project)
    build_state_root = _backend_build_state_root(layout, run_root)
    control_root = _bootstrap_module().CONTROL_ROOT
    provenance_path = f"{control_root}/backend/runtime-provenance.json"
    development_inputs_path = f"{control_root}/frontend/development-inputs.json"
    environment = {
        **_compose_identity_environment(layout),
        "FULLMAG_DEV_IMAGE": image_ref,
        "FULLMAG_RELEASE_IMAGE": image_ref,
        "FULLMAG_RUNTIME_IMAGE_ID": image_id,
        "FULLMAG_TOOLCHAIN_IMAGE": toolchain_id,
        "FULLMAG_TOOLCHAIN_IMAGE_ID": toolchain_id,
        "FULLMAG_BACKEND_CARGO_PROFILE": cargo_profile,
        "FULLMAG_DOCKER_DEVICE_ACCESS": device_access,
        "FULLMAG_SOURCE_ROOT": str(selected),
        "FULLMAG_BACKEND_PACKAGE": str(package),
        "FULLMAG_DEVELOPMENT_BASE_IMAGE": base_reference,
        "FULLMAG_STATE_ROOT": str(state),
        "FULLMAG_HOST_CERTIFICATE": str(run_root / "host-certificate.json"),
        "FULLMAG_PACKAGE_PROVENANCE": provenance_path,
        "FULLMAG_RUNTIME_PROVENANCE": provenance_path,
        "FULLMAG_DEVELOPMENT_INPUTS": development_inputs_path,
        "FULLMAG_DEVELOPMENT_INPUTS_PATH": development_inputs_path,
        "FULLMAG_BACKEND_HOSTNAME": "fullmag-direct-backend-" + run_root.name[:12],
        "FULLMAG_PROJECT_STORAGE_ROOT": str(layout["storage_root"]),
        "FULLMAG_BUILD_ROOT": "/build",
        "FULLMAG_CACHE_ROOT": "/build/cache",
        "FULLMAG_TEMP_ROOT": "/build/tmp",
        "FULLMAG_RUNTIME_ROOT": "/opt/fullmag/package",
        "FULLMAG_WORKSPACE_STATE_ROOT": str(workspace_state_root),
        "FULLMAG_BACKEND_BUILD_STATE_ROOT": str(build_state_root),
        "FULLMAG_CARGO_TARGET_DIR": "/build/workspace/.fullmag-build/cargo-targets/direct",
        "FULLMAG_CARGO_TARGET_ROOT": "/build/workspace/.fullmag-build/cargo-targets",
        "CARGO_TARGET_DIR": "/build/workspace/.fullmag-build/cargo-targets/direct",
    }
    cache_environment = cache.get("environment")
    if isinstance(cache_environment, Mapping):
        environment.update({str(key): str(value) for key, value in cache_environment.items()})
    # Keep the source/package identities after the helper environment so the
    # backend-build overlay cannot accidentally inherit a stale host setting.
    environment.update({
        "FULLMAG_BACKEND_PACKAGE": str(package),
        "FULLMAG_SOURCE_ROOT": str(selected),
        "FULLMAG_RUNTIME_IMAGE_ID": image_id,
        "FULLMAG_TOOLCHAIN_IMAGE_ID": toolchain_id,
        "FULLMAG_BACKEND_CARGO_PROFILE": cargo_profile,
        "FULLMAG_DOCKER_DEVICE_ACCESS": device_access,
        # Reassert the validated roots after cache overlay interpolation so a
        # stale helper environment cannot redirect the build into history.
        "FULLMAG_WORKSPACE_STATE_ROOT": str(workspace_state_root),
        "FULLMAG_BACKEND_BUILD_STATE_ROOT": str(build_state_root),
    })
    if manifest is not None:
        environment["FULLMAG_BACKEND_SOURCE_MANIFEST"] = str(manifest)
    git_common = source_bundle.get("git_common_dir")
    if not isinstance(git_common, str) or not git_common:
        raise _fail("live backend source bundle has no Git common directory")
    environment["FULLMAG_SOURCE_GIT_COMMON"] = git_common
    source_commit = source_bundle.get("source_commit")
    if isinstance(source_commit, str) and COMMIT_RE.fullmatch(source_commit):
        environment["FULLMAG_SOURCE_COMMIT"] = source_commit
    return environment


def _validate_prepare_receipt(package: Path, source_bundle: Mapping[str, object],
                              toolchain_id: str,
                              expected_cargo_profile: str) -> tuple[dict[str, object], bytes]:
    receipt_path = package / "backend-build-receipt.json"
    receipt, raw = _read_json(receipt_path, "backend build receipt")
    if receipt.get("schema") != "fullmag.direct-compose.backend-build-receipt.v1":
        raise _fail("backend worker returned an unsupported build receipt schema")
    if receipt.get("state") != "succeeded" or receipt.get("operation") != "direct-compose-build":
        raise _fail("backend worker did not publish a successful direct build receipt")
    expected_cargo_profile = _validate_cargo_profile(expected_cargo_profile)
    build = receipt.get("build")
    if (not isinstance(build, dict)
            or build.get("cargo_profile") != expected_cargo_profile
            or build.get("cargo_target_profile_dir") != expected_cargo_profile):
        raise _fail(
            f"backend build receipt is not a {expected_cargo_profile} cargo profile build"
        )
    source = receipt.get("source")
    if not isinstance(source, dict):
        raise _fail("backend build receipt has no source identity")
    source_mode = str(source_bundle.get("source_mode", "archive"))
    expected_mode = "live-shadow-v1" if source_mode == "live-shadow-v1" else "archive"
    if source.get("source_mode") != expected_mode:
        raise _fail("backend build receipt source mode differs")
    expected_fields = [
        ("source_digest", source_bundle.get("source_digest")),
        ("resolved_commit", source_bundle.get("resolved_commit")),
        ("source_snapshot_sha256", source_bundle.get("source_snapshot_sha256")),
    ]
    if expected_mode == "live-shadow-v1":
        expected_fields.append(("live_manifest_sha256", source_bundle.get("live_manifest_sha256")))
    else:
        expected_fields.append(("source_tar_sha256", source_bundle.get("archive_sha256")))
    for key, expected in expected_fields:
        if source.get(key) != expected:
            raise _fail(f"backend build receipt source identity differs: {key}")
    native = receipt.get("native_source_identity")
    if native != source_bundle.get("native_source_identity"):
        raise _fail("backend build receipt native source identity differs from the source bundle")
    toolchain = receipt.get("toolchain")
    if not isinstance(toolchain, dict) or toolchain.get("image_id") != toolchain_id:
        raise _fail("backend build receipt toolchain image identity differs")
    lanes = receipt.get("execution_lanes")
    if not isinstance(lanes, dict) or set(lanes) != set(REQUIRED_LANES):
        raise _fail("backend build receipt does not attest all four execution lanes")
    if any(not isinstance(lanes[lane], dict) or lanes[lane].get("status") != "compiled"
           for lane in REQUIRED_LANES):
        raise _fail("backend build receipt has an incomplete execution lane")
    return receipt, raw


def _assembly(layout: Mapping[str, object], run_id: str, run_root: Path,
              selected: Path, source_bundle: Mapping[str, object], package: Path,
              image_id: str, toolchain_id: str, prepare_receipt: Mapping[str, object],
              prepare_receipt_bytes: bytes, base_info: Mapping[str, object],
              build_profile: str, expected_cargo_profile: str) -> Path:
    expected_cargo_profile = _validate_cargo_profile(expected_cargo_profile)
    if _cargo_profile_for_build(build_profile) != expected_cargo_profile:
        raise _fail("assembly build profile does not match its Cargo profile")
    from fullmag_docker_runtime import REQUIRED_BINARIES
    from fullmag_storage import atomic_json, validate_path

    # Startup helpers are already owned by the immutable runtime image. Keep
    # only their hashes in provenance; copying them to host staging would
    # recreate technical build data outside Docker.
    context = "image-owned:/opt/fullmag"
    helper_hashes = _image_helper_inventory(image_id)
    observed_image_id, runtime_document = _inspect_image(image_id)
    if observed_image_id != image_id:
        raise _fail("runtime image changed while assembling provenance")
    runtime_labels = _image_labels(runtime_document)
    binary_hashes: dict[str, str] = {}
    for name in REQUIRED_BINARIES:
        binary_hashes[name] = _sha256_file(package / "bin" / name, f"backend binary {name}")
    if not (package / "_fullmag_core.so").is_file():
        raise _fail("backend package has no _fullmag_core.so")
    source_commit = str(source_bundle.get("resolved_commit", ""))
    if not COMMIT_RE.fullmatch(source_commit):
        raise _fail("direct source archive has no canonical commit")
    build_receipt = package / "backend-build-receipt.json"
    if _sha256_bytes(prepare_receipt_bytes) != _sha256_file(build_receipt, "backend build receipt"):
        raise _fail("backend build receipt changed while assembling provenance")
    build = prepare_receipt.get("build")
    if (not isinstance(build, dict)
            or build.get("cargo_profile") != expected_cargo_profile
            or build.get("cargo_target_profile_dir") != expected_cargo_profile):
        raise _fail("backend build receipt profile changed while assembling provenance")
    source_mode = str(source_bundle.get("source_mode", "snapshot"))
    assembly = {
        "schema": "fullmag.docker-all-image.v1",
        "state": "succeeded",
        "exit_code": 0,
        "qualification": "NOT VERIFIED",
        "build_kind": "direct-compose",
        "direct_source_provenance": (
            "fullmag.docker-backend-live-source.v1"
            if source_mode == "live-shadow-v1"
            else "fullmag.docker-backend-source.v1"
        ),
        "direct_build_id": run_id,
        "commit": source_commit,
        "source_mode": source_mode,
        "source_root": str(selected),
        "source_digest": str(source_bundle["source_digest"]),
        "source_snapshot_sha256": str(source_bundle["source_snapshot_sha256"]),
        "native_source_identity": source_bundle["native_source_identity"],
        "source_manifest": str(source_bundle["manifest_path"]),
        # Keep the final runtime image separate from the immutable toolchain
        # base.  The runtime launcher consumes image_id; base_image is the
        # provenance identity passed as the toolchain image to Compose.
        "image_id": image_id,
        "base_image": toolchain_id,
        "toolchain_image_id": toolchain_id,
        "development_base_image": base_info.get("reference"),
        "development_base_image_id": base_info.get("image_id"),
        "development_base_build_reference": base_info.get("toolchain_build_reference"),
        "toolchain_manifest_sha256": base_info.get("toolchain_manifest_sha256"),
        "development_base_context_sha256": base_info.get("context_sha256"),
        "development_base_context": base_info.get("context"),
        "development_base_labels": base_info.get("labels", {}),
        "runtime_image_labels": runtime_labels,
        "runtime_mode": "development_source_bind",
        "build_profile": build_profile,
        "cargo_profile": build["cargo_profile"],
        "cargo_target_profile_dir": build["cargo_target_profile_dir"],
        "package_root": str(validate_path(package, Path(str(layout["build_storage_root"])), "backend package")),
        "binary_hashes": binary_hashes,
        "startup_helper_hashes": helper_hashes,
        "build_receipt_sha256": _sha256_bytes(prepare_receipt_bytes),
        "backend_build_receipt": str(build_receipt),
        "backend_build_receipt_schema": prepare_receipt.get("schema"),
        "output": str(run_root),
        "context": context,
    }
    if source_mode == "live-shadow-v1":
        assembly["live_manifest_sha256"] = str(source_bundle["live_manifest_sha256"])
        assembly["source_git_common_dir"] = str(source_bundle["git_common_dir"])
    else:
        assembly["source_archive"] = {
            "path": str(source_bundle["archive_path"]),
            "manifest_path": str(source_bundle["manifest_path"]),
            "sha256": str(source_bundle["archive_sha256"]),
            "bytes": source_bundle["archive_bytes"],
        }
    receipt_path = validate_path(run_root / "assembly.json", Path(str(layout["build_storage_root"])), "direct assembly receipt")
    atomic_json(receipt_path, assembly)
    # The runtime binds this exact receipt as /opt/fullmag/provenance.json.
    _write_json(run_root / "provenance.json", assembly)
    return receipt_path


def _compose_stop_hint(container_ids: Sequence[str]) -> str:
    """Return a stop command for the exact Compose file that owns the run."""

    try:
        documents = _read_json_output(
            _docker_capture("inspect", *container_ids, timeout=60),
            "running Fullmag container inspection",
        )
    except DirectDockerError:
        documents = None
    if isinstance(documents, list) and documents:
        configs: tuple[str, ...] | None = None
        working_dir: str | None = None
        compose_project: str | None = None
        valid = True
        for document in documents:
            if not isinstance(document, dict):
                valid = False
                break
            config = document.get("Config")
            labels = config.get("Labels") if isinstance(config, dict) else None
            if not isinstance(labels, dict):
                valid = False
                break
            raw_files = labels.get("com.docker.compose.project.config_files")
            raw_working = labels.get("com.docker.compose.project.working_dir")
            raw_project = labels.get("com.docker.compose.project")
            if (not isinstance(raw_files, str) or not raw_files.strip()
                    or not isinstance(raw_working, str)
                    or not isinstance(raw_project, str)
                    or not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", raw_project)):
                valid = False
                break
            # Compose records multiple files as a platform-separated or
            # comma-separated label.  The runtime launcher records its fully
            # resolved compose.json here, so this command needs no shell env.
            files = tuple(item for item in re.split(r"[;,]", raw_files) if item)
            if not files:
                valid = False
                break
            if configs is None:
                configs = files
                working_dir = raw_working
                compose_project = raw_project
            elif configs != files or working_dir != raw_working or compose_project != raw_project:
                valid = False
                break
        if (valid and configs and working_dir and compose_project
                and all(Path(compose_file).suffix.lower() == ".json" for compose_file in configs)):
            parts = [
                "docker", "compose", "--project-name", compose_project,
                "--project-directory", working_dir,
            ]
            for compose_file in configs:
                parts.extend(("-f", compose_file))
            parts.append("down")
            return " ".join(f'"{part}"' if any(character.isspace() for character in part) else part
                            for part in parts)
    # If a foreign/manual container has no trustworthy Compose provenance,
    # stopping only the inspected IDs remains an exact, bounded operation.
    return "docker stop " + " ".join(container_ids)


def _assert_no_running_fullmag(project: str, source_identity: Mapping[str, object]) -> None:
    """Reject all stale containers/networks for the selected Compose group.

    The historical helper name is retained for callers, but the admission
    fence covers stopped containers and orphaned project networks as well as
    running services.  Compose must never silently replace an old identity.
    """

    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", project):
        raise _fail("Invalid Compose project name")
    from docker_compose_identity import compose_network_name, source_labels

    if not isinstance(source_identity, Mapping):
        raise _fail("Resolved Compose source identity is required for network admission")
    if source_identity.get("project_name") != project:
        raise _fail("Compose source identity does not match the selected project")
    network_name = source_identity.get("network_name")
    if (not isinstance(network_name, str)
            or network_name != compose_network_name(project)):
        raise _fail("Compose source identity has an invalid network name")
    try:
        expected_labels = source_labels(source_identity)
    except (TypeError, ValueError) as error:
        raise _fail(f"Compose source identity labels are invalid: {error}") from error

    container_ids: set[str] = set()
    for label in ("com.docker.compose.project", "org.fullmag.compose.project"):
        raw = _docker_capture(
            "ps", "--all", "--quiet", "--filter", "label=" + label + "=" + project,
            timeout=60,
        )
        container_ids.update(line.strip() for line in raw.splitlines() if line.strip())
    if container_ids:
        ordered = sorted(container_ids)
        raise _fail(
            "Fullmag Docker containers already exist for project " + project
            + " (running or stopped): " + ", ".join(ordered)
            + "; remove them explicitly with the recorded command: `"
            + _compose_stop_hint(ordered)
            + "` before `up`"
        )

    network_ids: set[str] = set()
    network_filters = (
        "label=com.docker.compose.project=" + project,
        "label=org.fullmag.compose.project=" + project,
        # Catch a stale/manual network with the deterministic Compose name even
        # if someone stripped its labels; Compose must not replace it silently.
        "name=^" + network_name + "$",
    )
    for network_filter in network_filters:
        raw = _docker_capture(
            "network", "ls", "--quiet", "--filter", network_filter,
            timeout=60,
        )
        network_ids.update(line.strip() for line in raw.splitlines() if line.strip())
    if not network_ids:
        return
    ordered_networks = sorted(network_ids)
    try:
        documents = _read_json_output(
            _docker_capture("network", "inspect", *ordered_networks, timeout=60),
            "Fullmag Compose network inspection",
        )
    except DirectDockerError:
        raise
    if not isinstance(documents, list) or len(documents) != len(ordered_networks):
        raise _fail("Docker network identity inspection returned an incomplete document")
    if len(documents) != 1:
        raise _fail("More than one Fullmag project network matches the selected source")
    names = []
    for document in documents:
        if not isinstance(document, dict):
            raise _fail("Docker network identity inspection returned an invalid document")
        if document.get("Name") != network_name:
            raise _fail("Fullmag network name differs from the selected source checkout")
        if document.get("Driver") != "bridge" or document.get("Scope") != "local":
            raise _fail("Fullmag network driver or scope differs from the selected Compose network")
        containers = document.get("Containers")
        if not isinstance(containers, dict) or containers:
            raise _fail("Fullmag project network has attached containers")
        labels = document.get("Labels")
        if not isinstance(labels, dict):
            raise _fail("Docker network identity labels could not be verified")
        if any(labels.get(key) != value for key, value in expected_labels.items()):
            raise _fail("Docker network source labels do not match the selected checkout")
        if (labels.get("com.docker.compose.project") != project
                or labels.get("com.docker.compose.network") != "fullmag"):
            raise _fail("Docker Compose network ownership labels could not be verified")
        names.append(str(document.get("Name") or document.get("Id") or "<unknown>"))
    # A build may legitimately leave this exact, empty Compose bridge behind.
    # It is safe to reuse only after every identity and ownership field above
    # has matched; any endpoint or foreign label failed closed earlier.
    if names:
        return


def _frozen_source_bundle(manifest_path: Path, layout: Mapping[str, object], selected: Path) -> dict[str, object]:
    """Explicitly resume immutable inputs; later checkout edits are not included."""
    from fullmag_storage import validate_path
    from windows_folder_host import read_owned_regular
    from docker_backend_inputs import (
        ARCHIVE_FILENAME, ARCHIVE_MANIFEST_SCHEMA, CAPTURE_ID_RE, MAX_ARCHIVE_BYTES,
        BackendInputError, _validate_source_manifest,
        _validate_native_identity, _canonical_bytes,
    )
    manifest = validate_path(Path(manifest_path), Path(str(layout["build_storage_root"])),
                             "frozen backend source manifest")
    try:
        def unique_object(pairs):
            value = {}
            for key, item in pairs:
                if key in value:
                    raise ValueError(f"duplicate frozen manifest key: {key}")
                value[key] = item
            return value
        value = json.loads(read_owned_regular(manifest, maximum=64 * 1024 * 1024),
                           object_pairs_hook=unique_object)
        required = {
            "schema", "capture_id", "source_mode", "source_root", "resolved_commit", "source_digest",
            "backend_source_sha256", "source_snapshot_sha256", "native_source_identity", "source_manifest",
            "source_manifest_sha256", "archive_filename", "archive_sha256", "archive_bytes", "created_at",
        }
        if (not isinstance(value, dict) or set(value) != required
                or value.get("schema") != ARCHIVE_MANIFEST_SCHEMA):
            raise ValueError("unsupported frozen source manifest")
        if (not isinstance(value["capture_id"], str)
                or not CAPTURE_ID_RE.fullmatch(value["capture_id"])
                or not isinstance(value["created_at"], str) or not value["created_at"]
                or not isinstance(value["source_root"], str) or not value["source_root"]
                or isinstance(value["archive_bytes"], bool)
                or not isinstance(value["archive_bytes"], int)
                or not 0 < value["archive_bytes"] <= MAX_ARCHIVE_BYTES
                or not isinstance(value["archive_sha256"], str)
                or not SHA256_RE.fullmatch(value["archive_sha256"])):
            raise ValueError("invalid frozen source manifest metadata")
        if Path(value["source_root"]).resolve(strict=True) != selected:
            raise ValueError("frozen source checkout differs from selected live checkout")
        source, _ = _validate_source_manifest(value["source_manifest"])
        _validate_native_identity(value["native_source_identity"], source["resolved_commit"])
        if (value.get("source_digest") != source["source_digest"]
                or value.get("backend_source_sha256") != source["source_digest"]
                or value.get("source_mode") != source["source_mode"]
                or value.get("source_snapshot_sha256") != value["native_source_identity"]["source_snapshot_sha256"]
                or value.get("resolved_commit") != source["resolved_commit"]
                or value.get("source_manifest_sha256") != _sha256_bytes(_canonical_bytes(source))
                or value.get("archive_filename") != ARCHIVE_FILENAME):
            raise ValueError("frozen source manifest identity differs")
        archive = validate_path(manifest.parent / ARCHIVE_FILENAME,
                                Path(str(layout["build_storage_root"])), "frozen backend source archive")
        if (archive.stat().st_size != value.get("archive_bytes")
                or _sha256_file(archive, "frozen source archive") != value.get("archive_sha256")):
            raise ValueError("frozen source archive differs from its manifest")
        return {**value, "archive_path": str(archive), "manifest_path": str(manifest)}
    except (OSError, ValueError, KeyError, TypeError, BackendInputError) as error:
        raise _fail(f"Cannot resume frozen backend inputs: {error}") from error


def _publish_backend_start_manifest(source_manifest: Path, destination: Path) -> str:
    """Publish the mutable run-owned manifest mount used by backend start.

    The capture remains immutable evidence under the build storage root.  A
    stable run-owned copy is mounted by Compose so a controlled backend restart
    can publish a new observation after the old service has drained without
    changing the container's mount target or command.  Once the single-file
    bind mount exists, update its inode in place: ``os.replace`` would leave a
    running Linux container attached to the old inode.
    """

    if source_manifest.is_symlink() or not source_manifest.is_file():
        raise _fail(f"backend source manifest is not a regular file: {source_manifest}")
    data = source_manifest.read_bytes()
    if not data or len(data) > 64 * 1024 * 1024:
        raise _fail("backend source manifest is empty or oversized")
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() or destination.is_symlink():
        if destination.is_symlink() or not destination.is_file():
            raise _fail(f"published backend source manifest is not a regular file: {destination}")
        try:
            # The run-owned copy is read-only between observations.  Relax
            # only this file for the bounded writer, then restore the mode
            # before the next Compose publication.
            try:
                destination.chmod(0o600)
            except OSError:
                pass
            try:
                with destination.open("r+b") as stream:
                    stream.seek(0)
                    stream.truncate(0)
                    stream.write(data)
                    stream.flush()
                    os.fsync(stream.fileno())
            finally:
                try:
                    destination.chmod(0o444)
                except OSError:
                    pass
        except OSError as error:
            raise _fail(f"cannot update published backend source manifest in place: {error}") from error
    else:
        temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.tmp")
        try:
            temporary.write_bytes(data)
            try:
                temporary.chmod(0o444)
            except OSError:
                pass
            os.replace(temporary, destination)
        finally:
            if temporary.exists():
                temporary.unlink()
    if _sha256_file(destination, "published backend source manifest") != _sha256_bytes(data):
        raise _fail("published backend source manifest changed during publication")
    return str(destination)


def _backend_start_inputs(
    args: argparse.Namespace,
    *,
    run_root: Path | None = None,
    run_id: str | None = None,
    heavy_lock_held: bool = False,
    device_access: str = "gpu",
    gpu_access_policy: str | None = None,
) -> tuple[dict[str, object], Path]:
    """Prepare only the inputs for the fixed backend service.

    This phase may build/admit the Docker runtime image and prepare its
    persistent cache, but it never invokes a backend one-shot container or
    captures source bytes.  The backend service receives only readonly source
    and Git binds and performs the fresh source observation/package build in
    its own long-lived container via ``backend_dev start``.
    """

    _require_native_windows()
    if device_access not in DEVICE_ACCESS_CHOICES:
        raise _fail("resolved device access must be cpu or gpu")
    build_profile = getattr(args, "profile", DEFAULT_BUILD_PROFILE)
    if build_profile != DEFAULT_BUILD_PROFILE:
        raise _fail(
            "docker-dev uses the backend-dev profile; release packages use the managed image route"
        )
    if getattr(args, "source_manifest", None) is not None:
        raise _fail(
            "--source-manifest is unsupported by docker-dev's live source service; "
            "use the managed frozen-input route for an immutable source manifest"
        )
    if getattr(args, "include_untracked", None):
        raise _fail(
            "--include-untracked is unsupported by docker-dev's live source service; "
            "add new source files to the selected Git index before starting the service"
        )
    cargo_profile = _cargo_profile_for_build(build_profile)
    repo = Path(args.repo_root).resolve(strict=True)
    selected, layout = _select_source(repo, getattr(args, "source_root", None))
    compose_identity = _compose_identity(layout)
    compose_project = compose_identity["project_name"]
    control_volume = _control_volume_name(compose_project)
    control_root = _bootstrap_module().CONTROL_ROOT
    if run_root is None:
        resolved_run_id, resolved_root = _new_run_root(layout)
    else:
        resolved_root = Path(run_root).resolve()
        if not resolved_root.is_absolute() or resolved_root.is_symlink() or not resolved_root.is_dir():
            raise _fail("controlled backend restart requires an existing real run root")
        resolved_run_id = run_id or resolved_root.name
    if not isinstance(resolved_run_id, str) or re.fullmatch(r"[0-9a-f]{32}", resolved_run_id) is None:
        raise _fail("direct backend run ID is not a canonical 32-character value")

    terminal = {
        "schema": "fullmag.direct-compose-backend-start.v1",
        "state": "preparing",
        "run_id": resolved_run_id,
        "source_root": str(selected),
        "run_root": str(resolved_root),
        "queue": "not-used",
        "build_profile": build_profile,
        "cargo_profile": cargo_profile,
        "compose_project": compose_project,
    }
    terminal_relative = f"{CONTROL_NAMESPACE}/backend-start/{resolved_run_id}.json"
    terminal_path = _control_guest_path(terminal_relative)
    _write_control_json(selected, compose_project, terminal_relative, terminal)

    if heavy_lock_held:
        lock_context = nullcontext()
    else:
        from fullmag_storage import file_lock, validate_path

        storage_root = Path(str(layout["storage_root"]))
        heavy_lock = validate_path(
            storage_root / "locks" / "fullmag-heavy.lock",
            storage_root,
            "direct Docker backend start lock",
        )
        lock_context = file_lock(
            heavy_lock,
            "direct Docker backend start preparation",
            wait_timeout_seconds=120,
        )
    try:
        lock_context.__enter__()
        workspace_state_root = _workspace_state_root(layout, compose_project)
        build_state_root = _backend_build_state_root(layout, resolved_root)
        # Resolve the Git common directory before any runtime image build or
        # Compose interpolation.  The image build context validates this
        # source bind before the long-lived backend service starts.
        git_common = _source_git_common_directory(selected)
        placeholder_environment = {
            **_compose_identity_environment(layout),
            "FULLMAG_DEV_IMAGE": getattr(args, "image", None)
            or os.environ.get("FULLMAG_DEV_IMAGE")
            or _stable_project_image_reference(compose_project, "runtime"),
            "FULLMAG_RELEASE_IMAGE": getattr(args, "image", None)
            or os.environ.get("FULLMAG_DEV_IMAGE")
            or _stable_project_image_reference(compose_project, "runtime"),
            "FULLMAG_TOOLCHAIN_IMAGE": getattr(args, "toolchain_image", None)
            or os.environ.get("FULLMAG_TOOLCHAIN_IMAGE")
            or _toolchain_image_reference(compose_project),
            "FULLMAG_TOOLCHAIN_IMAGE_ID": getattr(args, "toolchain_image", None)
            or os.environ.get("FULLMAG_TOOLCHAIN_IMAGE_ID", "pending"),
            "FULLMAG_BACKEND_CARGO_PROFILE": cargo_profile,
            "FULLMAG_DOCKER_DEVICE_ACCESS": device_access,
            "FULLMAG_DEVELOPMENT_BASE_IMAGE": os.environ.get(
                "FULLMAG_DEVELOPMENT_BASE_IMAGE",
                _stable_project_image_reference(compose_project, "base"),
            ),
            "FULLMAG_SOURCE_ROOT": str(selected),
            "FULLMAG_SOURCE_GIT_COMMON": str(git_common),
            "FULLMAG_BACKEND_PACKAGE": "/opt/fullmag/package",
            "FULLMAG_STATE_ROOT": str(resolved_root / "state"),
            "FULLMAG_WORKSPACE_STATE_ROOT": str(workspace_state_root),
            "FULLMAG_PROJECT_STORAGE_ROOT": str(layout["storage_root"]),
            "FULLMAG_BUILD_ROOT": "/build",
            "FULLMAG_CACHE_ROOT": "/build/cache",
            "FULLMAG_RUNTIME_ROOT": "/opt/fullmag/package",
            "FULLMAG_BACKEND_BUILD_STATE_ROOT": str(build_state_root),
            "FULLMAG_HOST_CERTIFICATE": str(resolved_root / "host-certificate.json"),
            "FULLMAG_PACKAGE_PROVENANCE": f"{control_root}/backend/runtime-provenance.json",
            "FULLMAG_RUNTIME_PROVENANCE": f"{control_root}/backend/runtime-provenance.json",
            "FULLMAG_DEVELOPMENT_INPUTS": f"{control_root}/frontend/development-inputs.json",
            "FULLMAG_DEVELOPMENT_INPUTS_PATH": f"{control_root}/frontend/development-inputs.json",
            "FULLMAG_BUILD_CONTROL_VOLUME": control_volume,
            "FULLMAG_BACKEND_HOSTNAME": "fullmag-direct-backend-" + resolved_run_id[:12],
        }

        base_info = _ensure_development_base(args, selected, layout, resolved_root)
        terminal.update(
            development_base_image=base_info["reference"],
            development_base_image_id=base_info["image_id"],
            toolchain_image_id=base_info["toolchain_image_id"],
            toolchain_manifest_sha256=base_info["toolchain_manifest_sha256"],
            development_base_context_sha256=base_info.get("context_sha256"),
        )
        _write_control_json(selected, compose_project, terminal_relative, terminal)
        placeholder_environment["FULLMAG_DEVELOPMENT_BASE_IMAGE"] = str(base_info["reference"])
        placeholder_environment["FULLMAG_TOOLCHAIN_IMAGE"] = str(base_info["toolchain_image_id"])
        placeholder_environment["FULLMAG_TOOLCHAIN_IMAGE_ID"] = str(base_info["toolchain_image_id"])
        image_ref, image_id, _image_document, image_built = _runtime_image_reference(
            args, selected, placeholder_environment, resolved_root, layout, base_info,
            compose_project,
        )
        toolchain_id = str(base_info["toolchain_image_id"])
        helper_hashes = _image_helper_inventory(image_id)
        helper_relative = f"{CONTROL_NAMESPACE}/backend-start/{resolved_run_id}-helpers.json"
        helper_context = _control_guest_path(helper_relative)
        _write_control_json(selected, compose_project, helper_relative, {
            "schema": "fullmag.docker-dev.startup-helper-inventory.v1",
            "image_id": image_id,
            "helpers": helper_hashes,
        })
        device_access = _verify_docker_gpu_access(
            device_access, gpu_access_policy, image_id, compose_project
        )

        from fullmag_storage import git as storage_git

        source_commit = storage_git(selected, "rev-parse", "HEAD")
        if COMMIT_RE.fullmatch(source_commit) is None:
            raise _fail("selected checkout has no canonical HEAD commit")
        source_for_environment = {
            "source_mode": "live-shadow-v1",
            "source_commit": source_commit,
            "git_common_dir": str(git_common),
        }
        cache = _prepare_backend_cache(layout, selected, image_id, resolved_root, selected, toolchain_id)
        package = _backend_cache_package_root(cache)
        # ``package`` is a daemon-side /mnt path supplied by the cache helper;
        # native Windows Python cannot inspect it.  The fixed backend service
        # owns the attempt fence and publishes a fresh receipt after its
        # in-container source scan.  Do not read or hash a guessed host path.
        previous_receipt_sha256 = None
        environment = _environment(
            layout, selected, resolved_root, source_for_environment,
            package, image_ref, image_id, toolchain_id, cache,
            str(base_info["reference"]), cargo_profile, device_access,
        )
        # No backend package or source snapshot is built/captured in this host
        # preparation phase.  The service observes the live readonly mounts on
        # every start, including an ordinary Docker Desktop restart.
        environment["FULLMAG_SOURCE_GIT_COMMON"] = str(git_common)
        environment["FULLMAG_SOURCE_COMMIT"] = source_commit
        files = [selected / COMPOSE_RUNTIME_FILE]
        if device_access == "gpu":
            gpu_overlay = selected / "compose.dev.gpu.yaml"
            if gpu_overlay.is_symlink() or not gpu_overlay.is_file():
                raise _fail("GPU development Compose overlay is missing")
            files.append(gpu_overlay)
        config = _compose_config(selected, files, environment, project=compose_project)
        services = config.get("services", {})
        if not isinstance(services, Mapping) or set(services) != {"backend", "frontend"}:
            raise _fail("direct development Compose must contain exactly backend and frontend services")
        backend_service = services.get("backend")
        if not isinstance(backend_service, dict):
            raise _fail("direct development Compose backend service is malformed")
        tokens = _service_tokens(backend_service)
        if "start" not in tokens or "backend_dev.py" not in " ".join(tokens):
            raise _fail("direct development backend service does not own the typed start operation")

        inputs = {
            "schema": BACKEND_START_INPUTS_SCHEMA,
            "state": "ready",
            "run_id": resolved_run_id,
            "compose_project": compose_project,
            "source_project_id": compose_identity["project_id"],
            "source_worktree_id": compose_identity["worktree_id"],
            "source_checkout_kind": compose_identity["checkout_kind"],
            "source_root": str(selected),
            "source_mode": "live-shadow-v1",
            "source_commit": source_commit,
            "git_common_dir": str(git_common),
            "image_reference": image_ref,
            "image_id": image_id,
            "toolchain_image_id": toolchain_id,
            "toolchain_manifest_sha256": base_info["toolchain_manifest_sha256"],
            "development_base_image": str(base_info["reference"]),
            "development_base_image_id": base_info["image_id"],
            "build_profile": build_profile,
            "cargo_profile": cargo_profile,
            "device_access": device_access,
            "gpu_preflight": "PASS" if device_access == "gpu" else "NOT_REQUIRED",
            "package_root": str(package),
            "provenance_path": f"{control_root}/backend/runtime-provenance.json",
            "host_certificate": str(resolved_root / "host-certificate.json"),
            "helper_context": helper_context,
            "startup_helper_hashes": helper_hashes,
            "backend_cache": dict(cache),
            "runtime_image_built": image_built,
            "backend_start_receipt": str(terminal_path),
            "previous_backend_build_receipt_sha256": previous_receipt_sha256,
            "backend_start_inputs": "pending",
        }
        inputs_relative = f"{CONTROL_NAMESPACE}/backend-start/{resolved_run_id}-inputs.json"
        inputs_path = _control_guest_path(inputs_relative)
        inputs["backend_start_inputs"] = inputs_path
        input_bytes = (
            json.dumps(inputs, ensure_ascii=True, indent=2, sort_keys=True) + "\n"
        ).encode("utf-8")
        _write_control(selected, compose_project, inputs_relative, input_bytes)
        input_sha256 = _sha256_bytes(input_bytes)
        # The serialized record is hashed before this handoff-only field is
        # attached. Runtime validation receives the same digest without a
        # second host-file read.
        inputs["backend_start_inputs_sha256"] = input_sha256
        terminal.update(
            state="ready",
            device_access=device_access,
            gpu_preflight="PASS" if device_access == "gpu" else "NOT_REQUIRED",
            backend_start_inputs=inputs_path,
            backend_start_inputs_sha256=input_sha256,
            image_id=image_id,
            image_reference=image_ref,
            toolchain_image_id=toolchain_id,
            runtime_image_built=image_built,
            backend_cache_receipt=cache.get("receipt_path"),
        )
        _write_control_json(selected, compose_project, terminal_relative, terminal)
        return inputs, resolved_root
    except Exception as error:
        terminal.update(
            state=("outcome_unknown_resources_retained"
                   if isinstance(error, DirectDockerOutcomeUnknown)
                   else "failed_resources_retained"),
            exit_code=2,
            error=str(error),
        )
        try:
            _write_control_json(selected, compose_project, terminal_relative, terminal)
        except Exception:
            pass
        raise
    finally:
        if not heavy_lock_held:
            lock_context.__exit__(None, None, None)


def _direct_heavy_lock(layout: Mapping[str, object]):
    """Return the Windows lease for backend-start preparation only."""

    from fullmag_storage import file_lock, validate_path

    storage_root = Path(str(layout["storage_root"]))
    lock = validate_path(
        storage_root / "locks" / "fullmag-heavy.lock",
        storage_root,
        "direct Docker backend start lock",
    )
    return file_lock(
        lock,
        "direct Docker backend start preparation",
        wait_timeout_seconds=120,
    )


def build(args: argparse.Namespace) -> None:
    """Explicit dev alias for the fixed two-service backend build gate.

    The backend package is built by the long-lived Compose backend service;
    this command never starts a one-shot backend container or copies a package
    through the host. It leaves the fixed frontend/backend services running,
    matching the up command so the backend receipt and runtime remain observable.
    """

    if getattr(args, "profile", DEFAULT_BUILD_PROFILE) != DEFAULT_BUILD_PROFILE:
        raise _fail(
            "docker-dev build only supports the fixed backend-dev service; "
            "release packages use the managed image route"
        )
    up(args)


def up(args: argparse.Namespace) -> None:
    _require_native_windows()
    gpu_access_policy = getattr(args, "gpu_access", None)
    device_access = (
        _resolve_gpu_access(gpu_access_policy)
        if gpu_access_policy is not None else "gpu"
    )
    repo = Path(args.repo_root).resolve(strict=True)
    selected, layout = _select_source(repo, args.source_root)
    source_identity = _compose_identity(layout)
    compose_project = source_identity["project_name"]
    _assert_no_running_fullmag(compose_project, source_identity)
    from fullmag_docker_runtime import assert_loopback_port_available, start
    assert_loopback_port_available(args.port, compose_project)
    # The Windows heavy-build lease is intentionally limited to preparation of
    # the image, toolchain, cache, and start receipt.  The fixed backend service
    # compiles from its live readonly source after this context exits; its
    # per-cache lease and terminal receipt govern that operation.  If Docker
    # later reports an unknown result, leave the owned containers and receipt
    # for explicit inspection instead of holding a host lease or retrying.
    with _direct_heavy_lock(layout):
        backend_start, _backend_input_root = _backend_start_inputs(
            args, heavy_lock_held=True, device_access=device_access,
            gpu_access_policy=gpu_access_policy,
        )
    device_access = backend_start.get("device_access", device_access)
    _assert_no_running_fullmag(compose_project, source_identity)
    # Keep startup_script opaque to this launcher.  The existing startup helper
    # performs path admission, source containment, hash, and wait_for_solve
    # policy checks against the same checkout.
    start_kwargs = {
        "frontend": "dev",
        "source_root": selected,
        "startup_script": args.script,
        "project_name": compose_project,
        "compose_template": selected / COMPOSE_RUNTIME_FILE,
        "backend_start": backend_start,
    }
    if gpu_access_policy is not None or "device_access" in backend_start:
        start_kwargs["device_access"] = device_access
    start(
        selected,
        None,
        args.port,
        **start_kwargs,
    )


def recreate(args: argparse.Namespace) -> None:
    """Recreate one named run, optionally promoting its Compose project."""
    _require_native_windows()
    repo = Path(args.repo_root).resolve(strict=True)
    from fullmag_docker_runtime import start

    direct_development = bool(getattr(args, "direct_development", False))
    if direct_development:
        if args.assembly_receipt is not None:
            raise _fail(
                "--direct-development cannot be combined with --assembly-receipt"
            )
        if getattr(args, "script", None) is not None:
            raise _fail(
                "--direct-development cannot be combined with --script; "
                "the existing startup activation is preserved"
            )
        if getattr(args, "recover_idle_failure", None) is not None:
            raise _fail(
                "--direct-development cannot be combined with --recover-idle-failure"
            )
        gpu_access_policy = getattr(args, "gpu_access", None)
        device_access = (
            _resolve_gpu_access(gpu_access_policy)
            if gpu_access_policy is not None else "gpu"
        )
        selected, backend_start = _prepare_direct_recreate_backend_start(
            args, repo, device_access=device_access,
            gpu_access_policy=gpu_access_policy,
        )
        device_access = backend_start.get("device_access", device_access)
        start_kwargs = {
            "frontend": "dev",
            "source_root": selected,
            "startup_script": None,
            "project_name": None,
            "compose_template": repo / COMPOSE_RUNTIME_FILE,
            "run_receipt": args.run_receipt,
            "previous_config_sha256": args.previous_config_sha256,
            "migrate_compose_project": getattr(args, "migrate_compose_project", False),
            "backend_start": backend_start,
        }
        if gpu_access_policy is not None or "device_access" in backend_start:
            start_kwargs["device_access"] = device_access
        start(
            repo,
            None,
            args.port,
            **start_kwargs,
        )
        return
    if args.assembly_receipt is None:
        raise _fail(
            "recreate requires --assembly-receipt unless --direct-development is selected"
        )

    # No build or latest-run lookup is allowed here.  The runtime validates the
    # receipt, owner marker, source checkout, config CAS and package receipt
    # before it mutates the explicitly named run namespace.
    start_kwargs = {
        "frontend": "dev",
        "source_root": args.source_root,
        "startup_script": args.script,
        "project_name": None,
        "compose_template": repo / COMPOSE_RUNTIME_FILE,
        "run_receipt": args.run_receipt,
        "previous_config_sha256": args.previous_config_sha256,
        "migrate_compose_project": getattr(args, "migrate_compose_project", False),
    }
    if getattr(args, "gpu_access", "auto") != "auto":
        raise _fail("--gpu-access is supported only with --direct-development")
    recovery_authorization = getattr(args, "recover_idle_failure", None)
    if recovery_authorization is not None:
        start_kwargs["recovery_authorization"] = recovery_authorization
    start(repo, args.assembly_receipt, args.port, **start_kwargs)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=_repo_default(),
                        help="main Fullmag checkout used for storage and Compose definitions")
    subparsers = parser.add_subparsers(dest="action", required=True)
    for name in ("build", "up"):
        command = subparsers.add_parser(name, help=(
            "start the fixed backend and frontend services; backend builds in-place"
            if name == "build" else "build and start backend plus frontend"
        ))
        command.add_argument("--source-root", type=Path,
                             help="registered checkout/worktree mounted live by both services")
        command.add_argument(
            "--profile", choices=sorted(BUILD_PROFILE_TO_CARGO_PROFILE),
            default=DEFAULT_BUILD_PROFILE,
            help="backend build profile: dev (Cargo backend-dev) or release",
        )
        command.add_argument("--image", help="existing/buildable development image/tag; default: FULLMAG_DEV_IMAGE or fullmag/fullmag-dev:local")
        command.add_argument("--toolchain-image", help="immutable toolchain image ID/tag; default: image label or configured value")
        command.add_argument(
            "--gpu-access", choices=sorted(GPU_ACCESS_CHOICES),
            default=os.environ.get("FULLMAG_GPU_ACCESS", "auto"),
            help="device access policy: auto, required, or disabled",
        )
        command.add_argument("--source-manifest", type=Path,
                             help="unsupported compatibility flag: live docker-dev does not consume frozen source manifests")
        command.add_argument("--include-untracked", action="append", default=[],
                             help="unsupported compatibility flag: add new source files to the selected Git index instead")
        command.add_argument("--port", type=int, default=3197,
                             help="loopback frontend port (up only)")
        command.add_argument("--script", "--startup-script", dest="script", type=Path,
                             help="optional simulation script, relative to the selected checkout or absolute inside it (up only)")
        if name == "build":
            command.set_defaults(script=None)
    recreate_parser = subparsers.add_parser(
        "recreate",
        help="recreate the named development run while retaining its state and session store",
    )
    recreate_parser.add_argument(
        "--run-receipt", type=Path, required=True,
        help="receipt.json of the one existing run to reuse; latest lookup is forbidden",
    )
    recreate_mode = recreate_parser.add_mutually_exclusive_group(required=True)
    recreate_mode.add_argument(
        "--assembly-receipt", type=Path,
        help="new successful development assembly receipt to mount (legacy mode)",
    )
    recreate_mode.add_argument(
        "--direct-development", action="store_true",
        help=(
            "reuse the named DEV run with live backend_start inputs; requires "
            "--run-receipt and --previous-config-sha256 and excludes --assembly-receipt"
        ),
    )
    recreate_parser.add_argument(
        "--image",
        help="optional immutable development image/tag override for direct development mode",
    )
    recreate_parser.add_argument(
        "--toolchain-image",
        help="optional immutable toolchain image/tag override for direct development mode",
    )
    recreate_parser.add_argument(
        "--gpu-access", choices=sorted(GPU_ACCESS_CHOICES),
        default=os.environ.get("FULLMAG_GPU_ACCESS", "auto"),
        help="device access policy for --direct-development",
    )
    recreate_parser.add_argument(
        "--previous-config-sha256", required=True,
        help="exact raw SHA-256 of the prior runtime service config",
    )
    recreate_parser.add_argument(
        "--migrate-compose-project", action="store_true",
        help=(
            "explicitly promote a validated legacy fullmag run to the "
            "canonical project for the same registered checkout"
        ),
    )
    recreate_parser.add_argument(
        "--recover-idle-failure", type=Path,
        help=(
            "explicit host authorization for one stopped failed native owner; "
            "without this flag recovery/takeover is never attempted"
        ),
    )
    recreate_parser.add_argument(
        "--source-root", type=Path,
        help="registered live checkout; omitted means the checkout recorded by the run receipt",
    )
    recreate_parser.add_argument("--port", type=int, default=3197)
    recreate_parser.add_argument(
        "--script", "--startup-script", dest="script", type=Path,
        help="optional simulation script relative to the selected checkout",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.action == "build":
            build(args)
        elif args.action == "up":
            up(args)
        elif args.action == "recreate":
            recreate(args)
        else:
            raise _fail(f"unsupported action: {args.action}")
        return 0
    except DirectDockerError as error:
        print(f"docker-dev: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
