"""Supervise one source-pinned WSL root bind stage under the held migration fence.

This adapter authenticates the selected checkout and the completed copy, then
hands the fixed command and bind validator to the shared root-client supervisor.
It does not expose a standalone root command, restart a client, or admit the
new namespace.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re

from docker_compose_identity import compose_project_identity
from docker_data_volume_linux import _wsl_executable
from fullmag_data_volume_linux_request import validate_linux_request
from fullmag_data_volume_runtime_binding import load_plan
import linux_data_volume_provision as qualification

try:
    from . import docker_data_volume_copy_job as copy_job
    from . import fullmag_data_volume_pending as pending
    from . import linux_data_volume_bind as bind_stage
    from . import linux_data_volume_copy as copy_stage
    from .fullmag_data_volume_journal import next_phase
except ImportError:
    import docker_data_volume_copy_job as copy_job
    import fullmag_data_volume_pending as pending
    import linux_data_volume_bind as bind_stage
    import linux_data_volume_copy as copy_stage
    from fullmag_data_volume_journal import next_phase

run_prepared_root = copy_job.run_prepared_root


_ROOT_BIND_BOOTSTRAP = r'''import hashlib, importlib.abc, importlib.util, json, os, stat, sys
source, request_path, request_sha256, expected_json = sys.argv[1:]

def need(value, message):
    if not value:
        raise SystemExit(message)

directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
file_flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK

def open_directory(path):
    need(type(path) is str and path.startswith('/') and not path.startswith('//') and
         os.path.normpath(path) == path, 'noncanonical root-bind path')
    descriptor = os.open('/', directory_flags)
    try:
        for component in path.split('/')[1:]:
            need(component not in ('', '.', '..'), 'unsafe root-bind path component')
            child = os.open(component, directory_flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise

def read_regular(descriptor, maximum):
    before = os.fstat(descriptor)
    need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= maximum,
         'unsafe root-bind evidence file')
    chunks = []
    total = 0
    while True:
        chunk = os.read(descriptor, min(1024 * 1024, maximum + 1 - total))
        if not chunk:
            break
        total += len(chunk)
        need(total <= maximum, 'oversized root-bind evidence file')
        chunks.append(chunk)
    after = os.fstat(descriptor)
    need((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
         (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns),
         'root-bind evidence changed while hashing')
    return b''.join(chunks)

def read_path(path, maximum):
    need(type(path) is str and path.startswith('/') and not path.startswith('//') and
         os.path.normpath(path) == path, 'noncanonical root-bind evidence path')
    parent_path, name = os.path.split(path)
    need(name not in ('', '.', '..'), 'invalid root-bind evidence name')
    parent = open_directory(parent_path)
    try:
        descriptor = os.open(name, file_flags, dir_fd=parent)
        try:
            return read_regular(descriptor, maximum)
        finally:
            os.close(descriptor)
    finally:
        os.close(parent)

need(type(request_sha256) is str and len(request_sha256) == 64 and
     all(character in '0123456789abcdef' for character in request_sha256), 'invalid root-bind request SHA')
raw_request = read_path(request_path, 256 * 1024)
need(hashlib.sha256(raw_request).hexdigest() == request_sha256, 'root-bind request SHA changed')
request = json.loads(raw_request)
request_keys = {'schema', 'volume_id', 'storage_root', 'token', 'copy_request_sha256',
                'copy_receipt_sha256', 'fence_ready_sha256', 'components'}
need(type(request) is dict and set(request) == request_keys and
     request['schema'] == 'fullmag.data-volume-linux-bind-request.v1', 'closed root-bind request required')
expected = json.loads(expected_json)
need(type(expected) is dict and expected == request['components'] and expected,
     'root-bind component pin set changed')
source_fd = open_directory(source)
scripts_fd = None
verified_sources = {}
try:
    scripts_fd = os.open('scripts', directory_flags, dir_fd=source_fd)
    for name in sorted(expected):
        digest = expected[name]
        need(type(name) is str and name.endswith('.py') and '/' not in name and '\\' not in name and
             name not in ('', '.', '..') and type(digest) is str and len(digest) == 64 and
             all(character in '0123456789abcdef' for character in digest), 'invalid root-bind component pin')
        descriptor = os.open(name, file_flags, dir_fd=scripts_fd)
        try:
            raw = read_regular(descriptor, 4 * 1024 * 1024)
        finally:
            os.close(descriptor)
        need(hashlib.sha256(raw).hexdigest() == digest, 'root-bind component changed: ' + name)
        verified_sources[name[:-3]] = (source + '/scripts/' + name, raw)
finally:
    if scripts_fd is not None:
        os.close(scripts_fd)
    os.close(source_fd)

need(set(verified_sources) == {name[:-3] for name in expected}, 'root-bind verified module set changed')
need(not (set(verified_sources) & set(sys.modules)), 'pinned root-bind module was already imported')

class VerifiedLoader(importlib.abc.Loader):
    def __init__(self, fullname, path, raw):
        self.fullname = fullname
        self.path = path
        self.raw = raw
    def create_module(self, spec):
        return None
    def exec_module(self, module):
        module.__file__ = self.path
        module.__cached__ = None
        code = compile(self.raw, self.path, 'exec', dont_inherit=True)
        exec(code, module.__dict__)

class VerifiedFinder(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        pinned = verified_sources.get(fullname)
        if pinned is None:
            return None
        if fullname in sys.modules:
            raise ImportError('pinned root-bind module was already imported: ' + fullname)
        module_path, raw = pinned
        loader = VerifiedLoader(fullname, module_path, raw)
        return importlib.util.spec_from_loader(fullname, loader, origin=module_path)

sys.meta_path.insert(0, VerifiedFinder())
import importlib
bind_module = importlib.import_module('linux_data_volume_bind')
bind_module.bind_verified(request_path, request_sha256)
'''


def _operation_match(fence, request):
    return copy_job._operation_match(fence, request)


def prepare_command(fence, source, distro, request_path, request_sha256):
    """Authenticate scope and return a fixed WSL/Python root-bind command."""
    source, request_path = Path(source), Path(request_path)
    qualification.require(source.is_absolute() and str(source) == os.path.normpath(str(source)) and
        not str(source).startswith("//"), "Exact canonical source root required for the root client")
    qualification.require(type(distro) is str and re.fullmatch(r"[A-Za-z0-9_-]{1,80}", distro),
                          "Exact WSL distro required")
    qualification.require(type(request_sha256) is str and re.fullmatch(r"[0-9a-f]{64}", request_sha256),
                          "Exact root bind request SHA required")
    _, value = qualification._read(request_path, request_sha256)
    request = bind_stage.validate_request(value)
    _operation_match(fence, request)

    layout = copy_job.storage.resolve_layout(source, profile="docker-all-gpu")
    identity = compose_project_identity(layout)
    operation_root = Path(layout["storage_root"]) / "migrations/data-volumes" / request["volume_id"]
    qualification.require(request_path == operation_root / "linux-bind-request.json" and
        request["storage_root"] == layout["storage_root"] and
        fence.control.project == identity["project_name"],
        "Root bind request is outside the selected source group")

    copy_request_path = operation_root / "linux-copy-request.json"
    _, copy_value = qualification._read(copy_request_path, request["copy_request_sha256"])
    copy_request = copy_stage.validate_request(copy_value)
    qualification.require(copy_request["volume_id"] == request["volume_id"] and
        copy_request["storage_root"] == request["storage_root"],
        "Root bind predecessor copy belongs to another volume")

    _, linux_raw = qualification._read(
        operation_root / "linux-provision-request.json", copy_request["linux_request_sha256"]
    )
    linux = validate_linux_request(linux_raw)
    plan_raw, plan, _binding = load_plan(operation_root, linux)
    _, copy_result = qualification._read(
        operation_root / "linux-copy-result.json", request["copy_receipt_sha256"]
    )
    copy_stage.validate_result(copy_result, copy_request, linux, request["copy_request_sha256"])
    _, journal = qualification._selected_journal(operation_root)
    previous = journal["events"][-1] if journal["events"] else {}
    qualification.require(journal.get("volume_id") == request["volume_id"] and
        journal.get("request_sha256") == hashlib.sha256(plan_raw).hexdigest() and
        next_phase(journal) == "binds-switched" and
        previous.get("phase") == "copy-verified" and previous.get("state") == "succeeded" and
        previous.get("inputs_sha256") == request["copy_request_sha256"] and
        previous.get("receipt_sha256") == request["copy_receipt_sha256"],
        "Root bind predecessor copy has no exact successful journal terminal")
    qualification.require(plan.get("source_root") == str(source) and
        plan.get("project_id") == identity["project_id"] and
        plan.get("worktree_id") == identity["worktree_id"] and
        plan.get("compose_project") == identity["project_name"] and
        plan.get("provision_request", {}).get("wsl_distro") == distro and
        plan.get("runtime_pins", {}).get("image_id") == fence.control.image,
        "Root bind plan belongs to another checkout, image or WSL distro")
    qualification.require(plan.get("volume_id") == request["volume_id"] and
        linux["volume_id"] == request["volume_id"] and
        linux["storage_root"] == request["storage_root"] and
        linux["source_roots"] == plan.get("observation", {}).get("datasets") and
        {role: {key: pin[key] for key in ("device", "inode")}
         for role, pin in linux["source_roots"].items()} == fence.request["source_roots"],
        "Root bind original dataset identities differ from the held helper")

    _, drain = qualification._read(operation_root / "group-drained.json", copy_request["drain_sha256"])
    qualification.require(type(drain) is dict and set(drain) == {
        "schema", "volume_id", "token", "plan_sha256", "source_roots", "stop_attempt",
        "stop_sha256", "process_receipt_sha256", "containers",
    } and drain["schema"] == "fullmag.data-volume-group-drained.v1" and
        drain["volume_id"] == request["volume_id"] and drain["token"] == copy_request["token"] and
        drain["plan_sha256"] == hashlib.sha256(plan_raw).hexdigest() and
        drain["source_roots"] == linux["source_roots"] and
        drain["containers"] == {key: plan["runtime_pins"][key] for key in ("backend", "frontend")},
        "Root bind predecessor drain differs from the selected copy and runtime")

    _, ready = qualification._read(operation_root / "bind-fence-ready.json", request["fence_ready_sha256"])
    qualification.require(ready == fence.ready, "Root bind does not use the exact held fence acknowledgement")
    copy_stage.validate_held_fence(
        ready, request["token"], request["volume_id"], drain["process_receipt_sha256"]
    )

    for name in bind_stage.COMPONENTS:
        raw = qualification._read_optional_regular(source / "scripts" / name,
            "root bind component", maximum=4 * 1024**2)
        qualification.require(raw is not None and qualification.digest(raw) == request["components"][name],
                              "Root bind component source changed: " + name)

    command = [
        _wsl_executable(), "--distribution", distro, "--user", "root", "--exec",
        "/usr/bin/python3", "-I", "-B", "-c", _ROOT_BIND_BOOTSTRAP,
        str(source), str(request_path), request_sha256,
        json.dumps(request["components"], sort_keys=True, separators=(",", ":")),
    ]
    return command, operation_root, request


def _verified_copy_inputs(operation_root, request, request_sha256):
    """Reauthenticate the unchanged plan, Linux request, and completed copy."""
    operation_root = Path(operation_root)
    qualification.require(operation_root == Path(request["storage_root"]) / "migrations/data-volumes" /
                          request["volume_id"], "Root bind terminal escapes its selected operation")
    _, stored_request = qualification._read(operation_root / "linux-bind-request.json", request_sha256)
    qualification.require(bind_stage.validate_request(stored_request) == request,
                          "Root bind terminal request changed")

    _, copy_value = qualification._read(operation_root / "linux-copy-request.json",
                                        request["copy_request_sha256"])
    copy_request = copy_stage.validate_request(copy_value)
    qualification.require(copy_request["volume_id"] == request["volume_id"] and
        copy_request["storage_root"] == request["storage_root"],
        "Completed copy predecessor differs from the root bind request")
    _, linux_raw = qualification._read(operation_root / "linux-provision-request.json",
                                       copy_request["linux_request_sha256"])
    linux = validate_linux_request(linux_raw)
    plan_raw, plan, _binding = load_plan(operation_root, linux)
    qualification.require(plan.get("volume_id") == request["volume_id"] and
        plan.get("storage_root") == request["storage_root"] and
        plan.get("mount_root") == linux["mount_root"] and
        plan.get("observation", {}).get("datasets") == linux["source_roots"],
        "Root bind terminal plan or original datasets differ")
    _, copy_result = qualification._read(operation_root / "linux-copy-result.json",
                                          request["copy_receipt_sha256"])
    copy_stage.validate_result(copy_result, copy_request, linux, request["copy_request_sha256"])
    return copy_request, linux, plan_raw, plan, copy_result


def _positive_identity(value, label):
    qualification.require(type(value) is dict and set(value) == {"device", "inode"} and
        all(type(item) is int and item > 0 for item in value.values()),
        "Exact positive " + label + " identity required")


def _validate_switch(switch, request, linux, copy_result):
    require = qualification.require
    root_keys = {"role", "canonical_root", "backup_root", "copied_root", "original_identity",
                 "underlay_identity", "bound_identity", "mount"}
    require(type(switch) is dict and set(switch) == {
        "schema", "state", "volume_id", "filesystem_uuid", "data_sha256", "roots",
        "namespace_admitted", "originals_retired",
    } and switch["schema"] == "fullmag.data-volume-bind-result.v1" and
        switch["state"] == "binds-switched-not-admitted" and
        switch["volume_id"] == request["volume_id"] and
        switch["filesystem_uuid"] == linux["filesystem_uuid"] and
        switch["data_sha256"] == copy_result["data_sha256"] and
        switch["namespace_admitted"] is False and switch["originals_retired"] is False and
        type(switch["roots"]) is dict and set(switch["roots"]) == {"state", "user_data"},
        "Nested root bind result differs from the verified copy")
    for role, source in linux["source_roots"].items():
        row = switch["roots"][role]
        canonical = Path(source["canonical_root"])
        backup = canonical.with_name("." + canonical.name + ".fullmag-before-" + request["volume_id"])
        require(type(row) is dict and set(row) == root_keys and row["role"] == role and
            row["canonical_root"] == str(canonical) and row["backup_root"] == str(backup) and
            row["copied_root"] == copy_result["copied_roots"][role] and
            row["original_identity"] == {key: source[key] for key in ("device", "inode")},
            "Nested root bind path or original identity differs: " + role)
        _positive_identity(row["underlay_identity"], role + " underlay")
        _positive_identity(row["bound_identity"], role + " bound root")
        require(row["underlay_identity"]["device"] == source["device"] and
            row["bound_identity"]["device"] != source["device"],
            "Nested bind inode identities cross the wrong filesystems: " + role)
        mount = row["mount"]
        require(type(mount) is dict and set(mount) == {"target", "fstype", "uuid", "options", "propagation"} and
            mount["target"] == str(canonical) and mount["fstype"] == "ext4" and
            mount["uuid"] == linux["filesystem_uuid"] and
            type(mount["options"]) is str and
            {"rw", "nodev", "nosuid"} <= set(mount["options"].split(",")) and
            mount["propagation"] == "private",
            "Nested canonical bind mount identity or protection differs: " + role)


def validate_terminal(operation_root, request, request_sha256, exit_code):
    """Accept only an exact terminal bind result or a confirmed root failure."""
    require = qualification.require
    require(type(exit_code) is int, "An observed terminal root bind exit is required")
    require(type(request_sha256) is str and re.fullmatch(r"[0-9a-f]{64}", request_sha256),
            "Exact root bind request SHA required")
    request = bind_stage.validate_request(request)
    operation_root = Path(operation_root)
    require(operation_root == Path(request["storage_root"]) / "migrations/data-volumes" /
            request["volume_id"], "Root bind terminal escapes its selected operation")
    _, journal = qualification._selected_journal(operation_root)
    events = journal["events"]
    event = events[-1] if events else {}
    require(event.get("phase") == "binds-switched" and event.get("inputs_sha256") == request_sha256,
            "Root bind journal belongs to another request")

    success_path = operation_root / "linux-bind-result.json"
    failure_path = operation_root / "linux-bind-failed.json"
    copy_request, linux, plan_raw, plan, copy_result = _verified_copy_inputs(
        operation_root, request, request_sha256
    )
    require(journal.get("volume_id") == request["volume_id"] and
        journal.get("request_sha256") == hashlib.sha256(plan_raw).hexdigest() and
        len(events) >= 4 and events[-2].get("phase") == "binds-switched" and
        events[-2].get("state") == "started" and
        events[-3].get("phase") == "copy-verified" and events[-3].get("state") == "succeeded" and
        events[-3].get("inputs_sha256") == request["copy_request_sha256"] and
        events[-3].get("receipt_sha256") == request["copy_receipt_sha256"],
        "Root bind journal does not continue the exact verified copy terminal")
    if exit_code == 0:
        require(not os.path.lexists(failure_path) and event.get("state") == "succeeded",
                "Successful root client exit has no unambiguous completed bind")
        raw, result = qualification._read(success_path, event["receipt_sha256"])
        expected_keys = {"schema", "state", "volume_id", "token", "request_sha256", "copy_receipt_sha256",
                         "pending_marker", "switch", "namespace_admitted", "originals_retired"}
        require(type(result) is dict and set(result) == expected_keys and
            result["schema"] == "fullmag.data-volume-linux-bind-result.v1" and
            result["state"] == "binds-switched-not-admitted" and
            result["volume_id"] == request["volume_id"] and result["token"] == request["token"] and
            result["request_sha256"] == request_sha256 and
            result["copy_receipt_sha256"] == request["copy_receipt_sha256"] and
            result["namespace_admitted"] is False and result["originals_retired"] is False,
            "Root bind success receipt scope or authority flags differ")
        _validate_switch(result["switch"], request, linux, copy_result)
        marker_ref = result["pending_marker"]
        layout = {"repo_root": plan["source_root"], "storage_root": plan["storage_root"],
                  "runtime_root": plan["runtime_root"], "worktree_id": plan["worktree_id"],
                  "env": {"FULLMAG_PROJECT_ID": plan["project_id"]}}
        marker_path = pending.pending_path(layout)
        require(type(marker_ref) is dict and set(marker_ref) == {"path", "sha256"} and
            marker_ref["path"] == str(marker_path) and
            type(marker_ref["sha256"]) is str and re.fullmatch(r"[0-9a-f]{64}", marker_ref["sha256"]),
            "Root bind success does not reference the exact pending marker")
        marker_raw = qualification._read_optional_regular(
            marker_path, "published pending marker", maximum=pending.MAX_BYTES
        )
        require(marker_raw is not None and qualification.digest(marker_raw) == marker_ref["sha256"],
                "Published pending marker bytes differ from the bind receipt")
        marker = pending.validate_pending(qualification._parse_object(marker_raw, "published pending marker"),
                                          layout, plan["compose_project"])
        expected_marker = {
            "schema": pending.SCHEMA,
            "project_id": plan["project_id"],
            "worktree_id": plan["worktree_id"],
            "compose_project": plan["compose_project"],
            "source_root": plan["source_root"],
            "volume_id": request["volume_id"],
            "plan_sha256": hashlib.sha256(plan_raw).hexdigest(),
            "linux_request_sha256": copy_request["linux_request_sha256"],
            "copy_receipt_sha256": request["copy_receipt_sha256"],
            "state_root": linux["source_roots"]["state"]["canonical_root"],
            "user_data_root": linux["source_roots"]["user_data"]["canonical_root"],
        }
        require(marker == expected_marker, "Pending marker changed the original plan or copy scope")
    else:
        require(not os.path.lexists(success_path) and event.get("state") == "failed-confirmed",
                "Root bind client failed without a confirmed terminal root failure")
        layout = {"repo_root": plan["source_root"], "storage_root": plan["storage_root"],
                  "runtime_root": plan["runtime_root"], "worktree_id": plan["worktree_id"],
                  "env": {"FULLMAG_PROJECT_ID": plan["project_id"]}}
        require(not os.path.lexists(pending.pending_path(layout)),
                "Confirmed root bind failure conflicts with a published pending marker")
        raw, result = qualification._read(failure_path, event["receipt_sha256"])
        require(type(result) is dict and set(result) == {
            "schema", "state", "volume_id", "token", "request_sha256", "error_type",
            "originals_and_copies_retained", "manual_recovery_required",
        } and result["schema"] == "fullmag.data-volume-linux-bind-failure.v1" and
            result["state"] == "failed-confirmed" and result["volume_id"] == request["volume_id"] and
            result["token"] == request["token"] and result["request_sha256"] == request_sha256 and
            result["originals_and_copies_retained"] is True and result["manual_recovery_required"] is True,
            "Root bind confirmed failure scope differs")
    return {"state": result["state"], "receipt_sha256": hashlib.sha256(raw).hexdigest(), "result": result}


def run_root_bind(fence, source, distro, request_path, request_sha256, *, poll_interval=2.0):
    """Supervise the fixed root bind until its exact receipt is terminal."""
    qualification.require(type(poll_interval) in (int, float) and 0 < poll_interval <= 5,
                          "Bounded root-client polling interval required")
    fence.check()
    command, operation_root, request = prepare_command(fence, source, distro, request_path, request_sha256)
    return run_prepared_root(
        "bind", fence, command, operation_root, request, request_sha256, validate_terminal,
        release_copy_sha256=request["copy_receipt_sha256"], poll_interval=poll_interval,
    )
