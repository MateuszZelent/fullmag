"""Resolve or build the tiny local helper image used by the control volume."""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Mapping


BASE_IMAGE = (
    "nvidia/cuda:12.6.3-devel-ubuntu22.04@sha256:"
    "d49bb8a4ff97fb5fe477947a3f02aa8c0a53eae77e11f00ec28618a0bcaa2ad1"
)
DEVELOPMENT_BASE_REFERENCE = "fullmag/development-base:local"
HELPER_SCHEMA = "fullmag.docker-build-control-helper.v1"
HELPER_ROLE = "control-helper"
SERVICE_NAME = "build-control-base"
DOCKER_CONTEXT = "desktop-linux"
CONTROL_IMAGE_ENV = "FULLMAG_BUILD_CONTROL_IMAGE"
DOCKERFILE_RELATIVE = Path("docker") / "all-in-one" / "Dockerfile.build-control"
INSPECT_TIMEOUT_SECONDS = 60
INSPECT_MAX_BYTES = 256 * 1024
BUILD_LOCK_WAIT_SECONDS = 120
PROJECT_RE = re.compile(r"[a-z0-9][a-z0-9_-]{0,254}\Z")
WORKTREE_RE = re.compile(r"[a-z0-9][a-z0-9._-]{0,254}\Z")
IMAGE_ID_RE = re.compile(r"sha256:[0-9a-f]{64}\Z")
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
IMAGE_REFERENCE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}\Z")

LABEL_SCHEMA = "com.fullmag.build-control.helper.schema"
LABEL_ROLE = "com.fullmag.build-control.helper.role"
LABEL_PROJECT = "com.fullmag.build-control.project"
LABEL_WORKTREE = "com.fullmag.build-control.worktree-id"
LABEL_BASE_IMAGE = "com.fullmag.build-control.base-image"
LABEL_DOCKERFILE_SHA256 = "com.fullmag.build-control.dockerfile-sha256"
LABEL_BUILD_KEY = "com.fullmag.build-control.build-key"


class ControlHelperError(RuntimeError):
    """A local helper cannot be selected or built without guessing."""


class ControlHelperOutcomeUnknown(ControlHelperError):
    """A local Docker observation timed out; no mutating retry is authorized."""


class ControlHelperTerminalError(ControlHelperError):
    def __init__(self, message: str, exit_code: int):
        super().__init__(message)
        self.exit_code = exit_code


def _reject_duplicate_json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Docker image inspection returned duplicate JSON keys")
        result[key] = value
    return result


def _docker_environment() -> dict[str, str]:
    """Return a command-local environment; the explicit Docker context wins."""
    environment = dict(os.environ)
    environment.pop("DOCKER_CONTEXT", None)
    environment.pop("DOCKER_HOST", None)
    return environment


def _text(value: object, label: str) -> str:
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8")
        except UnicodeError as error:
            raise ControlHelperError(f"Docker {label} is not UTF-8") from error
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    raise ControlHelperError(f"Docker {label} has an unexpected type")


def _canonical_json(value: object) -> bytes:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeError) as error:
        raise ControlHelperError("Build-control Compose definition is not canonical JSON") from error


def _identity(layout: Mapping[str, object], identity_resolver=None) -> dict[str, str]:
    if identity_resolver is None:
        from docker_compose_identity import compose_project_identity

        identity_resolver = compose_project_identity
    try:
        resolved = identity_resolver(layout)
    except Exception as error:
        raise ControlHelperError("Cannot resolve the registered Compose checkout identity") from error
    if not isinstance(resolved, Mapping):
        raise ControlHelperError("Compose identity resolver returned an invalid record")
    project = resolved.get("project_name")
    worktree_id = resolved.get("worktree_id")
    canonical_root = resolved.get("source_root")
    if not isinstance(project, str) or PROJECT_RE.fullmatch(project) is None:
        raise ControlHelperError("Canonical Compose project name is invalid")
    if not isinstance(worktree_id, str) or WORKTREE_RE.fullmatch(worktree_id) is None:
        raise ControlHelperError("Canonical worktree identity is invalid")
    if not isinstance(canonical_root, str) or not canonical_root:
        raise ControlHelperError("Canonical Compose identity has no source root")
    return {"project_name": project, "worktree_id": worktree_id, "source_root": canonical_root}


def _source_paths(layout, source_root, identity):
    try:
        root = Path(source_root).resolve(strict=True)
        canonical_root = Path(identity["source_root"]).resolve(strict=True)
        storage_root = Path(layout["storage_root"]).resolve(strict=True)
        worktree_id = layout["worktree_id"]
    except (KeyError, OSError, TypeError, ValueError) as error:
        raise ControlHelperError("Selected checkout or resolved storage is unavailable") from error
    if os.path.normcase(str(root)) != os.path.normcase(str(canonical_root)):
        raise ControlHelperError("Helper source root differs from the canonical Compose checkout")
    if not isinstance(worktree_id, str) or worktree_id != identity["worktree_id"]:
        raise ControlHelperError("Resolved worktree identity differs from the canonical Compose checkout")

    context = root / "docker" / "all-in-one"
    dockerfile = context / "Dockerfile.build-control"
    canonical_compose = root / "compose.toolchain.yaml"
    if context.is_symlink() or not context.is_dir() or dockerfile.is_symlink() or not dockerfile.is_file():
        raise ControlHelperError("Versioned build-control Dockerfile or context is unavailable or redirected")
    if canonical_compose.is_symlink() or not canonical_compose.is_file():
        raise ControlHelperError("Canonical Compose toolchain definition is unavailable or redirected")
    try:
        raw_dockerfile = dockerfile.read_bytes()
    except OSError as error:
        raise ControlHelperError("Cannot read the versioned build-control Dockerfile") from error
    if len(raw_dockerfile) == 0 or len(raw_dockerfile) > 64 * 1024:
        raise ControlHelperError("Versioned build-control Dockerfile has an invalid size")
    try:
        dockerfile_text = raw_dockerfile.decode("utf-8")
    except UnicodeError as error:
        raise ControlHelperError("Versioned build-control Dockerfile is not UTF-8") from error
    first_line = next((line.strip() for line in dockerfile_text.splitlines() if line.strip()), "")
    if first_line != f"FROM {BASE_IMAGE}":
        raise ControlHelperError("Build-control helper base differs from the pinned canonical CUDA image")
    try:
        canonical_compose_text = canonical_compose.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        raise ControlHelperError("Cannot read the canonical Compose toolchain definition") from error
    if BASE_IMAGE not in canonical_compose_text:
        raise ControlHelperError("Pinned helper base no longer matches the canonical Compose toolchain default")
    dockerfile_sha256 = hashlib.sha256(raw_dockerfile).hexdigest()
    if SHA256_RE.fullmatch(dockerfile_sha256) is None:
        raise ControlHelperError("Build-control Dockerfile digest is invalid")
    return root, context, dockerfile, storage_root, dockerfile_sha256


def _inspect_local_image(reference, source_root, *, runner=None):
    if not isinstance(reference, str) or IMAGE_REFERENCE_RE.fullmatch(reference) is None:
        raise ControlHelperError("Local helper image reference is invalid")
    if runner is None:
        runner = subprocess.run
    command = [
        "docker", "--context", DOCKER_CONTEXT, "image", "inspect", reference,
        "--format", "{{json .}}",
    ]
    try:
        result = runner(
            command,
            cwd=str(source_root),
            env=_docker_environment(),
            capture_output=True,
            timeout=INSPECT_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as error:
        raise ControlHelperOutcomeUnknown(
            f"Local image inspection timed out for {reference}; "
            "image selection is unknown and no automatic retry is authorized"
        ) from error
    except OSError as error:
        raise ControlHelperError("Cannot inspect the local Docker image store") from error
    stdout = _text(getattr(result, "stdout", None), "image inspection output")
    stderr = _text(getattr(result, "stderr", None), "image inspection error")
    if len(stdout.encode("utf-8")) > INSPECT_MAX_BYTES or len(stderr.encode("utf-8")) > INSPECT_MAX_BYTES:
        raise ControlHelperError("Docker image inspection exceeded its bounded response size")
    return_code = getattr(result, "returncode", None)
    if return_code != 0:
        folded = stderr.casefold()
        if "no such image" in folded or "image not found" in folded or "no such object" in folded:
            return None
        raise ControlHelperError(
            f"Local Docker image inspection failed for {reference}: {stderr.strip() or return_code}"
        )
    try:
        image = json.loads(stdout, object_pairs_hook=_reject_duplicate_json_object)
    except (json.JSONDecodeError, ValueError) as error:
        raise ControlHelperError(f"Docker returned invalid metadata for local image {reference}") from error
    if not isinstance(image, dict):
        raise ControlHelperError(f"Docker returned an invalid image record for {reference}")
    image_id = image.get("Id")
    if not isinstance(image_id, str) or IMAGE_ID_RE.fullmatch(image_id) is None:
        raise ControlHelperError(f"Local image {reference} has no immutable SHA-256 identity")
    if image.get("Os") != "linux" or image.get("Architecture") != "amd64":
        raise ControlHelperError(f"Local image {reference} is not a Linux/amd64 helper image")
    config = image.get("Config")
    if not isinstance(config, Mapping):
        raise ControlHelperError(f"Local image {reference} has no valid image configuration")
    volumes = config.get("Volumes")
    if volumes is not None and (not isinstance(volumes, Mapping) or volumes):
        raise ControlHelperError(
            f"Local image {reference} declares anonymous volumes; refusing a helper with implicit storage"
        )
    return image


def _expected_labels(project, worktree_id, dockerfile_sha256, build_key):
    return {
        LABEL_SCHEMA: HELPER_SCHEMA,
        LABEL_ROLE: HELPER_ROLE,
        LABEL_PROJECT: project,
        LABEL_WORKTREE: worktree_id,
        LABEL_BASE_IMAGE: BASE_IMAGE,
        LABEL_DOCKERFILE_SHA256: dockerfile_sha256,
        LABEL_BUILD_KEY: build_key,
    }


def _validate_derived_image(image, reference, expected_labels):
    if image is None:
        return None
    config = image.get("Config")
    labels = config.get("Labels") if isinstance(config, Mapping) else None
    if not isinstance(labels, Mapping) or any(labels.get(key) != value for key, value in expected_labels.items()):
        raise ControlHelperError(
            f"Existing local helper tag {reference} has foreign or stale provenance labels; "
            "refusing to adopt or replace it"
        )
    return image["Id"]


@contextmanager
def _heavy_build_lock(layout, storage_root, lock_factory=None):
    if lock_factory is None:
        import fullmag_storage as storage

        try:
            lock_path = storage.validate_path(
                storage_root / "locks" / "fullmag-heavy.lock",
                storage_root,
                "Docker helper image build lock",
            )
        except (OSError, ValueError) as error:
            raise ControlHelperError("Resolved Docker heavy-build lock path is invalid") from error
        lock_factory = lambda: storage.file_lock(
            lock_path,
            "Docker Compose control helper image build",
            wait_timeout_seconds=BUILD_LOCK_WAIT_SECONDS,
        )
    try:
        lock_context = lock_factory()
        lock_context.__enter__()
    except ControlHelperError:
        raise
    except Exception as error:
        raise ControlHelperError("Cannot acquire the canonical host heavy-build lock") from error
    try:
        yield
    except BaseException as error:
        if not lock_context.__exit__(type(error), error, error.__traceback__):
            raise
    else:
        lock_context.__exit__(None, None, None)


def _compose_document(project, worktree_id, context, reference, dockerfile_sha256, build_key):
    return {
        "name": project,
        "services": {
            SERVICE_NAME: {
                "image": reference,
                "platform": "linux/amd64",
                "pull_policy": "never",
                "build": {
                    "context": str(context),
                    "dockerfile": "Dockerfile.build-control",
                    "args": {
                        "FULLMAG_CONTROL_PROJECT": project,
                        "FULLMAG_CONTROL_WORKTREE_ID": worktree_id,
                        "FULLMAG_CONTROL_DOCKERFILE_SHA256": dockerfile_sha256,
                        "FULLMAG_CONTROL_BUILD_KEY": build_key,
                    },
                },
            },
        },
    }


def _build_with_compose(source_root, project, compose_document, *, popen=None):
    if popen is None:
        popen = subprocess.Popen
    command = [
        "docker", "--context", DOCKER_CONTEXT, "compose",
        "--project-name", project,
        "--project-directory", str(source_root),
        "-f", "-", "build", "--pull=false", SERVICE_NAME,
    ]
    try:
        process = popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            cwd=str(source_root),
            env=_docker_environment(),
        )
    except OSError as error:
        raise ControlHelperError("Compose BuildKit helper command did not start") from error
    request = _canonical_json(compose_document)
    stream_error = None
    if process.stdin is None:
        stream_error = RuntimeError("Compose helper build has no stdin pipe")
    else:
        try:
            process.stdin.write(request)
            process.stdin.flush()
        except BaseException as error:
            stream_error = error
        finally:
            try:
                process.stdin.close()
            except BaseException as error:
                if stream_error is None:
                    stream_error = error

    interrupted = False
    display_enabled = True
    if process.stdout is None:
        if stream_error is None:
            stream_error = RuntimeError("Compose helper build has no output pipe")
    else:
        read_chunk = getattr(process.stdout, "read1", None)
        if not callable(read_chunk):
            # Unbuffered Popen pipes expose FileIO.read(), not BufferedReader.read1().
            read_chunk = process.stdout.read
        while True:
            try:
                block = read_chunk(65536)
            except KeyboardInterrupt:
                interrupted = True
                continue
            if not block:
                break
            if display_enabled:
                try:
                    if hasattr(sys.stdout, "buffer"):
                        sys.stdout.buffer.write(block)
                        sys.stdout.buffer.flush()
                    else:
                        sys.stdout.write(block.decode("utf-8", "replace"))
                        sys.stdout.flush()
                except (UnicodeError, OSError):
                    # Console presentation must never stop observation of a live
                    # BuildKit client; continue draining without rendering.
                    display_enabled = False
        try:
            process.stdout.close()
        except OSError:
            pass
    while True:
        try:
            exit_code = process.wait()
            break
        except KeyboardInterrupt:
            # The build is a mutation. Keep observing it and never resubmit it.
            interrupted = True
    if stream_error is not None:
        raise ControlHelperTerminalError(
            f"Compose helper build reached terminal exit {exit_code} after stdin transport failed; "
            "image state requires inspection",
            exit_code,
        ) from stream_error
    if interrupted or exit_code != 0:
        raise ControlHelperTerminalError(
            f"Compose helper build reached terminal exit {exit_code}; "
            f"interrupted={interrupted}; Docker resources were retained",
            exit_code,
        )


def ensure_control_helper(layout, source_root):
    """Return a verified local immutable helper ID, building only when needed.

    An explicit FULLMAG_BUILD_CONTROL_IMAGE is inspect-only. Otherwise an
    existing development-base image preserves the established host route. A
    fresh host builds one small helper image through Compose BuildKit in the
    selected checkout's canonical project; it never starts a service or writes
    a host-side compose file, log, temporary file, or receipt.
    """
    from docker_compose_identity import compose_project_identity

    identity = _identity(layout, compose_project_identity)
    root, context, _dockerfile, storage_root, dockerfile_sha256 = _source_paths(
        layout, source_root, identity
    )
    explicit = os.environ.get(CONTROL_IMAGE_ENV)
    if explicit is not None:
        if not explicit or explicit.strip() != explicit:
            raise ControlHelperError(f"{CONTROL_IMAGE_ENV} must name one local image reference")
        selected = _inspect_local_image(explicit, root)
        if selected is None:
            raise ControlHelperError(
                f"Explicit {CONTROL_IMAGE_ENV} image is not available locally; automatic pull/build is disabled"
            )
        return selected["Id"]

    development_base = _inspect_local_image(DEVELOPMENT_BASE_REFERENCE, root)
    if development_base is not None:
        return development_base["Id"]

    build_identity = {
        "schema": HELPER_SCHEMA,
        "project": identity["project_name"],
        "worktree_id": identity["worktree_id"],
        "base_image": BASE_IMAGE,
        "dockerfile_sha256": dockerfile_sha256,
    }
    build_key = hashlib.sha256(_canonical_json(build_identity)).hexdigest()
    if SHA256_RE.fullmatch(build_key) is None:
        raise ControlHelperError("Derived helper build identity is invalid")
    reference = f"fullmag/build-control:{build_key}"
    expected_labels = _expected_labels(
        identity["project_name"], identity["worktree_id"], dockerfile_sha256, build_key
    )

    existing = _inspect_local_image(reference, root)
    selected = _validate_derived_image(existing, reference, expected_labels)
    if selected is not None:
        return selected

    with _heavy_build_lock(layout, storage_root):
        # Recheck inside the lock so two Fullmag launchers never race to replace
        # the same deterministic tag.
        existing = _inspect_local_image(reference, root)
        selected = _validate_derived_image(existing, reference, expected_labels)
        if selected is not None:
            return selected
        compose_document = _compose_document(
            identity["project_name"], identity["worktree_id"], context,
            reference, dockerfile_sha256, build_key,
        )
        _build_with_compose(root, identity["project_name"], compose_document)
        post_root, post_context, _post_dockerfile, post_storage_root, post_dockerfile_sha256 = _source_paths(
            layout, source_root, identity
        )
        if (
            os.path.normcase(str(post_root)) != os.path.normcase(str(root))
            or os.path.normcase(str(post_context)) != os.path.normcase(str(context))
            or os.path.normcase(str(post_storage_root)) != os.path.normcase(str(storage_root))
            or post_dockerfile_sha256 != dockerfile_sha256
        ):
            raise ControlHelperError(
                "Build-control source or Dockerfile changed while BuildKit was building; "
                "the resulting image cannot be selected"
            )
        built = _inspect_local_image(reference, root)
        selected = _validate_derived_image(built, reference, expected_labels)
        if selected is None:
            raise ControlHelperError("BuildKit completed but the deterministic local helper image is unavailable")
        return selected
