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
# A cache-only operation can retain one bounded log and up to six bounded
# control documents per attempt. Keep room for a conservative retry window,
# while leaving the 32 GiB reserve unchanged for any Docker build or pull.
CACHE_CONTROL_ATTEMPT_WINDOW = MAX_ATTEMPTS // 4
CACHE_CONTROL_DOCUMENTS_PER_ATTEMPT = 6
MIN_FREE_CONTROL_BYTES = CACHE_CONTROL_ATTEMPT_WINDOW * (
    MAX_LOG_BYTES + CACHE_CONTROL_DOCUMENTS_PER_ATTEMPT * MAX_DOCUMENT_BYTES
)
CACHE_ONLY_PHASES = frozenset(("toolchain", "image-dev", "image-backend", "cache-maintenance", "cache-retirement"))
LABEL_SCHEMA = "fullmag.build-control.v1"


class BuildControlError(RuntimeError):
    pass


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _available_space(space):
    available = space["available_bytes"]
    backing = space.get("windows_backing_volume")
    if backing is not None:
        available = min(available, backing["available_bytes"])
    return available


def _assert_free_space(space, minimum, detail):
    if _available_space(space) < minimum:
        if minimum == MIN_FREE_BUILD_BYTES:
            label = "32 GiB"
        else:
            label = f"{minimum // (1024 ** 2)} MiB"
        raise BuildControlError(
            f"Docker build filesystem has less than {label} free; {detail}"
        )


def _exact_local_image_id(reference, expected):
    observed = docker_capture("image", "inspect", reference, allow_failure=True)
    if observed.returncode:
        return False
    try:
        documents = json.loads(observed.stdout)
    except (TypeError, ValueError):
        return False
    return (len(documents) == 1 and documents[0].get("Id") == expected)


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
    # Identify the failing control step without logging command arguments,
    # stdin, or environment values (which may contain private runtime data).
    caller = sys._getframe(1).f_code.co_name
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
        raise ControlOutcomeUnknown(
            f"Docker observation exceeded its time/output budget during {caller} "
            f"(timeout={timeout}s); daemon resources retained"
        )
    if failures and not process.returncode:
        raise ControlOutcomeUnknown("Docker control pipes did not complete; daemon resources retained")
    return subprocess.CompletedProcess(command, process.returncode, bytes(buffers["stdout"]), bytes(buffers["stderr"]))


def docker_capture(*args, data=None, timeout=90, allow_failure=False, env=None):
    result = bounded_capture(docker_argv(*args), data=data, timeout=timeout, env=env)
    if result.returncode and not allow_failure:
        raise BuildControlError(result.stderr.decode("utf-8", "replace").strip()
                                or result.stdout.decode("utf-8", "replace").strip())
    return result


def docker_text(*args, timeout=90, combined=False):
    """Run one bounded Docker observation and decode its output."""

    result = docker_capture(*args, timeout=timeout)
    return (result.stdout + (result.stderr if combined else b"")).decode("utf-8", "replace")


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
        self.namespace = ""
        self.namespace_registry = None
        self.namespace_registry_sha256 = None
        self._active_operation = None
        from docker_control_namespace import resolve_namespace
        resolve_namespace(self)

    def subpath(self, relative=""):
        if relative:
            self.path(relative)
        return "/".join(value for value in (self.namespace, relative) if value)

    @property
    def shared_labels(self):
        # Master bootstrap owns this shared volume; optional launcher labels
        # must not invalidate an existing canonical volume.
        return {key: value for key, value in self.labels.items() if key.startswith("com.fullmag.")}

    def prepare(self, *, minimum_free_bytes=MIN_FREE_BUILD_BYTES):
        if type(minimum_free_bytes) is not int or minimum_free_bytes < MIN_FREE_CONTROL_BYTES:
            raise BuildControlError("Invalid build-space admission for control preparation")
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
        _assert_free_space(space, minimum_free_bytes, "existing data retained")
        return volume

    @staticmethod
    def _windows_backing_volume():
        if os.name != "nt":
            return None
        # Docker Desktop exposes its actual data disk here, including an
        # operator-configured junction; sparse VHDX capacity is not host space.
        data_disk = (Path(os.environ["LOCALAPPDATA"]) / "Docker/wsl/disk").resolve(strict=True)
        from windows_folder_host import local_volume
        native = local_volume(data_disk)
        usage = shutil.disk_usage(data_disk)
        return {"data_disk_root": str(data_disk),
                "capacity_bytes": usage.total, "used_bytes": usage.used,
                "available_bytes": usage.free, "filesystem": native["host_filesystem"],
                "volume_serial": native["host_volume_serial"]}

    def assert_windows_pre_pull_space(self):
        """Guard physical Docker Desktop storage before a cold helper pull.

        Linux/WSL cannot observe the Docker VM filesystem before its first
        helper image exists; the existing cold pull order is retained there.
        """
        backing = self._windows_backing_volume()
        if backing is not None:
            _assert_free_space({"available_bytes": backing["available_bytes"]},
                               MIN_FREE_BUILD_BYTES, "cold helper pull admission refused")

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
        backing = self._windows_backing_volume()
        if backing is not None:
            measurement["windows_backing_volume"] = backing
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
        mount = "type=volume,src=" + self.volume + ",dst=/control,volume-nocopy"
        if self.namespace:
            mount += ",volume-subpath=" + self.namespace
            script = self._namespace_guard(script)
        args = [*docker_argv("run"), "--rm", "-i",
                "--pull", "never", "--network", "none", "--runtime", "runc",
                "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
                "--pids-limit", "32", "--memory", "64m", "--cpus", "0.25",
                "--env", "NVIDIA_VISIBLE_DEVICES=void",
                "--mount", mount,
                "--label", "com.docker.compose.project=" + self.project,
                "--label", "com.docker.compose.service=build-control"]
        if self.namespace:
            args.extend(["--mount", "type=volume,src=" + self.volume
                         + ",dst=/registry,readonly,volume-nocopy"])
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

    def _namespace_guard(self, script):
        if not self.namespace:
            return script
        return ("test \"$(sha256sum /registry/namespaces/current.json | cut -d' ' -f1)\" = '"
                + self.namespace_registry_sha256 + "'; " + script)

    def _inspect_operation_helper(self, operation, *, expected_id=None):
        receipt = operation.get("receipt") if isinstance(operation, dict) else None
        attempt = receipt.get("attempt") if isinstance(receipt, dict) else None
        name = receipt.get("helper_container") if isinstance(receipt, dict) else None
        if (not isinstance(attempt, str) or not re.fullmatch(r"[0-9a-f]{32}", attempt)
                or name != "fullmag-control-" + attempt):
            raise ControlOutcomeUnknown("Active operation has no exact control-helper identity")
        target = expected_id or name
        try:
            rows = json.loads(docker_capture("inspect", target, timeout=60).stdout)
        except Exception as error:
            raise ControlOutcomeUnknown(
                "Active operation control-helper observation failed; resources retained"
            ) from error
        if not isinstance(rows, list) or len(rows) != 1:
            raise ControlOutcomeUnknown("Active operation control helper is ambiguous; resources retained")
        row = rows[0]
        identifier = row.get("Id") if isinstance(row, dict) else None
        config = row.get("Config") if isinstance(row, dict) else None
        labels = config.get("Labels") if isinstance(config, dict) else None
        state = row.get("State") if isinstance(row, dict) else None
        host = row.get("HostConfig") if isinstance(row, dict) else None
        expected_labels = {
            "com.docker.compose.project": self.project,
            "com.docker.compose.service": "build-control",
            **self.labels,
        }
        from docker_compose_identity import source_labels
        expected_labels.update(source_labels(self.identity))
        if (not isinstance(identifier, str) or not re.fullmatch(r"[0-9a-f]{64}", identifier)
                or (expected_id is not None and identifier != expected_id)
                or row.get("Name") != "/" + name
                or not isinstance(config, dict) or config.get("Image") != self.image
                or config.get("Entrypoint") != ["/bin/bash"]
                or config.get("User") != "65532:65532"
                or not isinstance(labels, dict)
                or any(labels.get(key) != value for key, value in expected_labels.items())
                or not isinstance(state, dict) or state.get("Running") is not True
                or type(state.get("Pid")) is not int or state["Pid"] <= 0
                or not isinstance(host, dict) or host.get("NetworkMode") != "none"):
            raise ControlOutcomeUnknown(
                "Active operation control helper no longer matches its pinned identity; resources retained"
            )
        mounts = row.get("Mounts")
        control_mounts = [mount for mount in mounts if isinstance(mount, dict)
                          and mount.get("Destination") == "/control"] if isinstance(mounts, list) else []
        expected_mount_count = 2 if self.namespace else 1
        if (not isinstance(mounts, list) or len(mounts) != expected_mount_count
                or len(control_mounts) != 1 or control_mounts[0].get("Type") != "volume"
                or control_mounts[0].get("Name") != self.volume
                or control_mounts[0].get("RW") is not True):
            raise ControlOutcomeUnknown(
                "Active operation control helper has a different control-volume mount; resources retained"
            )
        if self.namespace:
            registry_mounts = [mount for mount in mounts if isinstance(mount, dict)
                               and mount.get("Destination") == "/registry"] if isinstance(mounts, list) else []
            if (len(registry_mounts) != 1 or registry_mounts[0].get("Type") != "volume"
                    or registry_mounts[0].get("Name") != self.volume
                    or registry_mounts[0].get("RW") is not False):
                raise ControlOutcomeUnknown(
                    "Active operation control helper has a different namespace-registry mount; resources retained"
                )
        host_mounts = host.get("Mounts")
        if not isinstance(host_mounts, list) or len(host_mounts) != expected_mount_count:
            raise ControlOutcomeUnknown(
                "Active operation helper HostConfig mounts are incomplete; resources retained"
            )
        if host.get("Binds") not in (None, []) or host.get("Tmpfs") not in (None, {}):
            raise ControlOutcomeUnknown(
                "Active operation helper has an unexpected additional mount; resources retained"
            )
        expected_targets = {"/control": (False, self.namespace or None)}
        if self.namespace:
            expected_targets["/registry"] = (True, None)
        for mount in host_mounts:
            if not isinstance(mount, dict):
                raise ControlOutcomeUnknown("Active operation helper mount is malformed; resources retained")
            target_path = mount.get("Target")
            expected = expected_targets.get(target_path)
            options = mount.get("VolumeOptions")
            expected_read_only, expected_subpath = expected if expected is not None else (None, None)
            actual_subpath = options.get("Subpath") if isinstance(options, dict) else None
            actual_read_only = mount["ReadOnly"] if "ReadOnly" in mount else False
            if (expected is None or mount.get("Type") != "volume"
                    or mount.get("Source") != self.volume
                    or type(actual_read_only) is not bool
                    or actual_read_only is not expected_read_only
                    or not isinstance(options, dict) or options.get("NoCopy") is not True
                    or actual_subpath != expected_subpath):
                raise ControlOutcomeUnknown(
                    "Active operation helper HostConfig mount differs from its pinned namespace; resources retained"
                )
        command = config.get("Cmd")
        phase = receipt.get("phase")
        expected_command = [
            "-euo", "pipefail", "-c",
            self._namespace_guard(self.operation_script(phase, attempt)),
        ] if isinstance(phase, str) else None
        if command != expected_command:
            raise ControlOutcomeUnknown(
                "Active operation control helper command no longer matches its lease; resources retained"
            )
        return identifier

    def _pin_operation_helper(self, operation):
        logger = operation.get("logger")
        if not operation.get("lease_ready") or logger is None or logger.poll() is not None:
            raise ControlOutcomeUnknown("Control helper exited before its lease identity was pinned")
        identifier = self._inspect_operation_helper(operation)
        if logger.poll() is not None:
            raise ControlOutcomeUnknown("Control helper logger exited while its identity was pinned")
        operation["helper_container_id"] = identifier
        return identifier

    def _assert_live_operation_helper(self, operation):
        if self._active_operation is not operation:
            raise ControlOutcomeUnknown("No active control-helper lease is available; resources retained")
        logger = operation.get("logger")
        if logger is None or logger.poll() is not None:
            raise ControlOutcomeUnknown("Active operation logger exited; resources retained")
        identifier = operation.get("helper_container_id")
        if not isinstance(identifier, str):
            raise ControlOutcomeUnknown("Active operation helper ID is not pinned; resources retained")
        if not re.fullmatch(r"[0-9a-f]{64}", identifier):
            raise ControlOutcomeUnknown("Active operation helper ID pin is malformed; resources retained")
        return identifier

    def _read_control_bytes_from_operation(self, operation, path, maximum, timeout):
        identifier = self._assert_live_operation_helper(operation)
        script = self._namespace_guard(control_read_script(path, maximum))
        command = [*docker_argv("exec"), "--user", "65532:65532", identifier,
                   "/bin/bash", "-euo", "pipefail", "-c", script]
        try:
            result = bounded_capture(
                command, timeout=timeout, maximum=maximum + 64 * 1024
            )
        except BaseException as error:
            try:
                self._assert_live_operation_helper(operation)
            except BaseException as status_error:
                raise ControlOutcomeUnknown(
                    "Control read failed and the pinned helper state is no longer observable; resources retained: "
                    + str(error)
                ) from error
            raise
        else:
            # A failed exec observation never falls back to a fresh helper.
            self._assert_live_operation_helper(operation)
        return result

    def read_bytes(self, relative, *, optional=False, maximum=MAX_DOCUMENT_BYTES, timeout=90):
        path = self.path(relative)
        script = control_read_script(path, maximum)
        operation = self._active_operation
        if operation is None:
            result = bounded_capture(
                self.helper_args(script), data=b"", timeout=timeout,
                maximum=maximum + 64 * 1024,
            )
        else:
            result = self._read_control_bytes_from_operation(operation, path, maximum, timeout)
        if optional and result.returncode == 44:
            return None
        if result.returncode:
            raise BuildControlError(
                result.stderr.decode("utf-8", "replace")[-1024:]
                or "Control-volume read failed"
            )
        raw = bytes(result.stdout)
        if len(raw) > maximum:
            raise BuildControlError("Control document exceeds its byte budget")
        return raw

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
        raw = self.read_bytes(relative, optional=optional)
        if raw is None:
            return None
        return json.loads(raw)

    def read_pinned_resume_evidence(
        self,
        parent_attempt: str,
        config_sha256: str,
        backend_started_at: str,
        helper_image: str,
    ) -> dict[str, object]:
        from docker_volume_pre_admission_selector import read_pinned_resume_evidence

        return read_pinned_resume_evidence(
            self,
            parent_attempt=parent_attempt,
            config_sha256=config_sha256,
            backend_started_at=backend_started_at,
            helper_image=helper_image,
        )

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
        admission = "umask 027; exec 9>/control/operation.lock; flock -n 9; "
        if self.namespace:
            admission = ("umask 027; exec 9</registry/operation.lock; flock -n 9; "
                         "test \"$(stat -c '%d:%i' /control/operation.lock)\" = "
                         "\"$(stat -c '%d:%i' /registry/operation.lock)\"; "
                         "test \"$(sha256sum /registry/namespaces/current.json | cut -d' ' -f1)\" = '"
                         + self.namespace_registry_sha256 + "'; ")
        if phase != "cache-retirement":
            admission += "test ! -e /control/cache-retirement/closing.json; test ! -L /control/cache-retirement/closing.json; "
        return (admission +
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

    def require_build_space(self, *, operation=None):
        """Take a fresh full-reserve measurement immediately before BuildKit."""
        space = self.space()
        if operation is not None:
            operation["receipt"]["filesystem_before_build"] = space
        _assert_free_space(space, MIN_FREE_BUILD_BYTES, "admission refused")
        return space

    @contextmanager
    def operation(self, phase, inputs, *, minimum_free_bytes=MIN_FREE_BUILD_BYTES):
        if not re.fullmatch(r"[a-z][a-z0-9-]+", phase):
            raise BuildControlError("Invalid build phase")
        if (type(minimum_free_bytes) is not int
                or minimum_free_bytes < MIN_FREE_CONTROL_BYTES
                or (minimum_free_bytes < MIN_FREE_BUILD_BYTES
                    and phase not in CACHE_ONLY_PHASES)):
            raise BuildControlError("Invalid build-space admission for operation phase")
        token = uuid.uuid4().hex
        root = f"{phase}/attempts/{token}"
        path = self.path(root)
        name = "fullmag-control-" + token
        # The advisory lease and durable active marker cover the entire daemon
        # operation. An interrupted host cannot silently free an unknown build.
        script = self.operation_script(phase, token)
        space_before = self.space()
        _assert_free_space(space_before, minimum_free_bytes, "admission refused")
        logger = subprocess.Popen(self.helper_args(script, name=name), stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        receipt = {"schema": "fullmag.docker-build-operation.v1", "phase": phase,
                   "state": "starting", "attempt": token, "compose_project": self.project,
                   "control_volume": self.volume, "helper_container": name,
                   "inputs": inputs, "started_at": time.time(),
                   "log_byte_limit": MAX_LOG_BYTES, "attempt_limit": MAX_ATTEMPTS,
                   "build_data_qualification": "NOT VERIFIED",
                   "minimum_free_bytes": minimum_free_bytes,
                   "filesystem_before": space_before}
        if self.namespace:
            receipt.update(control_namespace=self.namespace,
                           namespace_registry_sha256=self.namespace_registry_sha256)
        operation = {"receipt": receipt, "root": root, "logger": logger, "daemon_pending": False, "lease_ready": False}
        try:
            first = self._line(logger)
            if first != "READY":
                raise BuildControlError("Control helper admission failed: " + first)
            operation["lease_ready"] = True
            operation["helper_container_id"] = self._pin_operation_helper(operation)
            if self._active_operation is not None:
                raise ControlOutcomeUnknown("A control operation is already active on this BuildControl")
            self._active_operation = operation
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
            try:
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
            finally:
                if self._active_operation is operation:
                    self._active_operation = None

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
    control = BuildControl(identity, helper)
    # The control helper itself is pulled only when it is absent. Do not call
    # prepare() first: its --pull never helper cannot run on a cold host.
    probe_spec = {"name": identity["project_name"], "services": {"build-control": {
        "image": helper, "runtime": "runc", "environment": {"NVIDIA_VISIBLE_DEVICES": "void"}}}}
    helper_present = not docker_capture("image", "inspect", helper, allow_failure=True).returncode
    if not helper_present:
        if os.name == "nt":
            control.assert_windows_pre_pull_space()
        # Linux/WSL has no Docker-VM measurement before this image exists; the
        # established cold ordering is retained and documented as such.
        compose_capture(probe_spec, "pull", "build-control", timeout=1800)
    control.prepare(minimum_free_bytes=(MIN_FREE_CONTROL_BYTES if helper_present
                                        else MIN_FREE_BUILD_BYTES))

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
    with control.operation("toolchain", source_identity,
                           minimum_free_bytes=MIN_FREE_CONTROL_BYTES) as operation:
        operation["receipt"].update(state="building", source_commit=storage.git(repo, "rev-parse", "HEAD"),
                                    source_digest=digest)
        control.write(operation["root"] + "/compose.json", configured)
        previous = (control.read("toolchain/verified.json", optional=True)
                    or control.read("toolchain/current.json", optional=True))
        cached = (isinstance(previous, dict) and previous.get("state") == "succeeded"
                  and previous.get("source_digest") == digest
                  and previous.get("compose_project") == identity["project_name"]
                  and previous.get("control_volume") == control.volume
                  and re.fullmatch(r"sha256:[0-9a-f]{64}", previous.get("image_id", "")))
        if cached:
            cached = _exact_local_image_id(previous["image_id"], previous["image_id"])
        operation["receipt"]["cache_hit"] = bool(cached)
        if not cached:
            control.require_build_space(operation=operation)
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


def build_volume_runtime_images(repo, control, toolchain, *, helper_source_binding=None):
    """Prepare trusted wrapper layers through this project's BuildKit only."""
    from docker_dev import BASE_CONTEXT_FILES, RUNTIME_IMAGE_CONTEXT_FILES
    from bootstrap_docker_toolchain import read_input
    require_host()
    repo = validate_host_path(Path(repo).absolute(), "source checkout").resolve(strict=True)
    helper_source = None
    if helper_source_binding is not None:
        import docker_helper_source as helper_source
        try:
            helper_source_binding = helper_source.validate_binding_record(helper_source_binding)
            if Path(helper_source_binding["root"]).resolve(strict=True) != repo:
                raise helper_source.HelperSourceError("Runtime image context is not the pinned helper checkout")
            helper_source.revalidate_binding(
                helper_source_binding,
                base_context_files=BASE_CONTEXT_FILES,
                runtime_context_files=RUNTIME_IMAGE_CONTEXT_FILES,
            )
        except (OSError, helper_source.HelperSourceError) as error:
            raise BuildControlError("Pinned helper source is unavailable before runtime image build: " + str(error)) from error
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
        if helper_source_binding is not None:
            identity["helper_source"] = helper_source_binding
        digest = hashlib.sha256(canonical(identity)).hexdigest()
        tag = "fullmag/development-" + kind + ":inputs-" + digest[:24]
        parent_ref = "fullmag/" + control.project + "-base:sha-" + parent.removeprefix("sha256:")
        arguments = {"FULLMAG_DOCKER_HELPERS": "docker/all-in-one/"}
        if kind == "dev":
            arguments.update(RUNTIME_BASE=parent_ref, FULLMAG_TOOLCHAIN_IMAGE_ID=parent,
                             FULLMAG_SCRIPT_HELPERS="scripts/")
        else:
            arguments["DEV_BASE"] = parent_ref
        labels = {"org.fullmag.compose.project": control.project,
                  "org.fullmag.build.input-digest": digest}
        if helper_source_binding is not None:
            labels.update(helper_source.image_labels(helper_source_binding))
        document = {"name": control.project, "services": {"image-" + kind: {
            "image": tag, "build": {"context": str(repo),
            "dockerfile": "docker/all-in-one/Dockerfile." + kind, "args": arguments,
            "labels": labels}}}}
        with control.operation("image-" + kind, identity,
                               minimum_free_bytes=MIN_FREE_CONTROL_BYTES) as operation:
            # FROM accepts a named local reference, not Docker's raw image ID.
            # The group lease protects this content-derived alias; attest it
            # before and after BuildKit rather than trusting a mutable tag.
            docker_capture("image", "tag", parent, parent_ref)
            parent_documents = json.loads(docker_capture("image", "inspect", parent_ref).stdout)
            if (len(parent_documents) != 1 or parent_documents[0].get("Id") != parent):
                raise BuildControlError("BuildKit parent alias does not match the pinned image")
            control.write(operation["root"] + "/compose.json", document)
            previous = (control.read("image-" + kind + "/verified.json", optional=True)
                        or control.read("image-" + kind + "/current.json", optional=True))
            cached = (isinstance(previous, dict) and previous.get("state") == "succeeded"
                      and previous.get("source_digest") == digest
                      and previous.get("compose_project") == control.project
                      and previous.get("control_volume") == control.volume
                      and re.fullmatch(r"sha256:[0-9a-f]{64}", previous.get("image_id", "")))
            if cached:
                cached = _exact_local_image_id(previous["image_id"], previous["image_id"])
            operation["receipt"].update(state="building", cache_hit=bool(cached))
            if not cached:
                control.require_build_space(operation=operation)
                if helper_source_binding is not None:
                    try:
                        helper_source.revalidate_binding(
                            helper_source_binding,
                            base_context_files=BASE_CONTEXT_FILES,
                            runtime_context_files=RUNTIME_IMAGE_CONTEXT_FILES,
                        )
                    except helper_source.HelperSourceError as error:
                        raise BuildControlError("Pinned helper source changed before BuildKit: " + str(error)) from error
                control.build(operation, document, "image-" + kind)
            if helper_source_binding is not None:
                try:
                    helper_source.revalidate_binding(
                        helper_source_binding,
                        base_context_files=BASE_CONTEXT_FILES,
                        runtime_context_files=RUNTIME_IMAGE_CONTEXT_FILES,
                    )
                except helper_source.HelperSourceError as error:
                    raise BuildControlError("Pinned helper source changed during BuildKit: " + str(error)) from error
            parent_documents = json.loads(docker_capture("image", "inspect", parent_ref).stdout)
            if (inputs() != manifest
                    or len(parent_documents) != 1
                    or parent_documents[0].get("Id") != parent):
                raise BuildControlError("Runtime image inputs changed during BuildKit build")
            image = json.loads(docker_capture("image", "inspect", previous["image_id"] if cached else tag).stdout)
            if len(image) != 1 or not re.fullmatch(r"sha256:[0-9a-f]{64}", image[0].get("Id", "")):
                raise BuildControlError("Runtime image has no immutable identity")
            labels = image[0].get("Config", {}).get("Labels", {})
            if (labels.get("org.fullmag.compose.project") != control.project
                    or labels.get("org.fullmag.build.input-digest") != digest):
                raise BuildControlError("Runtime image source labels differ")
            if helper_source_binding is not None:
                try:
                    helper_source.startup_hashes_from_image_labels(labels, helper_source_binding)
                except helper_source.HelperSourceError as error:
                    raise BuildControlError("Runtime image helper-source labels differ: " + str(error)) from error
            parent = image[0]["Id"]
            operation["receipt"].update(state="succeeded", source_digest=digest, image=tag,
                                        image_id=parent)
            if helper_source_binding is not None:
                operation["receipt"]["helper_source"] = helper_source_binding
        results[kind] = operation["receipt"]
    return results
