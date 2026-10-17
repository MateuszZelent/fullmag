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
import threading
import time
import uuid

import fullmag_storage as storage

PROFILE = "docker-all-gpu"
SERVICE = "fem-gpu-toolchain"
MAX_INPUT_BYTES = 16 * 1024 * 1024
DEPENDENCY_MANIFEST = "/opt/fullmag-deps/share/fullmag/dependency-versions.json"


class BootstrapError(ValueError):
    pass


def assert_fresh_host(root):
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
    assert_bootstrap_reconciled(root)
    database = storage.validate_path(root / "index/runner-jobs.sqlite", root)
    if os.path.lexists(database):
        # Even an idle queue proves prior enrollment. Do not infer that it is
        # safe to bypass its owner from a missing config or an empty active set.
        raise BootstrapError("An existing build queue requires managed maintenance; bootstrap refused")


def assert_bootstrap_reconciled(root):
    """A previous unknown Docker outcome requires reconciliation in either mode."""
    root = Path(root)
    admission = storage.validate_path(root / "index/docker-toolchain-bootstrap.json", root)
    if os.path.lexists(admission):
        previous = json.loads(read_input(root, Path("index/docker-toolchain-bootstrap.json")))
        if (not isinstance(previous, dict)
                or previous.get("schema") != "fullmag.docker-toolchain-bootstrap.v1"
                or previous.get("state") not in {"built", "failed_confirmed"}):
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
    required = {Path(".dockerignore"), Path("compose.toolchain.yaml"),
                Path("docker/fem-gpu/Dockerfile")}
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


def capture_inputs(repo, destination):
    """Freeze dependency files only; never copy .env, Git state or application code."""
    names = tracked_input_files(repo)
    manifest = []
    for relative in names:
        data = read_input(repo, relative)
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        manifest.append({"path": relative.as_posix(), "sha256": hashlib.sha256(data).hexdigest()})
    if tracked_input_files(repo) != names:
        raise BootstrapError("Tracked dependency context changed during capture")
    for entry in manifest:
        if hashlib.sha256(read_input(repo, entry["path"])).hexdigest() != entry["sha256"]:
            raise BootstrapError("Dependency input changed during capture: " + entry["path"])
    return manifest


def verify_capture(destination, manifest):
    if input_files(destination) != [Path(entry["path"]) for entry in manifest]:
        raise BootstrapError("Frozen dependency file inventory changed")
    for entry in manifest:
        if hashlib.sha256(read_input(destination, entry["path"])).hexdigest() != entry["sha256"]:
            raise BootstrapError("Frozen dependency input changed: " + entry["path"])


def bounded_command(command, *, maximum=2 * 1024 * 1024, timeout=90):
    """Bound both pipe streams while reading, including on native Windows."""
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
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


def docker(*args):
    return bounded_command(["docker", "--context", "desktop-linux", *args])



def initialize_host_storage(layout, volume_probe):
    """Admit the existing volume before creating the operator-selected root."""
    root = Path(layout["storage_root"])
    ancestor = root
    while not os.path.lexists(ancestor):
        ancestor = ancestor.parent
    volume_probe(ancestor)
    storage.initialize(layout)
    volume_probe(root)


def compose_project(layout, *, direct_development=False):
    """Bind development dependency builds to the registered checkout group."""
    if not direct_development:
        return "fullmag-toolchain"
    from docker_compose_identity import compose_project_identity
    return compose_project_identity(layout)["project_name"]


def build(repo, *, direct_development=False):
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
    admission_check = assert_bootstrap_reconciled if direct_development else assert_fresh_host
    admission_check(root)
    lock = storage.validate_path(root / "locks/fullmag-heavy.lock", root)
    # Hold the same durable host slot through capture, Docker and inspection.
    with storage.file_lock(lock, "Docker dependency toolchain build"):
        admission_check(root)
        run = storage.validate_path(Path(layout["runs_root"]) / ("toolchain-bootstrap-" + uuid.uuid4().hex),
                                    layout["build_storage_root"])
        run.mkdir(mode=0o700)
        context = run / "context"
        context.mkdir(mode=0o700)
        receipt_path = run / "receipt.json"
        admission_path = root / "index/docker-toolchain-bootstrap.json"
        receipt = {"schema": "fullmag.docker-toolchain-bootstrap.v1", "state": "capturing",
                   "repo_root": str(repo), "worktree_id": layout["worktree_id"],
                   "source_commit": storage.git(repo, "rev-parse", "HEAD"),
                   "context_root": str(context), "receipt_path": str(receipt_path),
                   "qualification": "NOT VERIFIED",
                   "build_route": "direct-development" if direct_development else "fresh-host-enrollment",
                   "compose_project": project_name}
        storage.atomic_json(receipt_path, receipt)
        storage.atomic_json(admission_path, receipt)
        try:
            manifest = capture_inputs(repo, context)
            receipt["source_inputs"] = manifest
            definitions = ["compose", "--project-name", project_name, "--project-directory", str(context), "-f",
                           str(context / "compose.toolchain.yaml"), "--profile", "toolchain"]
            configured = json.loads(docker(*definitions, "config", "--format", "json"))
            if configured.get("name") != project_name:
                raise BootstrapError("Dependency Compose lost the selected checkout project")
            if set(configured.get("services", {})) != {SERVICE}:
                raise BootstrapError("Unexpected dependency Compose services")
            service = configured["services"][SERVICE]
            if (service.get("build", {}).get("target") != "fem-gpu-dev"
                    or service.get("build", {}).get("dockerfile") != "docker/fem-gpu/Dockerfile"
                    or Path(service["build"]["context"]).resolve() != context.resolve()):
                raise BootstrapError("Dependency Compose changed the canonical Dockerfile/context/target")
            spec = run / "compose.json"
            storage.atomic_json(spec, configured)
            receipt.update(state="building", compose_file=str(spec),
                           compose_sha256=hashlib.sha256(spec.read_bytes()).hexdigest())
            storage.atomic_json(receipt_path, receipt)
            storage.atomic_json(admission_path, receipt)
            code = storage.run(layout, ["docker", "--context", "desktop-linux", "compose", "--project-name", project_name, "-f", str(spec),
                                        "--profile", "toolchain", "build", SERVICE])
            receipt["exit_code"] = code
            if code:
                raise BootstrapError(f"Toolchain build failed (exit {code}); cache and context retained")
            verify_capture(context, manifest)
            observed = json.loads(docker("image", "inspect", service["image"]))
            if len(observed) != 1 or not re.fullmatch(r"sha256:[a-f0-9]{64}", observed[0].get("Id", "")):
                raise BootstrapError("Built image has no immutable image identity")
            immutable = observed[0]["Id"]
            probe_name = "fullmag-toolchain-manifest-" + uuid.uuid4().hex
            receipt.update(state="reading_dependency_manifest", image=service["image"],
                           image_id=immutable, manifest_probe_container=probe_name)
            storage.atomic_json(receipt_path, receipt)
            storage.atomic_json(admission_path, receipt)
            raw_manifest = docker("run", "--rm", "--name", probe_name,
                                  "--label", "com.docker.compose.project=" + project_name,
                                  "--label", "com.docker.compose.service=toolchain-manifest-probe",
                                  "--network", "none",
                                  "--runtime", "runc", "--read-only", "--cap-drop", "ALL",
                                  "--security-opt", "no-new-privileges:true", "--user", "65532:65532",
                                  "--pids-limit", "16", "--memory", "64m", "--cpus", "0.25",
                                  "--env", "NVIDIA_VISIBLE_DEVICES=void", "--entrypoint", "/bin/cat",
                                  immutable, DEPENDENCY_MANIFEST)
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
            manifest_path = run / "dependency-versions.json"
            with manifest_path.open("xb") as stream:
                stream.write(manifest_bytes)
                stream.flush()
                os.fsync(stream.fileno())
            receipt.update(state="built", dependency_manifest=DEPENDENCY_MANIFEST,
                           installed_manifest=str(manifest_path),
                           installed_manifest_sha256=hashlib.sha256(manifest_bytes).hexdigest(),
                           next_step=("Start the direct Compose development services; GPU execution is not yet verified"
                                      if direct_development else
                                      "Configure one managed worker/coordinator; this image does not prove GPU execution"))
        except BaseException as error:
            uncertain = ((receipt["state"] == "building" and "exit_code" not in receipt)
                         or receipt["state"] == "reading_dependency_manifest")
            receipt.update(state="outcome_unknown_resources_retained" if uncertain else "failed_confirmed",
                           error=str(error))
            raise
        finally:
            storage.atomic_json(receipt_path, receipt)
            storage.atomic_json(admission_path, receipt)
            print(json.dumps({"receipt": str(receipt_path), **receipt}, indent=2))
        return receipt


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--direct-development", action="store_true",
                        help="Build dependencies for the independent Compose development route")
    args = parser.parse_args(argv)
    try:
        build(args.repo_root, direct_development=args.direct_development)
    except (BootstrapError, storage.StorageError, OSError, subprocess.SubprocessError) as error:
        parser.exit(2, f"Docker toolchain bootstrap: {error}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
