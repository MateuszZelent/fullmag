"""Docker-managed build control: no build files or logs are written on the host.

The host process only observes Git/configuration and invokes Docker. Short
image-owned helpers belong to the selected Compose project; they have no
network, Docker socket, host writes, or application execution responsibility.
"""
from __future__ import annotations

from contextlib import contextmanager
import errno
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import queue
import re
import shlex
import shutil
import subprocess
import sys
import threading
import time
import uuid

from docker_dev_host import docker_argv, local_volume, require_host, validate_host_path


MAX_DOCUMENT_BYTES = 8 * 1024 * 1024
MAX_LOG_BYTES = 32 * 1024 * 1024
MAX_ATTEMPTS = 64
MIN_FREE_BUILD_BYTES = 32 * 1024**3
LABEL_SCHEMA = "fullmag.build-control.v1"


class BuildControlError(RuntimeError):
    pass


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def control_read_script(path, maximum=MAX_DOCUMENT_BYTES):
    """Return the image-owned, bounded read probe for one control record.

    The parent chain is authenticated before the target is tested for
    existence.  This matters for optional reads: a dangling or replaced
    ``/control/<parent>`` must be an integrity failure, never an ordinary
    missing record (and therefore never a reason to continue a recovery
    transaction).  Only a genuinely absent, non-symlink target returns 44.
    """

    if (not isinstance(path, str) or not path.startswith("/control/")
            or not re.fullmatch(r"/control/[A-Za-z0-9_./-]+", path)):
        raise BuildControlError("Invalid control-volume absolute path")
    parsed = PurePosixPath(path)
    if (str(parsed) != path or ".." in parsed.parts
            or any(part in {"", "."} for part in parsed.parts[1:])):
        raise BuildControlError("Invalid control-volume absolute path")
    if type(maximum) is not int or maximum <= 0 or maximum > MAX_DOCUMENT_BYTES:
        raise BuildControlError("Invalid control-document byte budget")

    components = parsed.parts[2:]  # omit the root slash and ``control``
    checks = [
        "check_parent() { local p=\"$1\"; test ! -L \"$p\"; "
        "if test -e \"$p\"; then test -d \"$p\"; "
        "test \"$(readlink -f \"$p\")\" = \"$p\"; "
        "else exit 44; fi; }; "
        "check_parent /control;"
    ]
    parent = "/control"
    for component in components[:-1]:
        parent += "/" + component
        checks.append(f"check_parent {shlex.quote(parent)};")
    quoted = shlex.quote(path)
    checks.append(
        f"test ! -L {quoted}; test -e {quoted} || exit 44; "
        f"test -f {quoted}; test $(stat -c %h {quoted}) = 1; "
        f"head -c {maximum + 1} {quoted}"
    )
    return " ".join(checks)


_CONSOLE_DISCONNECT_ERRNOS = frozenset((errno.EBADF, errno.EINVAL))


def _quarantine_console(stream):
    """Keep interpreter shutdown from flushing a known-dead diagnostic stream."""

    sink = open(os.devnull, "w", encoding="utf-8")
    sys.stdout = sink
    if getattr(sys, "__stdout__", None) is stream:
        sys.__stdout__ = sink


def mirror_console(data):
    """Best-effort diagnostic output; durable control records stay authoritative."""

    stream = sys.stdout
    binary = getattr(stream, "buffer", None)
    if binary is None:
        target = stream
        payload = data.decode("utf-8", "replace") if isinstance(data, bytes) else data
    else:
        target = binary
        payload = data if isinstance(data, bytes) else data.encode("utf-8")
    try:
        target.write(payload)
        target.flush()
    except BrokenPipeError:
        _quarantine_console(stream)
        return False
    except OSError as error:
        if error.errno in _CONSOLE_DISCONNECT_ERRNOS:
            _quarantine_console(stream)
            return False
        raise
    return True


class ControlOutcomeUnknown(BuildControlError):
    """The client observation ended without proving a daemon-side outcome."""


def bounded_capture(command, *, data=None, timeout=90, env=None, maximum=MAX_DOCUMENT_BYTES):
    process = subprocess.Popen(command, stdin=subprocess.PIPE if data is not None else subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    lock = threading.Lock()
    exceeded = threading.Event()
    failures = []
    def drain(stream, key):
        try:
            while chunk := stream.read1(65536):
                with lock:
                    remaining = maximum - sum(len(value) for value in buffers.values())
                    buffers[key].extend(chunk[:remaining])
                    if len(chunk) > remaining:
                        exceeded.set()
                        return
        except OSError as error:
            failures.append(error)
    readers = [threading.Thread(target=drain, args=(stream, key), daemon=True)
               for stream, key in ((process.stdout, "stdout"), (process.stderr, "stderr"))]
    for reader in readers:
        reader.start()
    def send():
        try:
            process.stdin.write(data)
            process.stdin.close()
        except (OSError, ValueError) as error:
            failures.append(error)
    sender = None
    if data is not None:
        sender = threading.Thread(target=send, daemon=True)
        sender.start()
    deadline = time.monotonic() + timeout
    interrupted = False
    while process.poll() is None:
        if exceeded.wait(0.025) or time.monotonic() >= deadline:
            interrupted = True
            process.kill()  # Client only: this never claims the daemon stopped.
            break
    process.wait(timeout=5)
    for thread in [*readers, *([sender] if sender is not None else [])]:
        thread.join(timeout=1)
    for stream, reader in zip((process.stdout, process.stderr), readers):
        if not reader.is_alive():
            stream.close()
    if sender is not None and not sender.is_alive() and not process.stdin.closed:
        process.stdin.close()
    if interrupted or exceeded.is_set() or any(t.is_alive() for t in readers) or (sender and sender.is_alive()):
        raise ControlOutcomeUnknown("Docker observation exceeded its time/output budget; daemon resources retained")
    if failures and not process.returncode:
        raise ControlOutcomeUnknown("Docker control pipes did not complete; daemon resources retained")
    return subprocess.CompletedProcess(command, process.returncode, bytes(buffers["stdout"]), bytes(buffers["stderr"]))


def docker_capture(*args, data=None, timeout=90, allow_failure=False, env=None):
    result = bounded_capture(docker_argv(*args), data=data, timeout=timeout, env=env)
    if result.returncode and not allow_failure:
        raise BuildControlError(result.stderr.decode("utf-8", "replace").strip()
                                or result.stdout.decode("utf-8", "replace").strip())
    return result


def compose_capture(document, *args, timeout=90):
    return docker_capture("compose", "--project-name", document["name"], "-f", "-",
                          *args, data=canonical(document), timeout=timeout).stdout


def toolchain_configuration(repo, identity):
    from bootstrap_docker_toolchain import _compose_environment
    environment = {**os.environ, **_compose_environment(repo, identity["project_name"])}
    return json.loads(docker_capture("compose", "--project-name", identity["project_name"],
        "--project-directory", str(repo), "-f", str(Path(repo)/"compose.toolchain.yaml"),
        "--profile", "toolchain", "config", "--format", "json", env=environment).stdout)


class BuildControl:
    def __init__(self, identity, helper_image):
        self.identity = dict(identity)
        self.project = identity["project_name"]
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", self.project):
            raise BuildControlError("Invalid selected Compose project")
        if not re.fullmatch(r"[^\s]+@sha256:[0-9a-f]{64}|sha256:[0-9a-f]{64}", helper_image):
            raise BuildControlError("Build control requires an immutable helper image")
        self.image = helper_image
        from bootstrap_docker_toolchain import control_volume_name
        self.volume = control_volume_name(self.project)
        self.labels = {
            "org.fullmag.build-control.schema": LABEL_SCHEMA,
            "org.fullmag.compose.project": self.project,
            "org.fullmag.source.worktree-id": identity["worktree_id"],
            "org.fullmag.build.role": "control",
            "com.fullmag.compose.project": self.project,
            "com.fullmag.toolchain.control.schema": "fullmag.docker-toolchain-control.v1",
            "com.fullmag.toolchain.control.project": self.project,
            "com.fullmag.toolchain.control.mount": "/opt/fullmag/control",
        }

    @property
    def shared_labels(self):
        # Master bootstrap owns this shared volume; optional launcher labels
        # must not invalidate an existing canonical volume.
        return {key: value for key, value in self.labels.items() if key.startswith("com.fullmag.")}

    def prepare(self):
        observed = docker_capture("volume", "inspect", self.volume, allow_failure=True)
        if observed.returncode:
            # An absent exact volume is the only creation case. A daemon error
            # must not be interpreted as permission to replace existing data.
            names = docker_capture("volume", "ls", "--format", "{{.Name}}").stdout.decode().splitlines()
            if self.volume in names:
                raise BuildControlError("Existing control volume could not be inspected")
            args = ["volume", "create", "--driver", "local"]
            for name, value in self.labels.items():
                args.extend(["--label", name + "=" + value])
            docker_capture(*args, self.volume)
            observed = docker_capture("volume", "inspect", self.volume)
        documents = json.loads(observed.stdout)
        if len(documents) != 1:
            raise BuildControlError("Ambiguous control volume")
        volume = documents[0]
        if (volume.get("Name") != self.volume or volume.get("Driver") != "local"
                or volume.get("Options") or any((volume.get("Labels") or {}).get(k) != v
                                                for k, v in self.shared_labels.items())):
            raise BuildControlError("Control volume ownership/driver differs; existing data retained")
        initialize = ("test $(stat -c %u /control) = 0 -o $(stat -c %u /control) = 65532; "
            "chown 65532:65532 /control; chmod 0750 /control; "
            "for namespace in toolchain image-dev image-backend development iteration recreate-services resume verification frontend; do "
            "p=/control/$namespace; test ! -L \"$p\"; "
            "if test -e \"$p\"; then test -d \"$p\"; "
            "test $(stat -c %u \"$p\") = 0 -o $(stat -c %u \"$p\") = 65532; "
            "chown 65532:65532 \"$p\"; chmod 0750 \"$p\"; fi; done")
        result = bounded_capture(self.helper_args(initialize, initialize=True), data=b"", timeout=90)
        if result.returncode:
            raise BuildControlError("Control-volume permission initialization failed: " + result.stderr.decode("utf-8", "replace"))
        space = self.space()
        if min(space["available_bytes"], space.get("windows_backing_volume", {}).get("available_bytes", space["available_bytes"])) < MIN_FREE_BUILD_BYTES:
            raise BuildControlError("Docker build filesystem has less than 32 GiB free; existing data retained")
        return volume

    def space(self):
        result = bounded_capture(self.helper_args("df -Pk /control"), data=b"", timeout=60)
        if result.returncode:
            raise BuildControlError("Cannot measure Docker build filesystem")
        fields = result.stdout.decode("utf-8").strip().splitlines()[-1].split()
        if len(fields) < 6:
            raise BuildControlError("Docker filesystem measurement is incomplete")
        measurement = {"capacity_bytes": int(fields[-5]) * 1024,
                       "used_bytes": int(fields[-4]) * 1024,
                       "available_bytes": int(fields[-3]) * 1024,
                       "minimum_free_bytes": MIN_FREE_BUILD_BYTES,
                       "scope": "Docker VM filesystem; not a per-volume quota or Windows VHDX allocation"}
        if os.name == "nt":
            # Docker Desktop exposes its actual data disk here, including an
            # operator-configured junction. Resolve it before measuring the
            # backing Windows volume; sparse VHDX capacity is not host space.
            data_disk = (Path(os.environ["LOCALAPPDATA"]) / "Docker/wsl/disk").resolve(strict=True)
            from windows_folder_host import local_volume
            native = local_volume(data_disk)
            usage = shutil.disk_usage(data_disk)
            measurement["windows_backing_volume"] = {"data_disk_root": str(data_disk),
                "capacity_bytes": usage.total, "used_bytes": usage.used, "available_bytes": usage.free,
                "filesystem": native["host_filesystem"], "volume_serial": native["host_volume_serial"]}
        return measurement

    def volume_usage(self, name):
        if not re.fullmatch(r"[a-z0-9][a-z0-9_.-]*", name):
            raise BuildControlError("Invalid measurement volume")
        observed = json.loads(docker_capture("volume", "inspect", name).stdout)
        if len(observed) != 1 or observed[0].get("Driver") != "local" or observed[0].get("Options"):
            raise BuildControlError("Measurement requires an exact local named volume")
        labels = observed[0].get("Labels") or {}
        if (labels.get("org.fullmag.compose.project") != self.project
                and labels.get("com.fullmag.backend-cache.worktree-id") != self.identity["worktree_id"]
                and not (name == self.volume and all(labels.get(k) == v for k, v in self.shared_labels.items()))):
            raise BuildControlError("Measurement volume belongs to another source group")
        args = self.helper_args("du -x -sk /measure")
        args[args.index("--entrypoint"):args.index("--entrypoint")] = ["--mount",
            "type=volume,src=" + name + ",dst=/measure,readonly,volume-nocopy"]
        measured = bounded_capture(args, data=b"", timeout=120)
        if measured.returncode:
            raise BuildControlError("Volume usage measurement failed")
        return {"name": name, "allocated_bytes": int(measured.stdout.split()[0]) * 1024,
                "driver": observed[0]["Driver"], "labels": labels, "measured_at": time.time()}

    def helper_args(self, script, *, name=None, initialize=False):
        args = [*docker_argv("run"), "--rm", "-i",
                "--pull", "never", "--network", "none", "--runtime", "runc",
                "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
                "--pids-limit", "32", "--memory", "64m", "--cpus", "0.25",
                "--env", "NVIDIA_VISIBLE_DEVICES=void",
                "--mount", "type=volume,src=" + self.volume + ",dst=/control,volume-nocopy",
                "--label", "com.docker.compose.project=" + self.project,
                "--label", "com.docker.compose.service=build-control"]
        args.extend(["--user", "0:0" if initialize else "65532:65532"])
        if initialize:
            args.extend(["--cap-add", "CHOWN", "--cap-add", "FOWNER", "--cap-add", "DAC_OVERRIDE"])
        # Source labels authenticate this short-lived helper as part of the
        # selected group. Keep them separate from volume labels: adding a new
        # container proof must not invalidate an existing persistent cache.
        from docker_compose_identity import source_labels
        for key, value in {**self.labels, **source_labels(self.identity)}.items():
            args.extend(["--label", key + "=" + value])
        if name:
            args.extend(["--name", name])
        return [*args, "--entrypoint", "/bin/bash", self.image, "-euo", "pipefail", "-c", script]

    @staticmethod
    def path(relative):
        path = PurePosixPath(relative)
        if (not re.fullmatch(r"[a-zA-Z0-9_./-]+", str(path)) or path.is_absolute()
                or ".." in path.parts or str(path) == "."):
            raise BuildControlError("Invalid control-volume relative path")
        return "/control/" + str(path)

    def write(self, relative, value):
        self.write_bytes(relative, canonical(value) + b"\n")

    def write_bytes(self, relative, data):
        if not isinstance(data, bytes):
            raise BuildControlError("Control-volume files require explicit bytes")
        if len(data) > MAX_DOCUMENT_BYTES:
            raise BuildControlError("Control document exceeds its byte budget")
        path = self.path(relative)
        parent = str(PurePosixPath(path).parent)
        script = (f"umask 027; mkdir -p '{parent}'; "
                  f"test \"$(readlink -f '{parent}')\" = '{parent}'; test ! -L '{path}'; "
                  f"if test -e '{path}'; then test -f '{path}'; test $(stat -c %h '{path}') = 1; fi; "
                  f"t=$(mktemp '{parent}/.publish.XXXXXXXX'); "
                  "trap 'rm -f -- \"$t\"' EXIT; cat > \"$t\"; sync \"$t\"; "
                  f"mv -T -- \"$t\" '{path}'; sync '{parent}'")
        result = bounded_capture(self.helper_args(script), data=data, timeout=90)
        if result.returncode:
            raise BuildControlError(result.stderr.decode("utf-8", "replace"))

    def read(self, relative, *, optional=False):
        path = self.path(relative)
        script = control_read_script(path)
        result = bounded_capture(self.helper_args(script), data=b"", timeout=90)
        if optional and result.returncode == 44:
            return None
        if result.returncode:
            raise BuildControlError(result.stderr.decode("utf-8", "replace"))
        if len(result.stdout) > MAX_DOCUMENT_BYTES:
            raise BuildControlError("Control document exceeds its byte budget")
        return json.loads(result.stdout)

    @staticmethod
    def _line(process, timeout=90):
        messages = queue.Queue(maxsize=1)
        def read():
            messages.put(process.stdout.readline())
        threading.Thread(target=read, daemon=True).start()
        try:
            line = messages.get(timeout=timeout)
        except queue.Empty as error:
            raise BuildControlError("Control helper outcome unknown; named resources retained") from error
        if not line:
            raise BuildControlError("Control helper exited before acknowledging its durable lease")
        return line.decode("utf-8", "replace").strip()

    def operation_script(self, phase, token):
        """Return the image-owned lease protocol for one admitted operation.

        Keep this in one place so recovery can authenticate an already-running
        helper's command instead of reproducing a similar shell script.  The
        helper remains the only writer allowed to remove ``/control/active``.
        """
        if not re.fullmatch(r"[a-z][a-z0-9-]+", phase):
            raise BuildControlError("Invalid build phase")
        if not re.fullmatch(r"[0-9a-f]{32}", token):
            raise BuildControlError("Invalid operation token")
        path = self.path(f"{phase}/attempts/{token}")
        return ("umask 027; exec 9>/control/operation.lock; flock -n 9; "
                "test ! -e /control/active; "
                f"mkdir -p /control/{phase}/attempts; "
                f"test \"$(readlink -f /control/{phase}/attempts)\" = '/control/{phase}/attempts'; "
                f"test $(find /control/{phase}/attempts -mindepth 1 -maxdepth 1 -type d | wc -l) -lt {MAX_ATTEMPTS}; "
                f"mkdir '{path}'; printf '%s\\n' '{token}' > /control/active; "
                "sync /control; printf 'READY\\n'; "
                f"{{ head -c {MAX_LOG_BYTES}; cat > /dev/null; }} > '{path}/build.log'; "
                f"sync '{path}/build.log'; printf 'LOGGED\\n'; "
                f"until test -f '{path}/terminal.json'; do sleep 1; done; "
                "rm /control/active; sync /control")

    @contextmanager
    def operation(self, phase, inputs):
        if not re.fullmatch(r"[a-z][a-z0-9-]+", phase):
            raise BuildControlError("Invalid build phase")
        token = uuid.uuid4().hex
        root = f"{phase}/attempts/{token}"
        path = self.path(root)
        name = "fullmag-control-" + token
        # The advisory lease and durable active marker cover the entire daemon
        # operation. An interrupted host cannot silently free an unknown build.
        script = self.operation_script(phase, token)
        space_before = self.space()
        if min(space_before["available_bytes"], space_before.get("windows_backing_volume", {}).get("available_bytes", space_before["available_bytes"])) < MIN_FREE_BUILD_BYTES:
            raise BuildControlError("Docker build filesystem has less than 32 GiB free; admission refused")
        logger = subprocess.Popen(self.helper_args(script, name=name), stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        receipt = {"schema": "fullmag.docker-build-operation.v1", "phase": phase,
                   "state": "starting", "attempt": token, "compose_project": self.project,
                   "control_volume": self.volume, "helper_container": name,
                   "inputs": inputs, "started_at": time.time(),
                   "log_byte_limit": MAX_LOG_BYTES, "attempt_limit": MAX_ATTEMPTS,
                   "build_data_qualification": "NOT VERIFIED",
                   "filesystem_before": space_before}
        operation = {"receipt": receipt, "root": root, "logger": logger, "daemon_pending": False, "lease_ready": False}
        try:
            first = self._line(logger)
            if first != "READY":
                raise BuildControlError("Control helper admission failed: " + first)
            operation["lease_ready"] = True
            self.write(root + "/receipt.json", receipt)
            yield operation
        except BaseException as error:
            receipt.update(error=str(error), finished_at=time.time())
            if receipt.get("state") not in {"succeeded", "failed-confirmed"}:
                receipt["state"] = ("outcome-unknown-resources-retained" if operation["daemon_pending"] or isinstance(error, (ControlOutcomeUnknown, KeyboardInterrupt, SystemExit))
                                    else "failed-confirmed")
            if logger.stdin and not logger.stdin.closed:
                logger.stdin.close()
            # Unknown daemon outcomes deliberately retain the helper's lease.
            if operation["lease_ready"]:
                self.write(root + "/receipt.json", receipt)
            raise
        finally:
            if operation["lease_ready"] and receipt.get("state") in {"succeeded", "failed-confirmed"}:
                if logger.stdin and not logger.stdin.closed:
                    logger.stdin.close()
                if self._line(logger) != "LOGGED":
                    raise BuildControlError("Build log was not durably acknowledged")
                receipt["finished_at"] = time.time()
                receipt["filesystem_after"] = self.space()
                self.write(root + "/receipt.json", receipt)
                self.write(root + "/terminal.json", receipt)
                self.write(phase + "/current.json", receipt)
                if receipt["state"] == "succeeded":
                    self.write(phase + "/verified.json", receipt)
                if logger.wait(timeout=30) != 0:
                    raise BuildControlError("Control lease finalization failed")
            summary = {key: receipt[key] for key in ("phase", "state", "attempt", "compose_project",
                       "control_volume", "image_id", "cache_hit", "backend_package_cache_hit", "config_sha256", "url", "error") if key in receipt}
            mirror_console(json.dumps(summary, indent=2, ensure_ascii=False) + "\n")

    def build(self, operation, document, service):
        command = [*docker_argv("compose"), "--project-name",
                   self.project, "-f", "-", "build", service]
        operation["daemon_pending"] = True
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT)
        process.stdin.write(canonical(document))
        process.stdin.close()
        console_open = True
        try:
            while chunk := process.stdout.read1(65536):
                operation["logger"].stdin.write(chunk)
                operation["logger"].stdin.flush()
                if console_open:
                    console_open = mirror_console(chunk)
            code = process.wait()
        except BaseException:
            # Terminating this client would not prove BuildKit stopped. Retain
            # the durable active marker and lease for explicit reconciliation.
            raise
        operation["daemon_pending"] = False
        operation["receipt"]["exit_code"] = code
        if code:
            operation["receipt"]["state"] = "failed-confirmed"
            raise BuildControlError(f"Compose build failed (exit {code}); Docker data retained")
        return code


def build_volume_toolchain(repo):
    """Build the canonical dependency Dockerfile without host staging/receipts."""
    import fullmag_storage as storage
    from bootstrap_docker_toolchain import tracked_input_files, read_input, DEPENDENCY_MANIFEST
    from docker_compose_identity import compose_project_identity
    require_host()
    repo = validate_host_path(Path(repo).absolute(), "source checkout").resolve(strict=True)
    layout = storage.resolve_layout(repo, "docker-all-gpu")
    identity = compose_project_identity(layout)
    local_volume(repo)
    configured = toolchain_configuration(repo, identity)
    service = configured["services"]["fem-gpu-toolchain"]
    build = service["build"]
    if (configured.get("name") != identity["project_name"]
            or set(configured["services"]) != {"fem-gpu-toolchain"}
            or Path(build["context"]).resolve() != repo
            or build.get("dockerfile") != "docker/fem-gpu/Dockerfile"
            or build.get("target") != "fem-gpu-dev"):
        raise BuildControlError("Toolchain route/source/project differs from the canonical Compose contract")
    helper = build["args"]["FULLMAG_CUDA_BASE_IMAGE"]
    if not re.fullmatch(r"[^\s]+@sha256:[0-9a-f]{64}", helper):
        raise BuildControlError("CUDA bootstrap image must be pinned by digest")
    # Pull only the pinned bootstrap image through this checkout's project.
    probe_spec = {"name": identity["project_name"], "services": {"build-control": {
        "image": helper, "runtime": "runc", "environment": {"NVIDIA_VISIBLE_DEVICES": "void"}}}}
    if docker_capture("image", "inspect", helper, allow_failure=True).returncode:
        compose_capture(probe_spec, "pull", "build-control", timeout=1800)
    control = BuildControl(identity, helper)
    control.prepare()

    def inputs():
        return [{"path": p.as_posix(), "sha256": hashlib.sha256(read_input(repo, p)).hexdigest()}
                for p in tracked_input_files(repo)]

    manifest = inputs()
    eligible = {entry["path"] for entry in manifest}
    from bootstrap_docker_toolchain import input_files
    if {path.as_posix() for path in input_files(repo)} != eligible:
        raise BuildControlError("Untracked dependency inputs require explicit Git staging before build")
    source_identity = {"source_inputs": manifest, "build_args": build.get("args", {}),
                       "target": build["target"]}
    digest = hashlib.sha256(canonical(source_identity)).hexdigest()
    service["image"] = "fullmag/fem-gpu-toolchain:inputs-" + digest[:24]
    with control.operation("toolchain", source_identity) as operation:
        operation["receipt"].update(state="building", source_commit=storage.git(repo, "rev-parse", "HEAD"),
                                    source_digest=digest)
        control.write(operation["root"] + "/compose.json", configured)
        previous = (control.read("toolchain/verified.json", optional=True)
                    or control.read("toolchain/current.json", optional=True))
        cached = (isinstance(previous, dict) and previous.get("state") == "succeeded"
                  and previous.get("source_digest") == digest
                  and previous.get("compose_project") == identity["project_name"]
                  and re.fullmatch(r"sha256:[0-9a-f]{64}", previous.get("image_id", "")))
        if cached:
            cached = not docker_capture("image", "inspect", previous["image_id"], allow_failure=True).returncode
        operation["receipt"]["cache_hit"] = bool(cached)
        if not cached:
            control.build(operation, configured, "fem-gpu-toolchain")
        if inputs() != manifest:
            raise BuildControlError("Dependency inputs changed during BuildKit build")
        image = json.loads(docker_capture("image", "inspect", previous["image_id"] if cached else service["image"]).stdout)
        if len(image) != 1 or not re.fullmatch(r"sha256:[0-9a-f]{64}", image[0].get("Id", "")):
            raise BuildControlError("Toolchain has no immutable image identity")
        # The image-owned manifest is observed through an isolated helper;
        # its only durable copy outside the image belongs to the control volume.
        args = control.helper_args("cat '" + DEPENDENCY_MANIFEST + "'")
        args[args.index(control.image)] = image[0]["Id"]
        installed_run = bounded_capture(args, data=b"", timeout=90)
        if installed_run.returncode or len(installed_run.stdout) > MAX_DOCUMENT_BYTES:
            raise BuildControlError("Built toolchain dependency manifest could not be read")
        installed = json.loads(installed_run.stdout)
        if (installed.get("schema") != "fullmag.docker.fem-gpu-dependencies.v1"
                or installed.get("build", {}).get("phase") != "runtime"
                or not installed.get("actual", {}).get("source_commits")):
            raise BuildControlError("Built dependency manifest is incomplete")
        control.write("toolchain/dependency-versions.json", installed)
        operation["receipt"].update(state="succeeded", image=service["image"], image_id=image[0]["Id"],
                                    installed_manifest_sha256=hashlib.sha256(installed_run.stdout).hexdigest(),
                                    manifest_path="toolchain/dependency-versions.json",
                                    source_digest=digest, compose_project=identity["project_name"])
    return operation["receipt"]


def build_volume_runtime_images(repo, control, toolchain):
    """Prepare trusted wrapper layers through this project's BuildKit only."""
    from docker_dev import BASE_CONTEXT_FILES, RUNTIME_IMAGE_CONTEXT_FILES
    from bootstrap_docker_toolchain import read_input
    require_host()
    repo = validate_host_path(Path(repo).absolute(), "source checkout").resolve(strict=True)
    parent = toolchain["image_id"]
    results = {}
    for kind, inventory in (("dev", BASE_CONTEXT_FILES), ("backend", RUNTIME_IMAGE_CONTEXT_FILES)):
        if any((repo / name).exists() for name, _ in inventory):
            raise BuildControlError("Unexpected flat helper at checkout root; DEV context must use canonical helper paths")
        names = sorted({relative for _, relative in inventory}
                       | {f"docker/all-in-one/Dockerfile.{kind}.dockerignore"})
        def inputs():
            return [{"path": name, "sha256": hashlib.sha256(read_input(repo, name)).hexdigest()}
                    for name in names]
        manifest = inputs()
        identity = {"parent_image_id": parent, "files": manifest}
        digest = hashlib.sha256(canonical(identity)).hexdigest()
        tag = "fullmag/development-" + kind + ":inputs-" + digest[:24]
        parent_ref = "fullmag/" + control.project + "-base:sha-" + parent.removeprefix("sha256:")
        arguments = {"FULLMAG_DOCKER_HELPERS": "docker/all-in-one/"}
        if kind == "dev":
            arguments.update(RUNTIME_BASE=parent_ref, FULLMAG_TOOLCHAIN_IMAGE_ID=parent,
                             FULLMAG_SCRIPT_HELPERS="scripts/")
        else:
            arguments["DEV_BASE"] = parent_ref
        document = {"name": control.project, "services": {"image-" + kind: {
            "image": tag, "build": {"context": str(repo),
            "dockerfile": "docker/all-in-one/Dockerfile." + kind, "args": arguments,
            "labels": {"org.fullmag.compose.project": control.project,
                       "org.fullmag.build.input-digest": digest}}}}}
        with control.operation("image-" + kind, identity) as operation:
            # FROM accepts a named local reference, not Docker's raw image ID.
            # The group lease protects this content-derived alias; attest it
            # before and after BuildKit rather than trusting a mutable tag.
            docker_capture("image", "tag", parent, parent_ref)
            if json.loads(docker_capture("image", "inspect", parent_ref).stdout)[0]["Id"] != parent:
                raise BuildControlError("BuildKit parent alias does not match the pinned image")
            control.write(operation["root"] + "/compose.json", document)
            previous = (control.read("image-" + kind + "/verified.json", optional=True)
                        or control.read("image-" + kind + "/current.json", optional=True))
            cached = (isinstance(previous, dict) and previous.get("state") == "succeeded"
                      and previous.get("source_digest") == digest
                      and previous.get("compose_project") == control.project
                      and re.fullmatch(r"sha256:[0-9a-f]{64}", previous.get("image_id", "")))
            if cached:
                cached = not docker_capture("image", "inspect", previous["image_id"], allow_failure=True).returncode
            operation["receipt"].update(state="building", cache_hit=bool(cached))
            if not cached:
                control.build(operation, document, "image-" + kind)
            if (inputs() != manifest
                    or json.loads(docker_capture("image", "inspect", parent_ref).stdout)[0]["Id"] != parent):
                raise BuildControlError("Runtime image inputs changed during BuildKit build")
            image = json.loads(docker_capture("image", "inspect", previous["image_id"] if cached else tag).stdout)
            if len(image) != 1 or not re.fullmatch(r"sha256:[0-9a-f]{64}", image[0].get("Id", "")):
                raise BuildControlError("Runtime image has no immutable identity")
            labels = image[0].get("Config", {}).get("Labels", {})
            if (labels.get("org.fullmag.compose.project") != control.project
                    or labels.get("org.fullmag.build.input-digest") != digest):
                raise BuildControlError("Runtime image source labels differ")
            parent = image[0]["Id"]
            operation["receipt"].update(state="succeeded", source_digest=digest, image=tag,
                                        image_id=parent)
        results[kind] = operation["receipt"]
    return results
