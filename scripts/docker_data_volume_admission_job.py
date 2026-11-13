"""Supervise one source-pinned WSL admission preparation under the held fence.

This host adapter authenticates the completed bind and a live relocated view,
then retains the old copy acknowledgement until the exact root admission RPC is
terminal. It never reads the protected root-owned archive, admits a namespace,
or retires the originals.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import re
import stat

from docker_compose_identity import compose_project_identity
from docker_data_volume_linux import _wsl_executable
from fullmag_data_volume_linux_request import validate_linux_request
from fullmag_data_volume_runtime_binding import load_plan
import docker_data_volume_relocated as relocated
import fullmag_data_volume_manifest as manifest
import linux_data_volume_provision as qualification
import linux_native_host as native_host

try:
    from . import docker_data_volume_root_bootstrap as root_bootstrap
    from . import docker_data_volume_copy_job as copy_job
    from . import docker_data_volume_bind_job as bind_job
    from . import fullmag_data_volume_pending as pending
    from . import linux_data_volume_admission as admission_stage
    from . import linux_data_volume_bind as bind_stage
    from . import linux_data_volume_copy as copy_stage
    from .fullmag_data_volume_journal import next_phase
except ImportError:
    import docker_data_volume_root_bootstrap as root_bootstrap
    import docker_data_volume_copy_job as copy_job
    import docker_data_volume_bind_job as bind_job
    import fullmag_data_volume_pending as pending
    import linux_data_volume_admission as admission_stage
    import linux_data_volume_bind as bind_stage
    import linux_data_volume_copy as copy_stage
    from fullmag_data_volume_journal import next_phase


run_prepared_root = copy_job.run_prepared_root
_ROOT_ADMISSION_BOOTSTRAP = root_bootstrap.bootstrap("admission")
_NATIVE_SNAPSHOT_KEYS = {
    "old_files", "new_files", "certificate_inode", "candidate_raw", "certificate_sha256",
    "source_data_sha256",
}


def _operation_match(fence, request):
    return copy_job._operation_match(fence, request)


def _operation_root(layout, request):
    return Path(layout["storage_root"]) / "migrations/data-volumes" / request["volume_id"]


def _pending_layout(plan):
    return {
        "repo_root": plan["source_root"],
        "storage_root": plan["storage_root"],
        "runtime_root": plan["runtime_root"],
        "worktree_id": plan["worktree_id"],
        "env": {"FULLMAG_PROJECT_ID": plan["project_id"]},
    }


def _validate_pending_reference(marker_ref, request, copy_request, bind_request, bind_result, linux, plan_raw, plan):
    layout = _pending_layout(plan)
    marker_path = pending.pending_path(layout)
    qualification.require(type(marker_ref) is dict and set(marker_ref) == {"path", "sha256"} and
        marker_ref == bind_result["pending_marker"] and marker_ref["path"] == str(marker_path) and
        type(marker_ref["sha256"]) is str and re.fullmatch(r"[0-9a-f]{64}", marker_ref["sha256"]),
        "Admission result does not reference the exact bind pending marker")
    marker_raw = qualification._read_optional_regular(
        marker_path, "published pending marker", maximum=pending.MAX_BYTES
    )
    qualification.require(marker_raw is not None and qualification.digest(marker_raw) == marker_ref["sha256"],
                           "Published pending marker bytes differ from the bind receipt")
    marker = pending.validate_pending(
        qualification._parse_object(marker_raw, "published pending marker"),
        layout,
        plan["compose_project"],
    )
    expected = {
        "schema": pending.SCHEMA,
        "project_id": plan["project_id"],
        "worktree_id": plan["worktree_id"],
        "compose_project": plan["compose_project"],
        "source_root": plan["source_root"],
        "volume_id": request["volume_id"],
        "plan_sha256": hashlib.sha256(plan_raw).hexdigest(),
        "linux_request_sha256": copy_request["linux_request_sha256"],
        "copy_receipt_sha256": bind_request["copy_receipt_sha256"],
        "state_root": linux["source_roots"]["state"]["canonical_root"],
        "user_data_root": linux["source_roots"]["user_data"]["canonical_root"],
    }
    qualification.require(marker == expected, "Admission pending marker changed the original bind scope")
    return marker_path, marker_raw, marker


def _verified_bind_inputs(operation_root, request, request_sha256):
    operation_root = Path(operation_root)
    qualification.require(operation_root == Path(request["storage_root"]) / "migrations/data-volumes" /
                          request["volume_id"], "Root admission terminal escapes its selected operation")
    _, stored_request = qualification._read(operation_root / "linux-admission-request.json", request_sha256)
    qualification.require(admission_stage.validate_request(stored_request) == request,
                          "Root admission terminal request changed")
    _, bind_value = qualification._read(
        operation_root / "linux-bind-request.json", request["bind_request_sha256"]
    )
    bind_request = bind_stage.validate_request(bind_value)
    copy_request, linux, plan_raw, plan, copy_result = bind_job._verified_copy_inputs(
        operation_root, bind_request, request["bind_request_sha256"]
    )
    _, bind_result = qualification._read(
        operation_root / "linux-bind-result.json", request["bind_receipt_sha256"]
    )
    expected_bind_keys = {
        "schema", "state", "volume_id", "token", "request_sha256", "copy_receipt_sha256",
        "pending_marker", "switch", "namespace_admitted", "originals_retired",
    }
    qualification.require(type(bind_result) is dict and set(bind_result) == expected_bind_keys and
        bind_result["schema"] == "fullmag.data-volume-linux-bind-result.v1" and
        bind_result["state"] == "binds-switched-not-admitted" and
        bind_result["volume_id"] == request["volume_id"] and
        bind_result["token"] == bind_request["token"] and
        bind_result["request_sha256"] == request["bind_request_sha256"] and
        bind_result["copy_receipt_sha256"] == bind_request["copy_receipt_sha256"] and
        bind_result["namespace_admitted"] is False and bind_result["originals_retired"] is False,
        "Root admission bind predecessor scope or authority flags differ")
    bind_job._validate_switch(bind_result["switch"], bind_request, linux, copy_result)
    _validate_pending_reference(
        bind_result["pending_marker"], request, copy_request, bind_request, bind_result, linux, plan_raw, plan
    )
    return copy_request, linux, plan_raw, plan, copy_result, bind_request, bind_result


def _verify_plan_scope(source, distro, fence, identity, request, copy_request, linux, plan):
    qualification.require(plan.get("source_root") == str(source) and
        plan.get("project_id") == identity["project_id"] and
        plan.get("worktree_id") == identity["worktree_id"] and
        plan.get("compose_project") == identity["project_name"] and
        plan.get("provision_request", {}).get("wsl_distro") == distro and
        plan.get("runtime_pins", {}).get("image_id") == fence.control.image,
        "Root admission plan belongs to another checkout, group, image or WSL distro")
    qualification.require(plan.get("volume_id") == request["volume_id"] and
        copy_request["volume_id"] == request["volume_id"] and linux["volume_id"] == request["volume_id"] and
        plan.get("storage_root") == request["storage_root"] == copy_request["storage_root"] == linux["storage_root"] and
        plan.get("mount_root") == linux["mount_root"] and
        plan.get("observation", {}).get("datasets") == linux["source_roots"] and
        {role: {key: pin[key] for key in ("device", "inode")}
         for role, pin in linux["source_roots"].items()} == fence.request["source_roots"],
        "Root admission original roots differ from the held copy fence")


def _verify_drain(operation_root, request, copy_request, linux, plan_raw, plan):
    _, drain = qualification._read(operation_root / "group-drained.json", copy_request["drain_sha256"])
    qualification.require(type(drain) is dict and set(drain) == {
        "schema", "volume_id", "token", "plan_sha256", "source_roots", "stop_attempt",
        "stop_sha256", "process_receipt_sha256", "containers",
    } and drain["schema"] == "fullmag.data-volume-group-drained.v1" and
        drain["volume_id"] == request["volume_id"] and drain["token"] == copy_request["token"] and
        drain["plan_sha256"] == hashlib.sha256(plan_raw).hexdigest() and
        drain["source_roots"] == linux["source_roots"] and
        drain["containers"] == {key: plan["runtime_pins"][key] for key in ("backend", "frontend")},
        "Root admission predecessor drain differs from the verified copy and runtime")
    return drain


def _prepare_context(fence, source, distro, request_path, request_sha256):
    source, request_path = Path(source), Path(request_path)
    qualification.require(source.is_absolute() and str(source) == os.path.normpath(str(source)) and
        not str(source).startswith("//"), "Exact canonical source root required for the root client")
    qualification.require(type(distro) is str and re.fullmatch(r"[A-Za-z0-9_-]{1,80}", distro),
                          "Exact WSL distro required")
    qualification.require(type(request_sha256) is str and re.fullmatch(r"[0-9a-f]{64}", request_sha256),
                          "Exact root admission request SHA required")
    _, value = qualification._read(request_path, request_sha256)
    request = admission_stage.validate_request(value)
    _operation_match(fence, request)

    layout = copy_job.storage.resolve_layout(source, profile="docker-all-gpu")
    identity = compose_project_identity(layout)
    operation_root = _operation_root(layout, request)
    qualification.require(request_path == operation_root / "linux-admission-request.json" and
        request["storage_root"] == layout["storage_root"] and
        fence.control.project == identity["project_name"],
        "Root admission request is outside the selected source group")

    copy_request, linux, plan_raw, plan, copy_result, bind_request, bind_result = _verified_bind_inputs(
        operation_root, request, request_sha256
    )
    _verify_plan_scope(source, distro, fence, identity, request, copy_request, linux, plan)
    drain = _verify_drain(operation_root, request, copy_request, linux, plan_raw, plan)

    _, journal = qualification._selected_journal(operation_root)
    events = journal["events"]
    previous = events[-1] if events else {}
    qualification.require(journal.get("volume_id") == request["volume_id"] and
        journal.get("request_sha256") == hashlib.sha256(plan_raw).hexdigest() and
        next_phase(journal) == "admission-prepared" and
        previous.get("phase") == "binds-switched" and previous.get("state") == "succeeded" and
        previous.get("inputs_sha256") == request["bind_request_sha256"] and
        previous.get("receipt_sha256") == request["bind_receipt_sha256"],
        "Root admission predecessor journal does not end at the exact bind terminal")
    bind_terminal = bind_job.validate_terminal(
        operation_root, bind_request, request["bind_request_sha256"], 0
    )
    qualification.require(bind_terminal["receipt_sha256"] == request["bind_receipt_sha256"] and
        bind_terminal["result"] == bind_result,
        "Root admission predecessor is not the exact completed bind receipt")

    _, ready = qualification._read(operation_root / "admission-fence-ready.json", request["fence_ready_sha256"])
    qualification.require(ready == fence.ready, "Root admission does not use the exact held fence acknowledgement")
    copy_stage.validate_held_fence(
        ready, request["token"], request["volume_id"], drain["process_receipt_sha256"]
    )

    for name in admission_stage.COMPONENTS:
        raw = qualification._read_optional_regular(
            source / "scripts" / name, "root admission component", maximum=4 * 1024**2
        )
        qualification.require(raw is not None and qualification.digest(raw) == request["components"][name],
                              "Root admission component source changed: " + name)

    relocated.require_relocated(fence.relocated, source, plan)
    command = [
        _wsl_executable(), "--distribution", distro, "--user", "root", "--exec",
        "/usr/bin/python3", "-I", "-B", "-c", _ROOT_ADMISSION_BOOTSTRAP,
        str(source), str(request_path), request_sha256,
        json.dumps(request["components"], sort_keys=True, separators=(",", ":")),
    ]
    return {
        "command": command,
        "operation_root": operation_root,
        "request": request,
        "request_sha256": request_sha256,
        "plan_raw": plan_raw,
        "plan": plan,
        "linux": linux,
        "copy_request": copy_request,
        "copy_result": copy_result,
        "bind_request": bind_request,
        "bind_result": bind_result,
        "drain": drain,
    }


def prepare_command(fence, source, distro, request_path, request_sha256):
    """Authenticate the exact bind successor and return a fixed root command."""
    context = _prepare_context(fence, source, distro, request_path, request_sha256)
    return context["command"], context["operation_root"], context["request"]


def _read_native_file(path, expected_entry=None):
    descriptor = native_host._open_nofollow(Path(path), os.O_RDONLY)
    try:
        before = os.fstat(descriptor)
        qualification.require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and
            before.st_size <= 1024 * 1024, "Admission native evidence must be one bounded regular file")
        chunks = []
        total = 0
        while True:
            chunk = os.read(descriptor, min(64 * 1024, 1024 * 1024 + 1 - total))
            if not chunk:
                break
            total += len(chunk)
            qualification.require(total <= 1024 * 1024, "Admission native evidence exceeds its byte budget")
            chunks.append(chunk)
        raw = b"".join(chunks)
        attrs = manifest._read_xattrs(descriptor, "admission native evidence")
        after = os.fstat(descriptor)
        qualification.require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns,
                               before.st_ctime_ns) ==
                              (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns,
                               after.st_ctime_ns) and len(raw) == before.st_size,
                              "Admission native evidence changed while reading")
        if expected_entry is not None:
            qualification.require(
                len(raw) == expected_entry["size"] and qualification.digest(raw) == expected_entry["sha256"] and
                stat.S_IMODE(before.st_mode) == expected_entry["mode"] and before.st_uid == expected_entry["uid"] and
                before.st_gid == expected_entry["gid"] and before.st_mtime_ns == expected_entry["mtime_ns"] and
                attrs == expected_entry["xattrs"],
                "Admission native evidence differs from the authenticated parent manifest",
            )
        return raw
    finally:
        os.close(descriptor)


def _native_manifest(context):
    result = context["copy_result"]
    raw = qualification._read_optional_regular(
        Path(result["manifest_path"]), "admission source manifest", maximum=bind_stage.MAX_MANIFEST_BYTES
    )
    qualification.require(raw is not None and qualification.digest(raw) == result["manifest_sha256"],
                           "Admission source manifest SHA changed")
    value = manifest._validate_manifest(
        qualification._parse_object(raw, "admission source manifest"), "admission source manifest"
    )
    qualification.require(value["data_sha256"] == result["data_sha256"],
                           "Admission source manifest data digest differs from the verified copy")
    expected_roots = {
        role: {"path": row["canonical_root"], "device": row["device"], "inode": row["inode"]}
        for role, row in context["linux"]["source_roots"].items()
    }
    qualification.require(value["roots"] == expected_roots,
                           "Admission source manifest no longer identifies the original roots")
    entries = {entry["path"]: entry for entry in value["entries"] if entry["role"] == "state"}
    required = set(native_host.READMISSION_FILES)
    qualification.require(required <= set(entries) and
        all(entries[name]["kind"] == "file" for name in required),
        "Admission source manifest lacks the five native parent files")
    return value, entries


def _snapshot_native_before(context):
    source_manifest, entries = _native_manifest(context)
    roots = context["bind_result"]["switch"]["roots"]
    old_state = Path(roots["state"]["backup_root"])
    new_state = Path(roots["state"]["canonical_root"])
    old_files = {}
    new_files = {}
    for name in native_host.READMISSION_FILES:
        entry = entries[name]
        old_files[name] = _read_native_file(old_state / name, entry)
        new_files[name] = _read_native_file(new_state / name, entry)
        qualification.require(old_files[name] == new_files[name],
                              "Admission OLD backup and NEW canonical native inputs differ")
    certificate = native_host._readmission_json(new_files[native_host.CERTIFICATE_NAME])
    owner = native_host._readmission_json(new_files[native_host.OWNER_NAME])
    qualification.require(owner == certificate and
        certificate.get("engine_id") == context["plan"]["observation"].get("engine_id") and
        certificate.get("image_id") == context["plan"]["runtime_pins"].get("image_id"),
        "Admission canonical certificate and owner differ from the selected engine/image")
    row = roots["state"]
    certificate_inode = native_host._readmission_certificate_inode(new_state)
    qualification.require(type(certificate_inode) is list and len(certificate_inode) == 5 and
        all(type(value) is int and value >= 0 for value in certificate_inode) and
        certificate_inode[0] == row["bound_identity"]["device"] and certificate_inode[4] == 1,
        "Admission canonical certificate inode differs from the verified new root")
    candidate = dict(certificate, host_device=row["bound_identity"]["device"],
                     host_inode=row["bound_identity"]["inode"], restart_verified=False)
    candidate_raw = native_host._readmission_encoded(candidate)
    return {
        "old_files": old_files,
        "new_files": new_files,
        "certificate_inode": certificate_inode,
        "candidate_raw": candidate_raw,
        "certificate_sha256": qualification.digest(candidate_raw),
        "source_data_sha256": source_manifest["data_sha256"],
    }


def _validate_native_after(context, expected_before):
    require = qualification.require
    require(type(expected_before) is dict and set(expected_before) == _NATIVE_SNAPSHOT_KEYS and
        type(expected_before["old_files"]) is dict and type(expected_before["new_files"]) is dict and
        set(expected_before["old_files"]) == set(native_host.READMISSION_FILES) and
        set(expected_before["new_files"]) == set(native_host.READMISSION_FILES) and
        type(expected_before["candidate_raw"]) is bytes and
        qualification.digest(expected_before["candidate_raw"]) == expected_before["certificate_sha256"],
        "Admission terminal lacks the authenticated pre-root native snapshot")
    state = Path(context["bind_result"]["switch"]["roots"]["state"]["canonical_root"])
    entries = _native_manifest(context)[1]
    after = {}
    for name in native_host.READMISSION_FILES:
        after[name] = _read_native_file(state / name, entries[name] if name in native_host.READMISSION_FILES[2:] else None)
    candidate_raw = expected_before["candidate_raw"]
    require(after[native_host.CERTIFICATE_NAME] == candidate_raw and
        after[native_host.OWNER_NAME] == candidate_raw and
        qualification.digest(candidate_raw) == expected_before["certificate_sha256"] and
        all(after[name] == expected_before["new_files"][name] for name in native_host.READMISSION_FILES[2:]) and
        native_host._readmission_certificate_inode(state) == expected_before["certificate_inode"],
        "Admission canonical certificate/owner, protected files or certificate inode changed unexpectedly")


def validate_terminal(operation_root, request, request_sha256, exit_code, *, expected_before=None):
    """Accept only exit-zero plus exact admission journal/result and native state."""
    require = qualification.require
    require(type(exit_code) is int, "An observed terminal root admission exit is required")
    require(exit_code == 0, "Root admission failure is outcome unknown; retain every guard and resource")
    require(type(request_sha256) is str and re.fullmatch(r"[0-9a-f]{64}", request_sha256),
            "Exact root admission request SHA required")
    request = admission_stage.validate_request(request)
    operation_root = Path(operation_root)
    require(operation_root == Path(request["storage_root"]) / "migrations/data-volumes" /
            request["volume_id"], "Root admission terminal escapes its selected operation")
    copy_request, linux, plan_raw, plan, copy_result, bind_request, bind_result = _verified_bind_inputs(
        operation_root, request, request_sha256
    )
    _, journal = qualification._selected_journal(operation_root)
    events = journal["events"]
    require(journal.get("volume_id") == request["volume_id"] and
        journal.get("request_sha256") == hashlib.sha256(plan_raw).hexdigest() and
        len(events) >= 8 and
        events[-4].get("phase") == "binds-switched" and events[-4].get("state") == "started" and
        events[-3].get("phase") == "binds-switched" and events[-3].get("state") == "succeeded" and
        events[-3].get("inputs_sha256") == request["bind_request_sha256"] and
        events[-3].get("receipt_sha256") == request["bind_receipt_sha256"] and
        events[-2].get("phase") == "admission-prepared" and events[-2].get("state") == "started" and
        events[-2].get("inputs_sha256") == request_sha256 and
        events[-1].get("phase") == "admission-prepared" and events[-1].get("state") == "succeeded" and
        events[-1].get("inputs_sha256") == request_sha256,
        "Root admission journal is missing, late, ambiguous or outside the exact bind lineage")
    started_path = operation_root / "linux-admission-started.json"
    _, started = qualification._read(started_path)
    require(type(started) is dict and set(started) == {"schema", "volume_id", "token", "request_sha256"} and
        started["schema"] == "fullmag.data-volume-admission-started.v1" and
        started["volume_id"] == request["volume_id"] and started["token"] == request["token"] and
        started["request_sha256"] == request_sha256,
        "Root admission started record differs from the selected request")

    result_path = operation_root / "linux-admission-result.json"
    failure_path = operation_root / "linux-admission-failed.json"
    require(not os.path.lexists(failure_path), "Root admission success conflicts with a failure artifact")
    raw, result = qualification._read(result_path, events[-1]["receipt_sha256"])
    expected_keys = {
        "schema", "state", "volume_id", "token", "request_sha256", "bind_receipt_sha256",
        "copy_receipt_sha256", "pending_marker", "preparation", "source_data_sha256",
        "namespace_admitted", "data_migrated", "originals_retired",
    }
    require(type(result) is dict and set(result) == expected_keys and
        result["schema"] == "fullmag.data-volume-linux-admission-result.v1" and
        result["state"] == "admission-prepared-not-admitted" and
        result["volume_id"] == request["volume_id"] and result["token"] == request["token"] and
        result["request_sha256"] == request_sha256 and
        result["bind_receipt_sha256"] == request["bind_receipt_sha256"] and
        result["copy_receipt_sha256"] == bind_request["copy_receipt_sha256"] and
        result["source_data_sha256"] == copy_result["data_sha256"] and
        result["namespace_admitted"] is False and result["data_migrated"] is False and
        result["originals_retired"] is False,
        "Root admission success receipt scope or authority flags differ")

    preparation = result["preparation"]
    archive = Path(linux["mount_root"]) / "migration" / request["volume_id"] / "state-admission.json"
    require(type(preparation) is dict and set(preparation) == {
        "schema", "state", "volume_id", "archive", "certificate_sha256", "namespace_admitted",
        "originals_retired",
    } and preparation["schema"] == "fullmag.data-volume-admission-apply.v1" and
        preparation["state"] == "admission-prepared-not-admitted" and
        preparation["volume_id"] == request["volume_id"] and
        type(preparation["archive"]) is dict and set(preparation["archive"]) == {"path", "sha256"} and
        preparation["archive"]["path"] == str(archive) and
        type(preparation["archive"]["sha256"]) is str and
        re.fullmatch(r"[0-9a-f]{64}", preparation["archive"]["sha256"]) and
        type(preparation["certificate_sha256"]) is str and
        re.fullmatch(r"[0-9a-f]{64}", preparation["certificate_sha256"]) and
        preparation["namespace_admitted"] is False and preparation["originals_retired"] is False,
        "Root admission preparation archive or authority scope differs")
    _validate_pending_reference(
        result["pending_marker"], request, copy_request, bind_request, bind_result, linux, plan_raw, plan
    )
    require(type(expected_before) is dict and set(expected_before) == _NATIVE_SNAPSHOT_KEYS and
        expected_before["certificate_sha256"] == preparation["certificate_sha256"] and
        expected_before["source_data_sha256"] == result["source_data_sha256"],
        "Root admission result differs from the pre-root native snapshot")
    _validate_native_after({
        "bind_result": bind_result,
        "copy_result": copy_result,
        "linux": linux,
        "plan": plan,
    }, expected_before)
    return {"state": result["state"], "receipt_sha256": hashlib.sha256(raw).hexdigest(), "result": result}


def run_root_admission(fence, source, distro, request_path, request_sha256, *, poll_interval=2.0,
                       retain_native_snapshot=False):
    """Keep the old copy fence until exact successful admission preparation."""
    qualification.require(type(retain_native_snapshot) is bool,
                          "Native snapshot retention must be an internal boolean")
    qualification.require(type(poll_interval) in (int, float) and 0 < poll_interval <= 5,
                          "Bounded root-client polling interval required")
    fence.check()
    context = _prepare_context(fence, source, distro, request_path, request_sha256)
    expected_before = _snapshot_native_before(context)
    fence.check()
    relocated.require_relocated(fence.relocated, Path(source), context["plan"])

    def validate(op, request, request_sha, exit_code):
        return validate_terminal(op, request, request_sha, exit_code, expected_before=expected_before)

    terminal = run_prepared_root(
        "admission", fence, context["command"], context["operation_root"], context["request"],
        context["request_sha256"], validate,
        release_copy_sha256=context["bind_request"]["copy_receipt_sha256"],
        poll_interval=poll_interval,
    )
    if retain_native_snapshot:
        return terminal, deepcopy(expected_before)
    return terminal
