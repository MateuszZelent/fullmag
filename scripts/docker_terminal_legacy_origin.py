"""Pure qualification of an explicitly selected historical source activation.

The managed caller supplies bounded, no-follow bytes, complete startup lease
inventories for both lease families, and a stable/quiescent scope. This function
cannot detect omitted inventory entries and neither reads files nor authorizes
stop, restore, admission, history removal, or a solver invocation.
"""
from __future__ import annotations

import posixpath
import re
import os
from pathlib import Path

import docker_activation_history_policy as history
from docker_terminal_source_origin import validate_source_origin


SCHEMA = "fullmag.terminal-legacy-source-activation.v1"
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}\Z")


def _need(condition, message):
    if not condition:
        raise ValueError(message)


def _object(value, label):
    _need(isinstance(value, dict), label + " must be an object")
    return value


def _identifier(value, label):
    _need(isinstance(value, str) and _ID.fullmatch(value) is not None,
          label + " is invalid")
    return value


def _digest(value, label):
    _need(isinstance(value, str) and history.SHA.fullmatch(value) is not None,
          label + " is invalid")
    return value


def _intent(raw, label):
    intent = history.document(raw, label)
    _need(intent.get("schema_version") == "run_intent.v1", label + " schema differs")
    run_id = _identifier(intent.get("run_id"), label + " run")
    spec = _object(intent.get("specification"), label + " specification")
    _need(spec.get("run_id") == run_id, label + " specification run differs")
    snapshot = _object(spec.get("snapshot"), label + " snapshot")
    definition = _digest(intent.get("definition_object_ref"), label + " definition reference")
    _need(snapshot.get("definition_sha256") == definition,
          label + " snapshot definition differs from its object")
    _identifier(snapshot.get("project_id"), label + " project")
    revision = snapshot.get("definition_revision")
    _need(type(revision) is int and revision >= 0, label + " definition revision is invalid")
    parameters = _object(spec.get("parameters"), label + " parameters")
    live = _object(parameters.get("live_workspace"), label + " live workspace")
    _identifier(live.get("session_id"), label + " session")
    epoch = live.get("session_epoch")
    _need(type(epoch) is int and 0 < epoch <= (1 << 64) - 1,
          label + " accepted session epoch is invalid")
    _need(type(live.get("scene_revision")) is int and live["scene_revision"] == revision,
          label + " scene revision differs")
    execution = _object(live.get("execution_input"), label + " execution input")
    _need(set(execution) == {"schema_version", "sha256"}
          and execution.get("schema_version") == "fullmag.scene_execution_input.v1",
          label + " execution input schema differs")
    _digest(execution.get("sha256"), label + " execution input digest")
    return intent, snapshot, live


def qualify_legacy_source_origin(*, activation_attempt, activation_receipt_sha256,
                                activation_files, startup_catalog_raw, startup_intent_raw,
                                startup_lease_records, restored_intent_raw, preflight,
                                source_origin, project, volume, source_root, namespace=""):
    """Return only two qualified preflight additions, without mutating inputs.

    ``source_origin`` is supplied by the caller's no-follow source observation;
    this pure function validates its DTO and binds it to historical evidence.
    Inventory completeness and current source bytes remain caller obligations.
    """
    _need(isinstance(activation_attempt, str)
          and history.ATTEMPT.fullmatch(activation_attempt) is not None,
          "Explicit activation attempt is invalid")
    _digest(activation_receipt_sha256, "Explicit activation receipt digest")
    _identifier(project, "Compose project")
    _identifier(volume, "Control volume")
    _need(isinstance(namespace, str) and "\x00" not in namespace, "Control namespace is invalid")
    _need(isinstance(source_root, str) and source_root.startswith("/")
          and source_root != "/" and "\\" not in source_root and "\x00" not in source_root
          and posixpath.normpath(source_root) == source_root
          and not source_root.startswith("//")
          and all(part not in {".", ".."} for part in source_root.split("/")[1:]),
          "Selected source root is not canonical")
    preflight = _object(preflight, "Terminal preflight")
    _need("source_origin" not in preflight and "source_origin_legacy_activation" not in preflight,
          "Terminal preflight already contains a source origin")
    _need(preflight.get("schema") == "fullmag.docker-terminal-session-drain-preflight.v1",
          "Terminal preflight schema differs")
    origin = validate_source_origin(source_origin)
    _need(origin is not None, "Explicit source origin is required")
    files = _object(activation_files, "Activation files")
    _need(isinstance(files.get("receipt.json"), bytes)
          and history.digest(files["receipt.json"]) == activation_receipt_sha256,
          "Activation receipt bytes differ from explicit pin")
    qualified = history.qualify_activation(
        activation_attempt, files, project=project, volume=volume, namespace=namespace,
        run_catalog_raw=startup_catalog_raw, run_intent_raw=startup_intent_raw,
        lease_records=startup_lease_records)
    startup, startup_snapshot, startup_live = _intent(startup_intent_raw, "Startup intent")
    restored, restored_snapshot, restored_live = _intent(restored_intent_raw, "Restored intent")
    public_run = _object(preflight.get("run"), "Terminal public run")
    _need(public_run.get("status") in ("completed", "failed")
          and restored["run_id"] == public_run.get("run_id")
          and restored_live["session_id"] == preflight.get("session_id")
          and public_run.get("session_id") == preflight.get("session_id"),
          "Restored intent differs from terminal run/session")
    api = _identifier(preflight.get("api_instance_id"), "Terminal API instance")
    scope = preflight.get("request_scope_epoch")
    _need(isinstance(scope, str) and scope.startswith(api + ":"), "Terminal request scope differs")
    epoch_text = scope[len(api) + 1:]
    _need(re.fullmatch(r"[1-9][0-9]{0,19}", epoch_text) is not None
          and int(epoch_text) == restored_live["session_epoch"],
          "Terminal accepted session epoch differs")
    # A terminal restore changes the live API instance. The immutable intent's
    # historical API is not the current API: native capture authenticates that
    # runtime lineage separately. This helper only qualifies the source origin.
    _need(startup["run_id"] == qualified["run_id"]
          and startup_live["session_id"] == qualified["session_id"]
          and startup_live["session_id"] == restored_live["session_id"]
          and startup_live["session_epoch"] == restored_live["session_epoch"]
          and startup["definition_object_ref"] == restored["definition_object_ref"]
          and startup_snapshot == restored_snapshot
          and startup_live["execution_input"] == restored_live["execution_input"]
          and type(preflight.get("scene_revision")) is int
          and preflight["scene_revision"] == restored_snapshot["definition_revision"],
          "Startup and restored intent definition/session/execution binding differs")
    request = qualified["request_id"]
    _need(startup_live.get("startup_source_sha256") == qualified["source_sha256"]
          and startup_live.get("command_id") == request
          and startup_live.get("request_idempotency_key") == request
          and startup_live.get("command") == {
              "kind": "startup_script", "request_id": request,
              "source_sha256": qualified["source_sha256"]},
          "Startup intent command/source binding differs")
    provenance = history.document(files["startup-provenance.json"], "Startup provenance")
    _need(provenance.get("source_root") == source_root
          and provenance.get("container_source_root") == "/opt/fullmag/source"
          and provenance.get("container_script_path") == "/opt/fullmag/source/" + origin["source_relative"]
          and type(provenance.get("source_size_bytes")) is int
          and all(provenance.get(key) == origin[key]
                  for key in ("source_relative", "source_sha256", "source_size_bytes")),
          "Selected source origin differs from activated provenance")
    return {
        "source_origin": origin,
        "source_origin_legacy_activation": {
            "schema": SCHEMA,
            "activation_attempt": activation_attempt,
            "activation_receipt_sha256": activation_receipt_sha256,
            "startup_run_id": startup["run_id"],
            "startup_intent_sha256": history.digest(startup_intent_raw),
            "restored_run_id": restored["run_id"],
            "restored_intent_sha256": history.digest(restored_intent_raw),
        },
    }


def validate_options(args, *, restart_idle_service, stop_after_drain,
                     recreate_services=False, resume_recreation_id=None,
                     refresh_frontend_service=False, retire_only=False):
    """Validate explicit pins before the caller performs any runtime action."""
    attempt = getattr(args, "terminal_source_activation", None)
    digest = getattr(args, "terminal_source_activation_sha256", None)
    if attempt is None and digest is None:
        return None
    _need(isinstance(attempt, str) and history.ATTEMPT.fullmatch(attempt) is not None,
          "Terminal source activation requires an explicit attempt and receipt SHA-256")
    _digest(digest, "Terminal source activation receipt SHA-256")
    _need(restart_idle_service and stop_after_drain and not recreate_services
          and resume_recreation_id is None and not refresh_frontend_service and not retire_only
          and getattr(args, "capture_terminal_observation", False) is True
          and not any(getattr(args, name, None) for name in (
              "quiesce_api", "capture_native_terminal", "capture_prelaunch_failure",
              "saved_authoring_checkpoint", "saved_authoring_checkpoint_sha256")),
          "Terminal source activation is supported only by a normal terminal-capture stop-only operation")
    return attempt, digest


def _lease_inventory(store_root, run_id):
    """Read both exact lease families with pinned directory FDs and bookends."""
    from docker_volume_accepted_reattach import _read_store_regular

    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
    root = Path(store_root)
    _need(root.is_absolute() and str(root) == posixpath.normpath(str(root)),
          "Startup store root is not canonical")
    descriptors = []
    observations = []
    links = []
    result = {}
    total = 0

    def opened(parent, name, *, observe=True):
        fd = os.open(name, flags, dir_fd=parent)
        descriptors.append(fd)
        links.append((parent, name, fd))
        if observe:
            observations.append((fd, os.fstat(fd)))
        return fd

    def identity(info):
        return info.st_dev, info.st_ino, info.st_mtime_ns, info.st_ctime_ns

    def same_link(parent, name, fd):
        current = os.stat(name, dir_fd=parent, follow_symlinks=False)
        pinned = os.fstat(fd)
        return (current.st_dev, current.st_ino) == (pinned.st_dev, pinned.st_ino)

    try:
        fd = os.open("/", flags)
        descriptors.append(fd)
        for part in root.parts[1:]:
            _need(part not in {"", ".", ".."}, "Startup store root is not canonical")
            fd = opened(fd, part, observe=False)
        fd = opened(opened(fd, "runs"), _identifier(run_id, "Startup run"))
        for family in ("resource_leases", "preparation_resource_leases"):
            try:
                family_fd = opened(fd, family)
            except FileNotFoundError:
                continue
            with os.scandir(family_fd) as entries:
                resources = sorted(entry.name for entry in entries)
            _need(len(resources) <= 4096, "Startup lease directory inventory exceeds its bound")
            for resource in resources:
                _identifier(resource, "Startup lease resource")
                resource_fd = opened(family_fd, resource)
                with os.scandir(resource_fd) as entries:
                    names = sorted(entry.name for entry in entries)
                _need(len(names) + len(result) <= 4096, "Startup lease file inventory exceeds its bound")
                for name in names:
                    _need(name.endswith(".json"), "Startup lease filename is not JSON")
                    _identifier(name[:-5], "Startup lease identity")
                    relative = f"runs/{run_id}/{family}/{resource}/{name}"
                    raw = _read_store_regular(root, relative, "startup source lease",
                                              maximum=history.MAX_DOCUMENT_BYTES)
                    total += len(raw)
                    _need(total <= history.MAX_ATTEMPT_BYTES, "Startup lease bytes exceed their bound")
                    result[relative] = raw
        _need(all(identity(before) == identity(os.fstat(fd)) for fd, before in observations),
              "Startup lease directories changed during inventory")
        # Check ancestor identities without rejecting unrelated changes to their
        # directory entries. The path-based regular reader must still reach the
        # exact namespace whose complete lease entries were enumerated above.
        _need(all(same_link(parent, name, fd) for parent, name, fd in links),
              "Startup lease namespace changed during inventory")
        return result
    finally:
        for fd in reversed(descriptors):
            os.close(fd)


def augment_preflight(preflight, *, pins, control, store_root, source_root,
                      project, volume, namespace=""):
    """Read-only managed adapter; repeat it for the final pre-drain comparison.

    The caller holds the existing operation and quiescence fences. No run,
    lease, source file or control record is created or modified here.
    """
    if pins is None:
        return preflight
    from docker_volume_accepted_reattach import _control_bytes, _read_store_regular
    from docker_terminal_source_origin import capture_source_origin

    preflight = _object(preflight, "Terminal preflight")
    attempt, receipt_sha = pins
    _need(isinstance(attempt, str) and history.ATTEMPT.fullmatch(attempt) is not None,
          "Explicit activation attempt is invalid")
    _digest(receipt_sha, "Explicit activation receipt digest")
    files = {name: _control_bytes(control, f"activation/attempts/{attempt}/{name}",
                                  maximum=(history.MAX_LOG_BYTES if name == "build.log"
                                           else history.MAX_DOCUMENT_BYTES))
             for name in sorted(history.REQUIRED)}
    receipt = history.document(files["receipt.json"], "Source activation receipt")
    _need(history.digest(files["receipt.json"]) == receipt_sha,
          "Activation receipt bytes differ from explicit pin")
    startup_run = _identifier(receipt.get("run_id"), "Startup run")
    restored_run = _identifier(_object(preflight.get("run"), "Terminal public run").get("run_id"),
                               "Restored run")
    provenance = history.document(files["startup-provenance.json"], "Source activation provenance")
    relative = provenance.get("source_relative")
    # The DTO validator checks portability before this path reaches a reader.
    expected = validate_source_origin({
        "schema": "fullmag.selected-script-origin.v1", "source_relative": relative,
        "source_sha256": provenance.get("source_sha256"),
        "source_size_bytes": provenance.get("source_size_bytes"),
    })
    selected = str(source_root)
    origin = capture_source_origin({"origin": "user_file", "path": selected + "/" + relative},
                                   source_root=Path(selected))
    _need(origin == expected, "Selected script bytes differ from activated origin")
    read = lambda relative, label: _read_store_regular(Path(store_root), relative, label,
                                                      maximum=history.MAX_DOCUMENT_BYTES)
    additions = qualify_legacy_source_origin(
        activation_attempt=attempt, activation_receipt_sha256=receipt_sha,
        activation_files=files,
        startup_catalog_raw=read(f"runs/{startup_run}/run_catalog.json", "startup source catalog"),
        startup_intent_raw=read(f"runs/{startup_run}/run_intent.json", "startup source intent"),
        startup_lease_records=_lease_inventory(store_root, startup_run),
        restored_intent_raw=read(f"runs/{restored_run}/run_intent.json", "restored source intent"),
        preflight=preflight, source_origin=origin, project=project, volume=volume,
        source_root=selected, namespace=namespace)
    return {**preflight, **additions}
