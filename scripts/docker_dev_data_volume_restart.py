"""Restart one prepared migrated DEV group under its original live copy scope.

Removal is exact and irreversible; start uses the ordinary DEV launcher with
the authenticated retained runtime. This module has no CLI or cleanup path.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import importlib
import os
from pathlib import Path
import re
import threading

from data_volume_copy_fence_service import COMPONENTS as FENCE_COMPONENTS
from docker_build_control import docker_capture
from docker_data_volume_copy_guard import CopyFence
from docker_data_volume_removed_group import observe_removed_group
from docker_data_volume_stopped_group import observe_stopped_group
import docker_data_volume_startup_scope as startup_scope
import linux_data_volume_provision as qualification
from linux_data_volume_format import _document


ARTIFACTS = (
    "restart-removal-intent.json",
    "restart-removal-result.json",
    "restart-start-intent.json",
    "restart-start-result.json",
    "restart-result.json",
    "restart-failure.json",
)


def require(value, message):
    qualification.require(value, message)


def _restart_context_module():
    module = importlib.import_module("docker_data_volume_restart_context")
    require(Path(module.__file__).resolve() ==
            Path(__file__).with_name("docker_data_volume_restart_context.py").resolve(),
            "Retained restart context helper differs from the local source")
    return module


def _control(issuer, context):
    control = issuer._existing_control(context["identity"], context["plan"]["runtime_pins"]["image_id"])
    require(control.project == context["identity"]["project_name"] == context["plan"]["compose_project"] and
            control.image == context["plan"]["runtime_pins"]["image_id"] and
            control.namespace == "",
            "Restart control identity/image/namespace differs from the prepared group")
    return control


def _check_no_replay(prepared, operation_root):
    require(getattr(prepared, "_retained_restart", None) is None and
            getattr(prepared, "_restart_started_group", None) is None,
            "This prepared group already attempted or issued a restart; reconcile without replay")
    for name in ARTIFACTS:
        require(not os.path.lexists(operation_root / name),
                "Restart artifacts already exist; reconcile without replay")


def _component_pins(copy_parent, source, names):
    return copy_parent._pins(source, names)


def _recheck_components(copy_parent, source, helper, component_pins, fence_pins):
    require(_component_pins(copy_parent, source, helper.COMPONENTS) == component_pins and
            _component_pins(copy_parent, source, FENCE_COMPONENTS) == fence_pins,
            "Restart controller/fence source changed under its retained guards")


def _same_stopped_snapshot(before, after):
    require(after["source_proof"] == before["source_proof"] and
            after["process_receipt_sha256"] == before["process_receipt_sha256"] and
            type(after.get("actual")) is dict and set(after["actual"]) == {"backend", "frontend"} and
            all(after["actual"][role].get("Id") == before["actual"][role].get("Id") and
                after["actual"][role].get("Image") == before["actual"][role].get("Image")
                for role in ("backend", "frontend")),
            "Stopped service/source/process evidence changed under the OLD fence")


def _checkpoint(control, operation, *, state, extra):
    operation["receipt"].update(state=state, **extra)
    control.write(operation["root"] + "/receipt.json", operation["receipt"])


def _validate_rm_result(result, requested):
    require(type(getattr(result, "returncode", None)) is int and result.returncode == 0,
            "Exact Docker service removal did not complete successfully; retain guards and reconcile")
    stdout = getattr(result, "stdout", None)
    require(type(stdout) is bytes, "Docker service removal has no exact terminal stdout")
    try:
        lines = stdout.decode("ascii", "strict").splitlines()
    except UnicodeDecodeError as error:
        raise ValueError("Docker service removal IDs are not ASCII") from error
    require(len(lines) == 2 and len(set(lines)) == 2 and
            all(re.fullmatch(r"[0-9a-f]{64}", value) for value in lines) and set(lines) == set(requested),
            "Docker removal did not return exactly the requested full container IDs")
    return sorted(lines)


def _validate_removed_result(value, old_ids):
    require(type(value) is dict and set(value) == {
        "state", "removed_containers", "observed_container_ids", "consumers"
    } and value.get("state") == "removed-services-observed" and
        value.get("removed_containers") == old_ids and value.get("consumers") == [] and
        type(value.get("observed_container_ids")) is list and
        value["observed_container_ids"] == sorted(set(value["observed_container_ids"])) and
        all(type(identifier) is str and re.fullmatch(r"[0-9a-f]{64}", identifier)
            for identifier in value["observed_container_ids"]) and
        set(old_ids.values()).isdisjoint(value["observed_container_ids"]),
        "Full post-removal container/consumer observation differs")
    return value


def _validate_start_arguments(args, kwargs, context):
    require(type(kwargs) is dict and kwargs.get("capture_terminal") is True and
            "control" not in kwargs and "operation" not in kwargs and
            kwargs.get("previous_config_sha256") is None and
            getattr(args, "script", None) is None and
            getattr(args, "profile", None) == "dev" and
            Path(getattr(args, "source_root", "")) == Path(context["source"]),
            "Retained start must use the standard captured DEV start without a script or old config pin")


def _validate_started_evidence(value, *, old_ids=None, old_attempt=None):
    keys = {
        "schema", "development_attempt", "development_terminal", "config_sha256", "source_commit",
        "source_snapshot_sha256", "backend_build_receipt_sha256", "containers", "certificate_sha256",
        "namespace_admitted", "data_migrated", "originals_retired",
    }
    require(type(value) is dict and set(value) == keys and
            value.get("schema") == "fullmag.data-volume-started-evidence.v1" and
            value.get("namespace_admitted") is True and value.get("data_migrated") is False and
            value.get("originals_retired") is False and
            type(value.get("development_attempt")) is str and
            re.fullmatch(r"[0-9a-f]{32}", value["development_attempt"]) and
            type(value.get("development_terminal")) is dict and
            set(value["development_terminal"]) == {"relative", "sha256"} and
            type(value["development_terminal"].get("relative")) is str and
            value["development_terminal"]["relative"] ==
                "development/attempts/" + value["development_attempt"] + "/terminal.json" and
            type(value["development_terminal"].get("sha256")) is str and
            re.fullmatch(r"[0-9a-f]{64}", value["development_terminal"]["sha256"]) and
            all(type(value.get(key)) is str and re.fullmatch(r"[0-9a-f]{64}", value[key])
                for key in ("config_sha256", "source_snapshot_sha256", "backend_build_receipt_sha256",
                            "certificate_sha256")) and
            type(value.get("source_commit")) is str and re.fullmatch(r"[0-9a-f]{40}", value["source_commit"]) and
            type(value.get("containers")) is dict and set(value["containers"]) == {"backend", "frontend"} and
            all(type(identifier) is str and re.fullmatch(r"[0-9a-f]{64}", identifier)
                for identifier in value["containers"].values()) and
            value["containers"]["backend"] != value["containers"]["frontend"],
            "Started runtime evidence is not the exact closed qualified start record")
    if old_ids is not None:
        old_values = tuple(old_ids.values()) if type(old_ids) is dict else tuple(old_ids)
        require(set(value["containers"].values()).isdisjoint(old_values) and
                value["development_attempt"] != old_attempt,
                "Started runtime reused a retained old service or terminal identity")
    return deepcopy(value)


class StartedGroup:
    """In-process proof of one exact standard start tied to the live prepared group."""
    __slots__ = (
        "_prepared", "_pid", "_thread", "_record", "_snapshot", "_control",
        "_helper", "_restart", "_operation", "_operation_snapshot", "_operation_root",
    )

    def __init__(self, prepared, record, *, control, helper, restart_context, operation, operation_root):
        frozen = deepcopy(record)
        object.__setattr__(self, "_prepared", prepared)
        object.__setattr__(self, "_pid", os.getpid())
        object.__setattr__(self, "_thread", threading.get_ident())
        object.__setattr__(self, "_record", frozen)
        object.__setattr__(self, "_snapshot", deepcopy(frozen))
        object.__setattr__(self, "_control", control)
        object.__setattr__(self, "_helper", helper)
        object.__setattr__(self, "_restart", restart_context)
        object.__setattr__(self, "_operation", operation)
        object.__setattr__(self, "_operation_snapshot", deepcopy(operation["receipt"]))
        object.__setattr__(self, "_operation_root", Path(operation_root))

    def __setattr__(self, _name, _value):
        raise AttributeError("started-group capabilities are immutable")

    def as_record(self):
        return deepcopy(self._record)


def require_started_group(value, prepared):
    require(type(value) is StartedGroup and value._prepared is prepared and
            getattr(prepared, "_restart_started_group", None) is value and
            value._pid == os.getpid() and value._thread == threading.get_ident() and
            value._record == value._snapshot,
            "The exact live started-group capability is required")
    startup_scope._require_prepared(prepared)
    require(value._control._active_operation is None and
            value._operation.get("daemon_pending") is False and
            value._operation.get("receipt") == value._operation_snapshot and
            value._operation_snapshot.get("state") == "succeeded" and
            value._operation_snapshot.get("copy_receipt_acknowledgement_sha256") ==
                prepared["context"]["copy_receipt_sha256"] and
            not os.path.lexists(value._operation_root / "restart-failure.json"),
            "The original copy-fence acknowledgement or terminal operation changed")
    published = _read_published(value._operation_root, "restart-result.json",
                                value._record["receipt_sha256"])
    require(published == value._record["result"] and
            published.get("volume_id") == prepared["context"]["linux"]["volume_id"] and
            published.get("compose_project") == value._control.project and
            published.get("source_root") == str(prepared["context"]["source"]),
            "Published restart record no longer identifies the prepared group")
    _validate_published_result(value._operation_root, published, value._record["receipt_sha256"],
                               context=prepared["context"], control=value._control)
    removal = _read_published(value._operation_root, "restart-removal-result.json",
                              published["removal_result_sha256"])
    require(removal.get("intent_sha256") == getattr(prepared, "_restart_attempt_marker", None),
            "The issued restart capability does not match its retained removal intent")
    evidence = value._record["result"]["started_evidence"]
    require(value._helper.revalidate_started(value._control, prepared, value._restart, evidence) == evidence,
            "Started runtime evidence changed after publication")
    return value.as_record()


def _read_published(operation_root, name, expected_sha256):
    raw, value = qualification._read(Path(operation_root) / name)
    require(hashlib.sha256(raw).hexdigest() == expected_sha256,
            "Published restart evidence SHA differs: " + name)
    return value


def _validate_published_result(operation_root, final_record, final_sha256, *, context, control):
    require(type(final_record) is dict and set(final_record) == {
        "schema", "state", "volume_id", "compose_project", "source_root", "removal_result_sha256",
        "start_intent_sha256", "start_result_sha256", "started_evidence", "namespace_admitted",
        "data_migrated", "originals_retired",
    } and final_record.get("schema") == "fullmag.data-volume-restart-result.v1" and
        final_record.get("state") == "runtime-started-not-scientifically-qualified" and
        final_record.get("volume_id") == context["linux"]["volume_id"] and
        final_record.get("compose_project") == control.project and
        final_record.get("source_root") == str(context["source"]) and
        final_record.get("namespace_admitted") is True and final_record.get("data_migrated") is False and
        final_record.get("originals_retired") is False and
        type(final_sha256) is str and re.fullmatch(r"[0-9a-f]{64}", final_sha256) and
        not os.path.lexists(Path(operation_root) / "restart-failure.json"),
        "Published restart result is not the closed terminal")
    removal = _read_published(operation_root, "restart-removal-result.json",
                              final_record["removal_result_sha256"])
    intent = _read_published(operation_root, "restart-removal-intent.json",
                              removal.get("intent_sha256"))
    start_intent = _read_published(operation_root, "restart-start-intent.json",
                                    final_record["start_intent_sha256"])
    start_result = _read_published(operation_root, "restart-start-result.json",
                                    final_record["start_result_sha256"])
    old_ids = {role: context["plan"]["runtime_pins"][role] for role in ("backend", "frontend")}
    require(type(removal) is dict and set(removal) == {
                "schema", "state", "volume_id", "old_containers", "docker_rm_container_ids",
                "observed_container_ids", "consumers", "intent_sha256", "copy_receipt_sha256",
            } and removal.get("schema") == "fullmag.data-volume-restart-removal-result.v1" and
            removal.get("state") == "removed-services-observed" and
            removal.get("volume_id") == context["linux"]["volume_id"] and
            removal.get("old_containers") == old_ids and
            removal.get("docker_rm_container_ids") == sorted(old_ids.values()) and
            type(removal.get("observed_container_ids")) is list and
            old_ids["backend"] not in removal["observed_container_ids"] and
            old_ids["frontend"] not in removal["observed_container_ids"] and
            removal.get("consumers") == [] and
            removal.get("copy_receipt_sha256") == context["copy_receipt_sha256"] and
            type(intent) is dict and set(intent) == {
                "schema", "volume_id", "source_root", "old_containers", "copy_receipt_sha256",
                "retained_restart", "controller_components", "fence_components",
            } and intent.get("schema") == "fullmag.data-volume-restart-removal-intent.v1" and
            intent.get("volume_id") == context["linux"]["volume_id"] and
            intent.get("source_root") == str(context["source"]) and intent.get("old_containers") == old_ids and
            intent.get("copy_receipt_sha256") == context["copy_receipt_sha256"] and
            type(start_intent) is dict and set(start_intent) == {
                "schema", "volume_id", "source_root", "removal_result_sha256", "retained_restart",
            } and start_intent.get("schema") == "fullmag.data-volume-restart-start-intent.v1" and
            start_intent.get("volume_id") == context["linux"]["volume_id"] and
            start_intent.get("source_root") == str(context["source"]) and
            start_intent.get("removal_result_sha256") ==
                final_record["removal_result_sha256"] and
            start_intent.get("retained_restart") == intent.get("retained_restart") and
            type(start_result) is dict and set(start_result) == {
                "schema", "state", "start_intent_sha256", "removal_result_sha256", "started_evidence",
            } and start_result.get("schema") == "fullmag.data-volume-restart-start-result.v1" and
            start_result.get("state") == final_record["state"] and
            start_result.get("start_intent_sha256") == final_record["start_intent_sha256"] and
            start_result.get("removal_result_sha256") == final_record["removal_result_sha256"] and
            start_result.get("started_evidence") == final_record["started_evidence"],
            "Published restart result chain changed")
    pins = context["plan"]["runtime_pins"]
    return _validate_started_evidence(
        final_record["started_evidence"], old_ids={role: pins[role] for role in ("backend", "frontend")},
        old_attempt=pins["attempt"],
    )


def _retain_postpublication_failure(operation_root, start_result_sha256, restart_result_sha256, error):
    record = {
        "schema": "fullmag.data-volume-restart-failure.v1",
        "state": "outcome-unknown-resources-retained",
        "stage": "post-publication-revalidation",
        "start_result_sha256": start_result_sha256,
        "restart_result_sha256": restart_result_sha256,
        "error_type": type(error).__name__,
    }
    try:
        _document(operation_root, "restart-failure.json", record)
    except BaseException:
        # Preserve the original validation error; the durable success files and
        # unissued in-process capability still block any replay.
        pass


def restart_prepared_group(prepared):
    """Remove the exact old pair, then use the standard captured DEV start."""
    issuer = startup_scope._require_prepared(prepared)
    context = prepared["context"]
    require(type(context) is dict and isinstance(context.get("source"), Path) and
            type(context.get("plan")) is dict and type(context.get("layout")) is dict and
            type(context.get("identity")) is dict and type(context.get("linux")) is dict and
            type(context.get("drain")) is dict,
            "Closed prepared restart source context is required")
    operation_root = Path(context["operation_root"])
    _check_no_replay(prepared, operation_root)
    copy_parent = issuer.copy_parent
    restart_context = _restart_context_module()
    source = context["source"]
    component_pins = _component_pins(copy_parent, source, restart_context.COMPONENTS)
    fence_pins = _component_pins(copy_parent, source, FENCE_COMPONENTS)
    control = _control(issuer, context)
    require(control._active_operation is None,
            "A prior managed operation is still open; restart cannot overlap it")

    with startup_scope.startup_scope(prepared) as active_scope:
        require(startup_scope.current_scope() is active_scope,
                "The exact prepared pending-volume scope is not active")
        _check_no_replay(prepared, operation_root)
        plan = context["plan"]
        pins = plan["runtime_pins"]
        old_ids = {"backend": pins["backend"], "frontend": pins["frontend"]}
        volume_id = context["linux"]["volume_id"]
        copied_receipt = context["copy_receipt_sha256"]
        drain = context["drain"]
        inputs = {
            "source_root": str(source),
            "image_id": plan["runtime_pins"]["image_id"],
            "volume_id": volume_id,
            "stage": "prepared-service-restart",
            "plan_sha256": context["plan_sha256"],
            "copy_receipt_sha256": copied_receipt,
            "bind_receipt_sha256": prepared["bound_terminal"]["receipt_sha256"],
            "admission_receipt_sha256": prepared["terminal"]["receipt_sha256"],
            "controller_components": component_pins,
            "fence_components": fence_pins,
        }
        with control.operation("data-volume-migration", inputs) as operation:
            require(operation.get("daemon_pending") is False and
                    operation["receipt"].get("phase") == "data-volume-migration",
                    "Restart requires its separate active migration operation")
            before = observe_stopped_group(
                control, source, plan, drain["stop_attempt"], drain["stop_sha256"],
                relocated=prepared["relocated"],
            )
            require(before["process_receipt_sha256"] == drain["process_receipt_sha256"],
                    "Terminal source process proof differs from the retained copy")
            token = operation["receipt"]["attempt"]
            fence_request = {
                "schema": "fullmag.data-copy-fence-request.v1",
                "token": token,
                "volume_id": volume_id,
                "process_receipt_sha256": before["process_receipt_sha256"],
                "components": fence_pins,
                "source_roots": {
                    role: {key: row[key] for key in ("device", "inode")}
                    for role, row in context["linux"]["source_roots"].items()
                },
            }
            restart = None
            removal_sha = None
            with CopyFence(control, before["actual"]["backend"], source, fence_request,
                           relocated=prepared["relocated"]) as fence:
                guarded = observe_stopped_group(
                    control, source, plan, drain["stop_attempt"], drain["stop_sha256"],
                    fence=fence, relocated=prepared["relocated"],
                )
                _same_stopped_snapshot(before, guarded)
                _recheck_components(copy_parent, source, restart_context, component_pins, fence_pins)
                restart = restart_context.prepare_context(control, prepared, guarded, fence=fence)
                restart_context.revalidate_context(control, prepared, restart, guarded, fence=fence)
                safe_summary = restart_context.summary(restart)
                _recheck_components(copy_parent, source, restart_context, component_pins, fence_pins)

                removal_intent = {
                    "schema": "fullmag.data-volume-restart-removal-intent.v1",
                    "volume_id": volume_id,
                    "source_root": str(source),
                    "old_containers": old_ids,
                    "copy_receipt_sha256": copied_receipt,
                    "retained_restart": safe_summary,
                    "controller_components": component_pins,
                    "fence_components": fence_pins,
                }
                intent_sha = _document(operation_root, "restart-removal-intent.json", removal_intent)
                _checkpoint(control, operation, state="removing-services", extra={
                    "restart_removal_intent_sha256": intent_sha,
                    "restart_old_containers": old_ids,
                    "copy_receipt_sha256": copied_receipt,
                })
                if not hasattr(prepared, "_restart_attempt_marker"):
                    prepared._restart_attempt_marker = intent_sha
                else:
                    require(prepared._restart_attempt_marker == intent_sha,
                            "Prepared restart intent marker changed; never replay")

                current = observe_stopped_group(
                    control, source, plan, drain["stop_attempt"], drain["stop_sha256"],
                    fence=fence, relocated=prepared["relocated"],
                )
                _same_stopped_snapshot(before, current)
                restart_context.revalidate_context(control, prepared, restart, current, fence=fence)
                _recheck_components(copy_parent, source, restart_context, component_pins, fence_pins)
                fence.check()
                operation["daemon_pending"] = True
                _checkpoint(control, operation, state="removal-command-pending", extra={
                    "restart_removal_intent_sha256": intent_sha,
                    "restart_old_containers": old_ids,
                    "copy_receipt_sha256": copied_receipt,
                })
                result = docker_capture("rm", old_ids["backend"], old_ids["frontend"],
                                        allow_failure=True, timeout=60)
                rm_ids = _validate_rm_result(result, tuple(old_ids.values()))
                removed = observe_removed_group(
                    control, source, plan, fence=fence, relocated=prepared["relocated"]
                )
                _validate_removed_result(removed, old_ids)
                removal_record = {
                    "schema": "fullmag.data-volume-restart-removal-result.v1",
                    "state": removed["state"],
                    "volume_id": volume_id,
                    "old_containers": old_ids,
                    "docker_rm_container_ids": rm_ids,
                    "observed_container_ids": removed["observed_container_ids"],
                    "consumers": [],
                    "intent_sha256": intent_sha,
                    "copy_receipt_sha256": copied_receipt,
                }
                removal_sha = _document(operation_root, "restart-removal-result.json", removal_record)
                fence.finish(copied_receipt)
                require(fence.released is True and operation.get("daemon_pending") is False,
                        "Original copy receipt was not acknowledged by the OLD fence")
                operation["receipt"].update(
                    state="succeeded",
                    restart_removal_result_sha256=removal_sha,
                    restart_removed_containers=old_ids,
                    copy_receipt_acknowledgement_sha256=copied_receipt,
                    namespace_admitted=False,
                    data_migrated=False,
                    originals_retired=False,
                )

        require(control._active_operation is None and operation["receipt"].get("state") == "succeeded" and
                operation.get("daemon_pending") is False and fence.released is True,
                "Removal operation did not close with its exact copy-fence acknowledgement")
        restart_context.require_context(restart)
        args, kwargs = restart_context.start_arguments(restart)
        _validate_start_arguments(args, kwargs, context)
        start_intent = {
            "schema": "fullmag.data-volume-restart-start-intent.v1",
            "volume_id": volume_id,
            "source_root": str(source),
            "removal_result_sha256": removal_sha,
            "retained_restart": safe_summary,
        }
        start_intent_sha = _document(operation_root, "restart-start-intent.json", start_intent)
        _recheck_components(copy_parent, source, restart_context, component_pins, fence_pins)
        require(startup_scope.current_scope() is active_scope,
                "Prepared pending-volume scope expired before standard start")
        import docker_volume_dev
        require(Path(docker_volume_dev.__file__).resolve() == (source / "scripts/docker_volume_dev.py").resolve(),
                "Standard DEV start source differs from the selected checkout")
        captured = docker_volume_dev.start(args, **kwargs)
        evidence = _validate_started_evidence(
            restart_context.validate_started(control, prepared, restart, captured),
            old_ids=old_ids, old_attempt=pins["attempt"],
        )
    # The scope exit rechecks the retained admission evidence and physical roots.
    # Publish and mint only after that bookend succeeds.
    startup_scope._require_prepared(prepared)
    require(startup_scope.current_scope() is None,
            "Prepared startup scope did not close before publishing the start")
    restart_context.revalidate_started(control, prepared, restart, evidence)
    _recheck_components(copy_parent, source, restart_context, component_pins, fence_pins)
    start_result = {
        "schema": "fullmag.data-volume-restart-start-result.v1",
        "state": "runtime-started-not-scientifically-qualified",
        "start_intent_sha256": start_intent_sha,
        "removal_result_sha256": removal_sha,
        "started_evidence": evidence,
    }
    start_result_sha = _document(operation_root, "restart-start-result.json", start_result)
    final_record = {
        "schema": "fullmag.data-volume-restart-result.v1",
        "state": "runtime-started-not-scientifically-qualified",
        "volume_id": volume_id,
        "compose_project": control.project,
        "source_root": str(source),
        "removal_result_sha256": removal_sha,
        "start_intent_sha256": start_intent_sha,
        "start_result_sha256": start_result_sha,
        "started_evidence": evidence,
        "namespace_admitted": True,
        "data_migrated": False,
        "originals_retired": False,
    }
    final_sha = _document(operation_root, "restart-result.json", final_record)
    try:
        published = _read_published(operation_root, "restart-result.json", final_sha)
        require(published == final_record, "Published restart record changed before capability issuance")
        disk_evidence = _validate_published_result(
            operation_root, published, final_sha, context=context, control=control,
        )
        require(disk_evidence == evidence, "Published started evidence changed before capability issuance")
        startup_scope._require_prepared(prepared)
        require(startup_scope.current_scope() is None,
                "Prepared startup scope reopened before started capability issuance")
        final_evidence = restart_context.revalidate_started(control, prepared, restart, evidence)
        require(final_evidence == evidence,
                "Started runtime evidence changed at the final post-publication bookend")
        _recheck_components(copy_parent, source, restart_context, component_pins, fence_pins)
        startup_scope._require_prepared(prepared)
    except BaseException as error:
        _retain_postpublication_failure(operation_root, start_result_sha, final_sha, error)
        raise
    started = StartedGroup(prepared, {
        "state": final_record["state"],
        "receipt_sha256": final_sha,
        "result": final_record,
    }, control=control, helper=restart_context, restart_context=restart,
       operation=operation, operation_root=operation_root)
    prepared._restart_started_group = started
    return started
