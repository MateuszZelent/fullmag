#!/usr/bin/env python3
"""Build the pinned dependency image on a fresh Windows Docker host.

The default operation is first enrollment. Explicit direct-development mode
shares the host heavy-work lock without enrolling or submitting to the old
runner. Application sources are absent from the frozen dependency context.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import threading
import time

import fullmag_storage as storage
from docker_named_volume_safety import (
    DockerNamedVolumeSafetyError,
    validate_local_named_volume,
)
from docker_build_control import BuildControlError
from docker_dev_host import docker_argv

PROFILE = "docker-all-gpu"
SERVICE = "fem-gpu-toolchain"
MAX_INPUT_BYTES = 16 * 1024 * 1024
DEPENDENCY_MANIFEST = "/opt/fullmag-deps/share/fullmag/dependency-versions.json"
CONTROL_VOLUME_SCHEMA = "fullmag.docker-toolchain-control.v1"
CONTROL_VOLUME_PREFIX = "fullmag-build-control-"
CONTROL_VOLUME_ENV = "FULLMAG_BUILD_CONTROL_VOLUME"
CONTROL_ROOT = "/opt/fullmag/control"
CONTROL_RECEIPT = "toolchain/bootstrap-receipt.json"
CONTROL_BUILD_LOG = "toolchain/build.log"


class BootstrapError(ValueError):
    pass


def assert_fresh_host(root, previous=None):
    """An enrolled coordinator must own all subsequent heavy builds."""
    root = Path(root)
    for name in ("local-runner-container.json", "local-runner-container-secret.json",
                 "local-runner-config.json", "local-runner-build-config.json",
                 "local-runner-service.json", "local-runner-service.stop.json"):
        path = storage.validate_path(root / "index" / name, root)
        if os.path.lexists(path):
            raise BootstrapError(
                "This host already has a build runner; dependency updates require its managed maintenance route"
            )
    assert_bootstrap_reconciled(root, previous)
    database = storage.validate_path(root / "index/runner-jobs.sqlite", root)
    if os.path.lexists(database):
        # Even an idle queue proves prior enrollment. Do not infer that it is
        # safe to bypass its owner from a missing config or an empty active set.
        raise BootstrapError("An existing build queue requires managed maintenance; bootstrap refused")


def assert_bootstrap_reconciled(root, previous=None):
    """A previous unknown Docker outcome requires reconciliation in either mode."""
    root = Path(root)
    if previous is None:
        # Read the pre-volume receipt only for migration safety. New receipts
        # are never written to host storage.
        admission = storage.validate_path(root / "index/docker-toolchain-bootstrap.json", root)
        if os.path.lexists(admission):
            previous = json.loads(read_input(root, Path("index/docker-toolchain-bootstrap.json")))
    if previous is not None and (
            not isinstance(previous, dict)
            or previous.get("schema") not in {
                "fullmag.docker-toolchain-bootstrap.v1",
                CONTROL_VOLUME_SCHEMA,
            }
            or previous.get("state") not in {"built", "failed_confirmed"}
        ):
        raise BootstrapError("Previous Docker bootstrap outcome requires explicit resource reconciliation")


def input_files(repo):
    repo = Path(repo)
    directory = repo / "docker/fem-gpu"
    if storage.is_link(directory) or not directory.is_dir():
        raise BootstrapError("Missing regular docker/fem-gpu dependency context")
    names = [Path(".dockerignore"), Path("compose.toolchain.yaml")]
    for current, directories, files in os.walk(directory, followlinks=False):
        for name in directories:
            if storage.is_link(Path(current) / name):
                raise BootstrapError("Dependency context must not contain directory links")
        names.extend((Path(current) / name).relative_to(repo) for name in files)
    return sorted(names, key=lambda path: path.as_posix())



def tracked_input_files(repo):
    eligible = set(input_files(repo))
    tracked = storage.git(repo, "ls-files", "-z", "--", ".dockerignore",
                          "compose.toolchain.yaml", "docker/fem-gpu")
    names = sorted((Path(name) for name in tracked.split("\0") if name),
                   key=lambda path: path.as_posix())
    required = {
        Path(".dockerignore"),
        Path("compose.toolchain.yaml"),
        Path("docker/fem-gpu/Dockerfile"),
        Path("docker/fem-gpu/Dockerfile.dockerignore"),
    }
    if not required.issubset(names) or any(name not in eligible for name in names):
        raise BootstrapError("Dependency context requires present Git-tracked canonical inputs")
    return names


def read_input(repo, relative):
    path = storage.validate_path(Path(repo) / relative, repo, "dependency input")
    if os.name == "nt":
        from windows_folder_host import read_owned_regular
        return read_owned_regular(path, maximum=MAX_INPUT_BYTES)
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    descriptor = os.open(path, flags)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > MAX_INPUT_BYTES:
            raise BootstrapError("Dependency input must be a bounded regular file")
        data = os.read(descriptor, MAX_INPUT_BYTES + 1)
        if len(data) > MAX_INPUT_BYTES:
            raise BootstrapError("Dependency input is too large")
        return data
    finally:
        os.close(descriptor)


def capture_inputs(repo):
    """Hash dependency inputs in memory; never stage a host build context."""
    names = tracked_input_files(repo)
    manifest = []
    for relative in names:
        data = read_input(repo, relative)
        manifest.append({"path": relative.as_posix(), "sha256": hashlib.sha256(data).hexdigest()})
    if tracked_input_files(repo) != names:
        raise BootstrapError("Tracked dependency context changed during capture")
    for entry in manifest:
        if hashlib.sha256(read_input(repo, entry["path"])).hexdigest() != entry["sha256"]:
            raise BootstrapError("Dependency input changed during capture: " + entry["path"])
    return manifest


def verify_capture(repo, manifest):
    """Re-hash the readonly checkout after BuildKit consumed its context."""
    if not isinstance(manifest, list):
        raise BootstrapError("Dependency input manifest is malformed")
    names = tracked_input_files(repo)
    if names != [Path(entry["path"]) for entry in manifest]:
        raise BootstrapError("Tracked dependency file inventory changed")
    for entry in manifest:
        if hashlib.sha256(read_input(repo, entry["path"])).hexdigest() != entry["sha256"]:
            raise BootstrapError("Frozen dependency input changed: " + entry["path"])


def bounded_command(command, *, maximum=2 * 1024 * 1024, timeout=90,
                    environment=None, input_data=None):
    """Bound both pipe streams while reading, including on native Windows."""
    process = subprocess.Popen(
        command,
        stdin=subprocess.PIPE if input_data is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=None if environment is None else {**os.environ, **dict(environment)},
    )
    output = {"stdout": bytearray(), "stderr": bytearray()}
    lock = threading.Lock()
    overflow = threading.Event()
    errors = []
    size = 0

    def drain(stream, name):
        nonlocal size
        try:
            while chunk := stream.read1(65536):
                with lock:
                    remaining = maximum - size
                    output[name].extend(chunk[:remaining])
                    size += min(len(chunk), remaining)
                    if len(chunk) > remaining:
                        overflow.set()
                        return
        except OSError as error:
            errors.append(error)

    threads = [threading.Thread(target=drain, args=(stream, name), daemon=True)
               for stream, name in ((process.stdout, "stdout"), (process.stderr, "stderr"))]
    for thread in threads:
        thread.start()
    if input_data is not None:
        def feed_input():
            try:
                assert process.stdin is not None
                process.stdin.write(input_data)
                process.stdin.close()
            except (BrokenPipeError, OSError):
                pass
        input_thread = threading.Thread(target=feed_input, daemon=True)
        input_thread.start()
    else:
        input_thread = None
    deadline = time.monotonic() + timeout
    interrupted = None
    try:
        while process.poll() is None:
            if overflow.wait(0.025):
                interrupted = "Docker client output limit exceeded"
                break
            if time.monotonic() >= deadline:
                interrupted = "Docker client observation timed out"
                break
    finally:
        if process.poll() is None:
            # This bounds the client only. A named daemon-side probe may still
            # exist; the receipt retains its name for explicit reconciliation.
            process.kill()
        process.wait(timeout=5)
        for thread in threads:
            thread.join(timeout=1)
        if input_thread is not None:
            input_thread.join(timeout=1)
        for stream, thread in zip((process.stdout, process.stderr), threads):
            if not thread.is_alive():
                stream.close()
    if interrupted or overflow.is_set() or errors or any(thread.is_alive() for thread in threads):
        raise BootstrapError((interrupted or "Docker output could not be read within its bound")
                             + "; daemon resources retained for inspection")
    stdout = output["stdout"].decode("utf-8")
    stderr = output["stderr"].decode("utf-8", "replace")
    if process.returncode:
        raise BootstrapError(stderr.strip() or stdout.strip() or "Docker operation failed")
    return stdout


def docker(*args, environment=None, input_data=None):
    return bounded_command(
        docker_argv(*args),
        environment=environment,
        input_data=input_data,
    )


def docker_live(command, *, environment=None, timeout=4 * 60 * 60,
                maximum=8 * 1024 * 1024, output_sink=None):
    """Stream BuildKit output and optionally persist its bounded observation.

    ``output_sink`` is called from the finalizer, including when the Docker
    client is interrupted.  The sink must write only to Docker-managed
    storage; this function never creates a host-side build log.
    """
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env=None if environment is None else {**os.environ, **dict(environment)},
        text=False,
        bufsize=0,
    )
    output = bytearray()
    truncated = False
    warned = False
    code = None
    deadline = time.monotonic() + timeout
    try:
        assert process.stdout is not None
        for line in iter(process.stdout.readline, b""):
            if len(output) < maximum:
                remaining = maximum - len(output)
                output.extend(line[:remaining])
                if len(line) > remaining:
                    truncated = True
            else:
                truncated = True
            sys.stdout.buffer.write(line)
            sys.stdout.buffer.flush()
            if not warned and time.monotonic() >= deadline:
                warned = True
                print(
                    "[docker-bootstrap] Build exceeded its observation budget; "
                    "waiting for the Docker client to finish",
                    file=sys.stderr,
                    flush=True,
                )
        code = process.wait()
    except KeyboardInterrupt:
        process.wait()
        raise
    finally:
        if output_sink is not None:
            active_error = sys.exc_info()[1]
            try:
                output_sink(
                    bytes(output),
                    exit_code=code,
                    truncated=truncated,
                    interrupted=active_error is not None or code in (130, 143),
                    observation_budget_exceeded=warned,
                )
            except BaseException as sink_error:
                if active_error is None:
                    raise
                print(
                    f"Docker bootstrap: could not persist partial BuildKit log: {sink_error}",
                    file=sys.stderr,
                )
    return code, bytes(output)


def _compose_prefix(repo, project):
    repo = Path(repo).resolve(strict=True)
    return [
        "compose", "--project-name", project,
        "--project-directory", str(repo),
        "-f", str(repo / "compose.toolchain.yaml"),
    ]


def control_volume_name(project):
    """Return the stable control volume for one Compose project."""
    if not isinstance(project, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", project):
        raise BootstrapError("Invalid Compose project for toolchain control volume")
    suffix = hashlib.sha256(project.encode("utf-8")).hexdigest()[:16]
    return f"{CONTROL_VOLUME_PREFIX}{project[:180]}-{suffix}"


def toolchain_image_reference(project):
    """Return the immutable local tag reserved for one Compose group."""
    if not isinstance(project, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", project):
        raise BootstrapError("Invalid Compose project for toolchain image")
    suffix = hashlib.sha256(project.encode("utf-8")).hexdigest()[:16]
    segment = project[:96].rstrip("-_") or "fullmag"
    return f"fullmag/{segment}-{suffix}-fem-gpu-toolchain:cuda12.6.3"


def _control_environment(project):
    return {
        "FULLMAG_COMPOSE_PROJECT": project,
        CONTROL_VOLUME_ENV: control_volume_name(project),
        "FULLMAG_CONTROL_ROOT": CONTROL_ROOT,
        "FULLMAG_TOOLCHAIN_IMAGE": toolchain_image_reference(project),
    }


def _compose_environment(repo, project):
    # Compose interpolates every service, including inactive profiles, before
    # running the control helper. Receipt I/O needs the build inputs as well.
    return {
        **_control_environment(project),
        "FULLMAG_TOOLCHAIN_CONTEXT": str(Path(repo).resolve(strict=True)),
        "FULLMAG_TOOLCHAIN_IMAGE": toolchain_image_reference(project),
    }



def _validate_manifest_probe_policy(configured):
    """Validate the rendered no-GPU policy before reading the image manifest."""
    services = configured.get("services")
    service = services.get(SERVICE) if isinstance(services, dict) else None
    if not isinstance(service, dict):
        raise BootstrapError("Dependency manifest probe service is missing")
    if service.get("network_mode") != "none":
        raise BootstrapError("Dependency manifest probe must use network_mode=none")
    if service.get("read_only") is not True:
        raise BootstrapError("Dependency manifest probe must use a read-only root")
    if service.get("cap_drop") != ["ALL"]:
        raise BootstrapError("Dependency manifest probe must drop all capabilities")
    if service.get("security_opt") != ["no-new-privileges:true"]:
        raise BootstrapError("Dependency manifest probe must disable privilege gain")
    if str(service.get("user")) != "65532:65532":
        raise BootstrapError("Dependency manifest probe must run as uid/gid 65532")
    if service.get("pids_limit") != 16:
        raise BootstrapError("Dependency manifest probe must use pids_limit=16")
    memory = service.get("mem_limit")
    if str(memory).lower() not in {"64m", "67108864"}:
        raise BootstrapError("Dependency manifest probe must use a 64 MiB memory limit")
    cpus = service.get("cpus")
    try:
        cpus_value = float(cpus)
    except (TypeError, ValueError) as error:
        raise BootstrapError("Dependency manifest probe must use cpus=0.25") from error
    if isinstance(cpus, bool) or cpus_value != 0.25:
        raise BootstrapError("Dependency manifest probe must use cpus=0.25")
    environment = service.get("environment")
    if not isinstance(environment, dict) or environment.get("NVIDIA_VISIBLE_DEVICES") != "void":
        raise BootstrapError("Dependency manifest probe must hide NVIDIA devices")
    if "gpus" in service:
        raise BootstrapError("Dependency manifest probe must not request GPU devices")
    deploy = service.get("deploy")
    if isinstance(deploy, dict):
        resources = deploy.get("resources")
        reservations = resources.get("reservations") if isinstance(resources, dict) else None
        if isinstance(reservations, dict) and reservations.get("devices"):
            raise BootstrapError("Dependency manifest probe must not reserve GPU devices")


def _validate_control_mount(configured, expected_volume):
    declared = configured.get("volumes", {}).get("toolchain-control", {})
    if declared.get("name") != expected_volume or declared.get("external") is not True:
        raise BootstrapError("Toolchain control volume is not the selected external group volume")
    mounts = configured.get("services", {}).get("toolchain-control", {}).get("volumes", [])
    # Compose config retains the logical source key here. The engine volume
    # name is resolved through the top-level declaration checked above.
    if (len(mounts) != 1 or not isinstance(mounts[0], dict)
            or mounts[0].get("type") != "volume"
            or mounts[0].get("source") != "toolchain-control"
            or mounts[0].get("target") != CONTROL_ROOT
            or mounts[0].get("read_only", False)
            or mounts[0].get("volume", {}).get("nocopy") is not True):
        raise BootstrapError("Toolchain control helper lost its group volume mount")


def ensure_control_volume(project):
    volume = control_volume_name(project)
    try:
        raw = docker("volume", "inspect", volume)
        value = json.loads(raw)
        if not isinstance(value, list) or len(value) != 1:
            raise BootstrapError("Toolchain control volume inspection is malformed")
    except BootstrapError as error:
        if "no such volume" not in str(error).lower() and "volume not found" not in str(error).lower():
            raise
        docker(
            "volume", "create",
            "--label", f"com.fullmag.compose.project={project}",
            "--label", f"com.fullmag.toolchain.control.schema={CONTROL_VOLUME_SCHEMA}",
            "--label", f"com.fullmag.toolchain.control.project={project}",
            "--label", f"com.fullmag.toolchain.control.mount={CONTROL_ROOT}",
            volume,
        )
        value = json.loads(docker("volume", "inspect", volume))
    document = value[0]
    if not isinstance(document, dict):
        raise BootstrapError("Toolchain control volume inspection is malformed")
    try:
        validate_local_named_volume(document, volume)
    except DockerNamedVolumeSafetyError as error:
        raise BootstrapError(
            f"Toolchain control volume has unsafe Docker backing: {error}"
        ) from error
    labels = document.get("Labels")
    if (not isinstance(labels, dict)
            or labels.get("com.fullmag.compose.project") != project
            or labels.get("com.fullmag.toolchain.control.schema") != CONTROL_VOLUME_SCHEMA
            or labels.get("com.fullmag.toolchain.control.project") != project
            or labels.get("com.fullmag.toolchain.control.mount") != CONTROL_ROOT):
        raise BootstrapError("Toolchain control volume belongs to another Compose project")
    return volume


def _control_command(repo, project, relative, *, read=False):
    if Path(relative).is_absolute() or ".." in Path(relative).parts:
        raise BootstrapError("Unsafe toolchain control-volume path")
    script = (
        'set -eu; root="$FULLMAG_CONTROL_ROOT"; rel="$1"; '
        'case "$rel" in /*|*..*) exit 2;; esac; '
        'cat "$root/$rel"'
        if read else
        'set -eu; root="$FULLMAG_CONTROL_ROOT"; rel="$1"; '
        'case "$rel" in /*|*..*) exit 2;; esac; '
        'dest="$root/$rel"; mkdir -p "$(dirname "$dest")"; '
        'tmp="$dest.$$"; cat > "$tmp"; mv -f "$tmp" "$dest"'
    )
    return [
        *_compose_prefix(repo, project), "--profile", "toolchain-control",
        "run", "--rm", "--no-deps", "-T", "--cap-add", "DAC_OVERRIDE", "--entrypoint", "/bin/sh",
        "toolchain-control", "-c", script, "--", str(relative),
    ]


def write_control(repo, project, relative, data):
    docker(
        *_control_command(repo, project, relative),
        environment=_compose_environment(repo, project),
        input_data=data,
    )


def read_control(repo, project, relative):
    return docker(
        *_control_command(repo, project, relative, read=True),
        environment=_compose_environment(repo, project),
    ).encode("utf-8")



def initialize_host_storage(layout, volume_probe):
    """Admit an already configured Windows storage root without creating build data."""
    root = Path(layout["storage_root"])
    if not root.is_dir():
        raise BootstrapError(
            "Docker bootstrap requires an existing configured storage root; "
            "run setup_docker.py first"
        )
    volume_probe(root)


def compose_project(layout, *, direct_development=False):
    """Bind development dependency builds to the registered checkout group."""
    from docker_compose_identity import compose_project_identity
    return compose_project_identity(layout)["project_name"]


def build(repo, *, direct_development=False):
    if direct_development:
        from docker_build_control import build_volume_toolchain
        return build_volume_toolchain(repo)
    if os.name != "nt":
        raise BootstrapError("Use PowerShell in the Windows checkout for this host bootstrap")
    repo = Path(repo).resolve(strict=True)
    layout = storage.resolve_layout(repo, PROFILE)
    project_name = compose_project(layout, direct_development=direct_development)
    from windows_folder_host import local_volume
    local_volume(repo)
    if docker("info", "--format", "{{.OSType}}").strip() != "linux":
        raise BootstrapError("Docker Desktop must use the Linux engine")
    initialize_host_storage(layout, local_volume)
    root = Path(layout["storage_root"])
    control_volume = ensure_control_volume(project_name)
    previous = None
    try:
        previous = json.loads(read_control(repo, project_name, CONTROL_RECEIPT))
    except BootstrapError as error:
        message = str(error).lower()
        if "no such file" not in message and "not found" not in message:
            raise
    admission_check = assert_bootstrap_reconciled if direct_development else assert_fresh_host
    admission_check(root, previous)
    # This small host file is coordination metadata only. Build contexts,
    # caches, logs, receipts, and manifests remain in Docker-managed storage.
    lock = storage.validate_path(root / "locks/fullmag-heavy.lock", root)
    # Hold the same durable host slot through capture, Docker and inspection.
    with storage.file_lock(lock, "Docker dependency toolchain build"):
        admission_check(root, previous)
        manifest = capture_inputs(repo)
        compose_file = repo / "compose.toolchain.yaml"
        definitions = [
            *_compose_prefix(repo, project_name),
            "--profile", "toolchain",
            "--profile", "toolchain-control",
        ]
        compose_environment = _compose_environment(repo, project_name)
        configured = json.loads(docker(
            *definitions, "config", "--format", "json", environment=compose_environment
        ))
        if configured.get("name") != project_name:
            raise BootstrapError("Dependency Compose lost the selected checkout project")
        if set(configured.get("services", {})) != {SERVICE, "toolchain-control"}:
            raise BootstrapError("Unexpected dependency Compose services")
        _validate_control_mount(configured, control_volume)
        _validate_manifest_probe_policy(configured)
        service = configured["services"][SERVICE]
        build_definition = service.get("build", {})
        build_context = Path(build_definition.get("context", "")).resolve()
        if (build_definition.get("target") != "fem-gpu-dev"
                or build_definition.get("dockerfile") != "docker/fem-gpu/Dockerfile"
                or build_context != repo.resolve()):
            raise BootstrapError("Dependency Compose changed the canonical Dockerfile/context/target")
        compose_sha256 = hashlib.sha256(compose_file.read_bytes()).hexdigest()
        receipt = {
            "schema": "fullmag.docker-toolchain-bootstrap.v1",
            "state": "capturing",
            "repo_root": str(repo),
            "worktree_id": layout["worktree_id"],
            "source_commit": storage.git(repo, "rev-parse", "HEAD"),
            "source_context": str(repo),
            "control_volume": control_volume,
            "control_root": CONTROL_ROOT,
            "receipt_path": f"{CONTROL_ROOT}/{CONTROL_RECEIPT}",
            "build_log_path": f"{CONTROL_ROOT}/{CONTROL_BUILD_LOG}",
            "compose_file": str(compose_file),
            "compose_sha256": compose_sha256,
            "qualification": "NOT VERIFIED",
            "build_route": "direct-development" if direct_development else "fresh-host-enrollment",
            "compose_project": project_name,
            "source_inputs": manifest,
        }
        try:
            receipt["state"] = "building"
            write_control(repo, project_name, CONTROL_RECEIPT,
                          (json.dumps(receipt, indent=2, sort_keys=True) + "\n").encode())

            def persist_build_log(data, *, exit_code, truncated, interrupted,
                                  observation_budget_exceeded):
                receipt["build_log"] = {
                    "path": f"{CONTROL_ROOT}/{CONTROL_BUILD_LOG}",
                    "bytes": len(data),
                    "exit_code": exit_code,
                    "truncated": truncated,
                    "interrupted": interrupted,
                    "observation_budget_exceeded": observation_budget_exceeded,
                }
                write_control(repo, project_name, CONTROL_BUILD_LOG, data)

            build_command = [
                *docker_argv(*definitions),
                "build", "--pull=false", "--progress=plain", SERVICE,
            ]
            code, _build_output = docker_live(
                build_command,
                environment=compose_environment,
                output_sink=persist_build_log,
            )
            receipt["exit_code"] = code
            if code:
                raise BootstrapError(f"Toolchain build failed (exit {code}); cache and context retained")
            verify_capture(repo, manifest)
            observed = json.loads(docker("image", "inspect", service["image"], environment=compose_environment))
            if len(observed) != 1 or not re.fullmatch(r"sha256:[a-f0-9]{64}", observed[0].get("Id", "")):
                raise BootstrapError("Built image has no immutable image identity")
            immutable = observed[0]["Id"]
            receipt.update(state="reading_dependency_manifest", image=service["image"],
                           image_id=immutable,
                           manifest_probe_service=SERVICE)
            write_control(repo, project_name, CONTROL_RECEIPT,
                          (json.dumps(receipt, indent=2, sort_keys=True) + "\n").encode())
            raw_manifest = docker(
                *definitions, "run", "--rm", "--no-deps", "-T", "--pull", "never",
                "--entrypoint", "/bin/cat", SERVICE, DEPENDENCY_MANIFEST,
                environment=compose_environment,
            )
            manifest_bytes = raw_manifest.encode("utf-8")
            if len(manifest_bytes) > 2 * 1024 * 1024:
                raise BootstrapError("Built dependency manifest is too large")
            installed = json.loads(raw_manifest)
            if (not isinstance(installed, dict)
                    or installed.get("schema") != "fullmag.docker.fem-gpu-dependencies.v1"
                    or not isinstance(installed.get("build"), dict)
                    or installed["build"].get("phase") != "runtime"
                    or not isinstance(installed.get("actual"), dict)):
                raise BootstrapError("Built image lacks the runtime dependency manifest")
            manifest_path = f"{CONTROL_ROOT}/toolchain/dependency-versions.json"
            write_control(repo, project_name, "toolchain/dependency-versions.json", manifest_bytes)
            receipt.update(state="built", dependency_manifest=DEPENDENCY_MANIFEST,
                           installed_manifest=manifest_path,
                           installed_manifest_sha256=hashlib.sha256(manifest_bytes).hexdigest(),
                           next_step=("Start the direct Compose development services; GPU execution is not yet verified"
                                      if direct_development else
                                      "Configure one managed worker/coordinator; this image does not prove GPU execution"))
        except BaseException as error:
            uncertain = ((receipt["state"] == "building" and "exit_code" not in receipt)
                         or receipt["state"] == "reading_dependency_manifest")
            receipt.update(state="outcome_unknown_resources_retained" if uncertain else "failed_confirmed",
                           error=str(error))
            try:
                write_control(repo, project_name, CONTROL_RECEIPT,
                              (json.dumps(receipt, indent=2, sort_keys=True) + "\n").encode())
            except BaseException as receipt_error:
                print(f"Docker bootstrap: could not persist control receipt: {receipt_error}",
                      file=sys.stderr)
            raise
        finally:
            try:
                write_control(repo, project_name, CONTROL_RECEIPT,
                              (json.dumps(receipt, indent=2, sort_keys=True) + "\n").encode())
            except BaseException as receipt_error:
                print(f"Docker bootstrap: could not persist final control receipt: {receipt_error}",
                      file=sys.stderr)
            print(json.dumps({"receipt": receipt["receipt_path"], **receipt}, indent=2))
        return receipt


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--direct-development", action="store_true",
                        help="Build dependencies for the independent Compose development route")
    parser.add_argument("--prepare-development-images", action="store_true",
                        help="Prepare DEV wrappers in the same project without host staging")
    args = parser.parse_args(argv)
    try:
        if args.prepare_development_images and not args.direct_development:
            raise BootstrapError("Development wrappers require --direct-development")
        if args.direct_development:
            from docker_dev_host import require_host
            from docker_dev_defaults import resolve_defaults
            require_host()
            args.repo_root = resolve_defaults(args.repo_root).source_root
        receipt = build(args.repo_root, direct_development=args.direct_development)
        if args.prepare_development_images:
            from docker_build_control import BuildControl, build_volume_runtime_images
            from docker_compose_identity import compose_project_identity
            layout = storage.resolve_layout(args.repo_root, "docker-all-gpu")
            helper = receipt["inputs"]["build_args"]["FULLMAG_CUDA_BASE_IMAGE"]
            control = BuildControl(compose_project_identity(layout), helper)
            build_volume_runtime_images(args.repo_root, control, receipt)
    except (ValueError, storage.StorageError, OSError, subprocess.SubprocessError,
            BuildControlError) as error:
        parser.exit(2, f"Docker toolchain bootstrap: {error}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
