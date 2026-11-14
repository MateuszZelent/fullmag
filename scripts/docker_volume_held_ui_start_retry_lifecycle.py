"""Preserve one failed, pre-materialization held launch and its accepted store.

The historical stop/recreate authority never becomes a claim that the original
DEV is current. This module has its own exact failed-parent transition.
"""
from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from pathlib import Path, PurePosixPath

from docker_build_control import BuildControlError, canonical, docker_capture

CONTEXT_SCHEMA = "fullmag.docker-failed-held-ui-start-retry-context.v1"
PLAN_SCHEMA = "fullmag.held-ui-start-retry-plan.v1"
SHA = re.compile(r"[0-9a-f]{64}\Z")
TOKEN = re.compile(r"[0-9a-f]{32}\Z")


def require(condition, message):
    if not condition:
        raise BuildControlError("Failed held start retry: " + message)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def dev():
    import docker_volume_dev
    return docker_volume_dev


def controller_module():
    import docker_volume_held_ui_start_retry
    return docker_volume_held_ui_start_retry


def retry_root(args):
    value = args.failed_held_start_attempt
    require(isinstance(value, str) and TOKEN.fullmatch(value), "failed attempt is malformed")
    return "held-ui-start-retry/" + value


def read_record(control, path, label):
    return dev()._read_canonical_control_record(control, path, label)


def assert_pointers(context):
    control = context["original_request_context"]["control"]
    failed = context["failed_parent"]
    require(control.read_bytes("development/current.json") == failed["raw"],
            "the actual failed current parent changed")
    require(control.read_bytes("development/verified.json") == failed["verified_raw"],
            "the verified predecessor changed")


def assert_consumers(context):
    from docker_volume_container_recovery import (
        GROUP_LOCAL_DIRECT_BINDS_SCOPE, _assert_no_foreign_storage_consumers,
        _group_local_consumer_pin,
    )
    from docker_group_local_filesystem_alias import prove_alias
    original = context["original_request_context"]
    failed = context["failed_parent"]
    evidence = context.get("plan", context.get("observation", {}))
    locks = evidence.get("native_locks", {})
    require(set(locks) == {"owner", "startup_gate", "launch", "host_inventory_owner"},
            "consumer qualification has no complete private-filesystem pins")
    host_boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    require(host_boot == evidence.get("runtime", {}).get("api_pin", {}).get("boot_id"),
            "host and managed backend do not share the pinned kernel identity")
    state_before = original["state"].stat()
    devices = {state_before.st_dev, *(value["device"] for value in locks.values())}
    proofs = []

    def qualify_alias(container, alias):
        before = _group_local_consumer_pin(container)
        rows = json.loads(dev().docker_text("inspect", container["Id"]))
        require(len(rows) == 1 and _group_local_consumer_pin(rows[0]) == before,
                "foreign mount incarnation changed before its read-only metadata probe")
        proof = prove_alias(alias, devices)
        after = json.loads(dev().docker_text("inspect", container["Id"]))
        require(len(after) == 1 and _group_local_consumer_pin(after[0]) == before,
                "foreign mount incarnation changed during its read-only metadata probe")
        if proof is None:
            return False
        proofs.append({"container_id": container["Id"], "proof": proof})
        return True

    _assert_no_foreign_storage_consumers(
        original["control"], failed["actual"]["backend"], failed["actual"]["frontend"],
        failed["document"], consumer_scope=GROUP_LOCAL_DIRECT_BINDS_SCOPE,
        filesystem_alias_guard=qualify_alias,
    )
    state_after = original["state"].stat()
    require((state_before.st_dev, state_before.st_ino) == (state_after.st_dev, state_after.st_ino),
            "the retained state filesystem changed during consumer qualification")
    return proofs


def certificate_pin(original, failed):
    d = dev()
    state = original["state"]
    host = d._session_host()
    certificate = d._retained_certificate(state, failed["document"])
    raw = host.read_owned_regular(d._certificate_path(state))
    owner_raw = host.read_owned_regular(state / host.OWNER_NAME)
    final = failed["value"].get("held_ui_successor_certificate_final")
    require(isinstance(final, Mapping) and raw == owner_raw
            and digest(raw) == final.get("certificate_sha256")
            and digest(owner_raw) == final.get("owner_marker_sha256")
            and certificate.get("restart_verified") is True
            and final.get("restart_verified") is True
            and certificate.get("image_id") == failed["actual"]["backend"]["Image"],
            "the failed parent's real filesystem admission is missing or changed")
    return {
        "sha256": digest(raw), "owner_sha256": digest(owner_raw),
        **{key: certificate[key] for key in (
            "owner_token", "image_id", "host_inode", "storage_profile", "restart_verified",
        )},
    }


def historical_recreate(original, args):
    """Validate the named immutable 5036 transition, not a latest phase pointer."""
    control = original["control"]
    claim = original["claim"]
    attempt = claim["recreate_attempt"]
    raw, value = read_record(control, "recreate-services/attempts/" + attempt + "/terminal.json",
                             "original immutable held recreation")
    source = original["request"]["source_scope"]
    expected_removed = [source["backend_container_id"], source["frontend_container_id"]]
    require(value.get("schema") == "fullmag.docker-build-operation.v1"
            and value.get("phase") == "recreate-services" and value.get("state") == "succeeded"
            and value.get("attempt") == attempt and value.get("compose_project") == control.project
            and value.get("control_volume") == control.volume
            and value.get("control_namespace", "") == control.namespace
            and value.get("namespace_registry_sha256") == control.namespace_registry_sha256
            and value.get("fresh_state") is False
            and value.get("inputs", {}).get("held_ui_materialization") == original["recreate_input"]
            and value.get("held_ui_materialization_recreate_claim") == {
                "path": original["controller"].recreate_claim_relative(args.request_id),
                "sha256": original["claim_sha256"],
            }
            and value.get("removed_containers") == expected_removed
            and value.get("previous_state_root") == str(original["state"])
            and value.get("retained_volumes") == original["previous"]["backend_volumes"]
            and value.get("retained_frontend_volume") == original["previous"]["frontend_volume"],
            "the original immutable recreation no longer binds its actual claim")
    from docker_volume_container_recovery import _assert_container_absent
    for identifier in expected_removed:
        _assert_container_absent(identifier)
    return {"raw": raw, "terminal": value}


def capture(args, controller, *, control=None, operation=None):
    """Read-only capture; every mutation uses a fresh capture under its lease."""
    import docker_volume_held_ui_materialization as held
    from docker_volume_held_ui_retry_probe import observe
    from docker_volume_pre_ack_retry import _released_snapshot
    d = dev()
    original = d._load_held_ui_request_context(
        args, controller=held, expected_plan_sha256=args.expected_plan_sha256,
        require_original_state_binding=False,
    )
    original["controller"] = held
    original = d._held_ui_context_with_recreate_claim(original)
    require(original["claim"] is not None, "the original recreate claim is missing")
    original_recreate = historical_recreate(original, args)
    if control is not None:
        require((control.project, control.volume, control.namespace, control.identity)
                == (original["control"].project, original["control"].volume,
                    original["control"].namespace, original["control"].identity),
                "the managed namespace changed")
        original["control"] = control
    control = original["control"]
    if operation is None:
        require(control.read_bytes("active", optional=True) is None,
                "a managed operation is still active; no replay")
    else:
        require(operation.get("lease_ready") is True, "the retry lease is not held")
    root = "development/attempts/" + args.failed_held_start_attempt
    raw, previous = read_record(control, root + "/terminal.json", "failed held DEV terminal")
    compose_raw, document = read_record(control, root + "/compose.json", "failed held DEV Compose")
    from docker_volume_stop_diagnostic import _port_matches
    _port_matches(document, args.port)
    require(d.include_untracked_from_compose(document) == [],
            "this retry requires a tracked-source build; retained untracked inputs are unsupported")
    verified_raw = control.read_bytes("development/verified.json")
    require(digest(raw) == args.failed_held_start_sha256
            and previous.get("schema") == "fullmag.docker-build-operation.v1"
            and previous.get("phase") == "development"
            and previous.get("attempt") == args.failed_held_start_attempt
            and previous.get("state") == "failed-confirmed"
            and previous.get("ui_mode") == "gui"
            and previous.get("compose_project") == control.project
            and previous.get("control_volume") == control.volume
            and previous.get("control_namespace", "") == control.namespace
            and previous.get("namespace_registry_sha256") == control.namespace_registry_sha256
            and previous.get("inputs", {}).get("source_root") == str(original["selected"])
            and previous.get("state_root") == str(original["state"])
            and previous.get("inputs", {}).get("held_ui_materialization")
                == d._held_ui_start_input(original)
            and verified_raw == original["previous_raw"]
            and document.get("name") == control.project
            and digest(canonical(document)) == previous.get("config_sha256"),
            "failed terminal, original held lineage, or Compose differs")
    actual = {}
    for service in ("backend", "frontend"):
        identifier = previous.get(service + "_container")
        require(isinstance(identifier, str) and SHA.fullmatch(identifier), "service id is malformed")
        rows = json.loads(d.docker_text("inspect", identifier))
        require(len(rows) == 1 and rows[0].get("Id") == identifier,
                "service inspection is ambiguous")
        actual[service] = rows[0]
        image = document["services"][service]["image"]
        image_config = json.loads(d.docker_text("image", "inspect", image))[0]["Config"]
        d._validate_retained_service(
            document, rows[0], service, image_config,
            expected_started_at=previous.get(service + "_started_at"),
        )
        require(rows[0].get("State", {}).get("Running") is True
                and not rows[0].get("State", {}).get("Restarting"),
                "the pinned diagnostic pair is not running")
    failed = {"raw": raw, "value": previous, "document_raw": compose_raw,
              "document": document, "verified_raw": verified_raw, "actual": actual}
    context = {"schema": CONTEXT_SCHEMA, "original_request_context": original,
               "failed_parent": failed}
    assert_pointers(context)
    d._assert_private_restart_network(actual, {k: v["Id"] for k, v in actual.items()}, control.project)
    for field in ("backend_volumes", "frontend_volume", "private_group_storage",
                  "frontend_generation_id", "frontend_generation_subpath"):
        require(previous.get(field) == original["previous"].get(field),
                "the failed parent changed retained storage or frontend " + field)
    require(previous.get("private_group_storage") == "group-volume-v1", "private group storage is required")
    frontend_handoff = d._capture_frontend_start_handoff(control, previous, document)
    d._validate_frontend_start_handoff(control, frontend_handoff, original["selected"], original["state"])
    source_handoff = d._capture_frontend_start_handoff(
        control, original["previous"], original["document"], expected_current_sha256=digest(raw),
    )
    require(frontend_handoff is not None and source_handoff is not None
            and all(frontend_handoff[k] == source_handoff[k]
                    for k in ("frontend_generation_id", "frontend_generation_subpath")),
            "the original and failed frontend generations differ")
    observed = observe(control, actual["backend"], original["request"])
    context["observation"] = observed
    context["consumer_proofs"] = assert_consumers(context)
    released = _released_snapshot(control, actual["backend"])
    require(released.get("active_count") == 0, "native reservations remain active")
    authority = {}
    for name in controller.AUTHORITY_NAMES:
        authority[name] = control.read_bytes(
            "runtime-control/held-ui-materialization/" + args.request_id + "/" + name,
            maximum=controller.MAX_AUTHORITY_BYTES,
        )
    body = {
        "schema": PLAN_SCHEMA,
        "original": {"attempt": args.attempt, "config_sha256": args.config_sha256,
                     "request_id": args.request_id, "run_id": args.run_id,
                     "plan_sha256": args.expected_plan_sha256,
                     "request_sha256": original["request_sha256"],
                     "recreate_terminal_sha256": digest(original_recreate["raw"])},
        "failed": {"attempt": args.failed_held_start_attempt, "terminal_sha256": digest(raw),
                   "compose_sha256": digest(compose_raw), "config_sha256": previous["config_sha256"],
                   "verified_sha256": digest(verified_raw),
                   **{service + "_container_id": actual[service]["Id"] for service in actual},
                   **{service + "_started_at": actual[service]["State"]["StartedAt"] for service in actual},
                   "image_id": actual["backend"]["Image"]},
        "namespace": {"compose_project": control.project, "control_volume": control.volume,
                      "namespace": control.namespace, "namespace_registry_sha256": control.namespace_registry_sha256,
                      "source_root": str(original["selected"]), "state_root": str(original["state"]),
                      "accepted_store": original["proofs"]["api_quiescence"]["retained_process"]["accepted_store"],
                      "accepted_store_binding": original["proofs"]["preflight"]["accepted_store_binding"]},
        "runtime": observed["runtime"], "released_snapshot_sha256": digest(canonical(released)),
        "native_locks": observed["native_locks"], "certificate": certificate_pin(original, failed),
        "frontend_handoff": frontend_handoff,
        "authority_sha256": {name: digest(value) for name, value in authority.items()},
    }
    from docker_volume_held_ui_retry_source import capture as capture_source
    body["new_source"] = capture_source(original["selected"])
    plan, plan_sha = controller.retry_plan(body)
    require(plan == body, "plan normalization changed evidence")
    return {**context, "plan": plan, "plan_sha256": plan_sha,
            "authority_raw": authority, "released_snapshot": released}


def run(args, *, controller):
    controller.validate_retry_options(args)
    saved = saved_context(args, controller)
    if saved is not None:
        if args.preview:
            return {"state": "claimed-retained", "plan": saved["plan"],
                    "plan_sha256": saved["plan_sha256"]}
        require(saved["plan_sha256"] == args.retry_plan_sha256, "the saved retry SHA is not approved")
        control = saved["original_request_context"]["control"]
        path = retry_root(args) + "/start-claim.json"
        if control.read_bytes(path, optional=True) is not None:
            return readback(saved)
        return start_retained(args, saved)
    context = capture(args, controller)
    if args.preview:
        return {"state": "preview", "plan": context["plan"], "plan_sha256": context["plan_sha256"]}
    require(context["plan_sha256"] == args.retry_plan_sha256, "the approved retry plan changed")
    return dev().resume_failed_held_ui_start(args, context)


def reference(context):
    plan = context["plan"]
    return {"schema": CONTEXT_SCHEMA, "failed_attempt": plan["failed"]["attempt"],
            "plan_path": "held-ui-start-retry/" + plan["failed"]["attempt"] + "/plan.json",
            "plan_sha256": context["plan_sha256"]}


def assert_saved_plan(control, context):
    controller = controller_module()
    plan, plan_sha = controller.retry_plan(context["plan"])
    require(context.get("schema") == CONTEXT_SCHEMA and plan_sha == context["plan_sha256"],
            "the typed retry context changed")
    ref = reference(context)
    require(control.read_bytes(ref["plan_path"]) == canonical(plan) + b"\n",
            "the immutable retry plan changed")
    return ref


def validate_archive_handoff(control, operation, context):
    """Narrow capability for technical archive while retaining accepted state."""
    ref = assert_saved_plan(control, context)
    receipt = operation.get("receipt", {})
    claim = control.read(str(PurePosixPath(ref["plan_path"]).parent / "recreate-claim.json"))
    require(receipt.get("fresh_state") is False
            and receipt.get("inputs", {}).get("failed_held_ui_start") == ref
            and receipt.get("previous_state_root") == context["plan"]["namespace"]["state_root"]
            and claim == {**ref, "schema": "fullmag.held-ui-start-retry-recreate-claim.v1",
                          "recreate_attempt": receipt.get("attempt")},
            "the retained archive lacks its exact once-only recreation claim")
    stopped = control.read(operation["root"] + "/retry-stopped-proof.json")
    require(receipt.get("retry_stopped_proof_sha256") == digest(canonical(stopped) + b"\n")
            and stopped.get("plan_sha256") == context["plan_sha256"]
            and stopped.get("state") == "stopped-no-execution",
            "the retained archive lacks its exact stopped no-execution proof")
    return True


def inspect_pair(context, *, running):
    d = dev()
    failed = context["failed_parent"]
    observed = {}
    for service, prior in failed["actual"].items():
        rows = json.loads(d.docker_text("inspect", prior["Id"]))
        require(len(rows) == 1, "ambiguous service observation")
        item = rows[0]
        require(item.get("Id") == prior["Id"] and item.get("Image") == prior["Image"]
                and item.get("State", {}).get("StartedAt") == prior["State"]["StartedAt"]
                and item.get("State", {}).get("Running") is running
                and not item.get("State", {}).get("Restarting"),
                "service incarnation or stopped state changed")
        image_config = json.loads(d.docker_text("image", "inspect", item["Image"]))[0]["Config"]
        d._validate_retained_service(
            failed["document"], item, service, image_config,
            expected_started_at=prior["State"]["StartedAt"],
        )
        observed[service] = item
    return observed


def apply(args, context):
    """One exact diagnostic retirement; never replay an unresolved mutation."""
    from docker_volume_held_ui_retry_probe import observe_stopped
    from docker_volume_pre_ack_retry import _released_snapshot, _publish_raw
    from docker_volume_container_recovery import _assert_container_absent
    from docker_volume_fresh_runtime import archive_runtime_control
    controller = controller_module()
    controller.validate_retry_options(args)
    d = dev()
    original = context["original_request_context"]
    control = original["control"]
    plan = context["plan"]
    ref = reference(context)
    require(context["plan_sha256"] == args.retry_plan_sha256, "the retry SHA is not approved")
    claim_path = str(PurePosixPath(ref["plan_path"]).parent / "recreate-claim.json")
    require(control.read_bytes(claim_path, optional=True) is None,
            "a retry recreation claim already exists; inspect its outcome without replay")
    inputs = {"attempt": plan["failed"]["attempt"], "config_sha256": plan["failed"]["config_sha256"],
              "source_root": plan["namespace"]["source_root"], "failed_held_ui_start": ref}
    with control.operation("recreate-services", inputs) as operation:
        fresh = capture(args, controller, control=control, operation=operation)
        require(fresh["plan"] == plan and fresh["plan_sha256"] == context["plan_sha256"],
                "the approved diagnostic capture changed under the lease")
        existing_plan = control.read_bytes(ref["plan_path"], optional=True)
        if existing_plan is None:
            _publish_raw(control, ref["plan_path"], canonical(plan) + b"\n")
        else:
            require(existing_plan == canonical(plan) + b"\n", "an existing retry plan changed")
        claim = {**ref, "schema": "fullmag.held-ui-start-retry-recreate-claim.v1",
                 "recreate_attempt": operation["receipt"]["attempt"]}
        _publish_raw(control, claim_path, canonical(claim) + b"\n")
        failed = fresh["failed_parent"]
        actual = failed["actual"]
        ids = {name: value["Id"] for name, value in actual.items()}
        operation["receipt"].update(
            previous_state_root=str(original["state"]), fresh_state=False,
            retained_volumes=failed["value"]["backend_volumes"],
            retained_frontend_volume=failed["value"]["frontend_volume"],
        )
        control.write(operation["root"] + "/retained-containers.json", actual)
        control.write(operation["root"] + "/foreign-direct-filesystem-proofs.json", fresh.get("consumer_proofs", []))
        control.write(operation["root"] + "/receipt.json", operation["receipt"])
        # Capture all inputs before any signal. A failed call retains this claim;
        # calling this entry again cannot repeat the stop or remove.
        assert_pointers(fresh)
        assert_consumers(fresh)
        inspect_pair(fresh, running=True)
        operation["receipt"]["state"] = "stopping-diagnostic-frontend"
        control.write(operation["root"] + "/receipt.json", operation["receipt"])
        operation["daemon_pending"] = True
        docker_capture("stop", "--time", "60", ids["frontend"], timeout=90)
        frontend = json.loads(d.docker_text("inspect", ids["frontend"]))[0]
        require(frontend.get("State", {}).get("Running") is False
                and frontend["State"]["StartedAt"] == actual["frontend"]["State"]["StartedAt"],
                "frontend stop was not confirmed")
        # The diagnostic API cannot accept execution. Revalidate its actual
        # immutable launch, kernel pin and no-execution snapshot immediately
        # before closing the exact backend container.
        from docker_volume_held_ui_retry_probe import observe
        before_stop = observe(control, actual["backend"], original["request"])
        require(before_stop["runtime"] == plan["runtime"]
                and before_stop["native_locks"] == plan["native_locks"],
                "diagnostic API or native/store evidence changed before backend stop")
        operation["receipt"]["state"] = "stopping-diagnostic-backend"
        control.write(operation["root"] + "/receipt.json", operation["receipt"])
        docker_capture("stop", "--time", "60", ids["backend"], timeout=90)
        stopped_pair = inspect_pair(fresh, running=False)
        stopped = observe_stopped(control, actual["backend"], original["request"], before_stop)
        released = _released_snapshot(control, actual["backend"])
        require(released == fresh["released_snapshot"], "released reservations or leases changed after stop")
        proof = {"schema": "fullmag.held-ui-start-retry-stopped.v1", "state": "stopped-no-execution",
                 "plan_sha256": fresh["plan_sha256"], "removed_pair": ids,
                 "observation": stopped, "released_snapshot_sha256": digest(canonical(released))}
        control.write(operation["root"] + "/retry-stopped-proof.json", proof)
        operation["receipt"]["retry_stopped_proof_sha256"] = digest(canonical(proof) + b"\n")
        assert_pointers(fresh)
        assert_consumers(fresh)
        require(certificate_pin(original, failed) == plan["certificate"],
                "retained filesystem admission changed before removal")
        operation["receipt"]["state"] = "removing-stopped-diagnostic-pair"
        control.write(operation["root"] + "/receipt.json", operation["receipt"])
        docker_capture("rm", ids["backend"], ids["frontend"], timeout=90)
        for identifier in ids.values():
            _assert_container_absent(identifier)
        archive = archive_runtime_control(
            control, operation, previous_state_root=str(original["state"]),
            source_root=str(original["selected"]), removed_containers=list(ids.values()),
            held_ui_start_retry=fresh,
        )
        restored = controller.restore_archived_authority(
            control, operation["receipt"]["attempt"], args.request_id, fresh["authority_raw"],
        )
        operation["receipt"].update(
            runtime_control_archive=archive, held_ui_authority_restored=restored,
            removed_containers=list(ids.values()), state="succeeded",
        )
        operation["daemon_pending"] = False
        context = fresh
    attempt = operation["receipt"]["attempt"]
    raw, terminal = read_record(control, "recreate-services/attempts/" + attempt + "/terminal.json",
                                "held retry recreation terminal")
    require(terminal.get("state") == "succeeded", "retry recreation did not succeed")
    context.update(retry_attempt=attempt, retry_terminal_sha256=digest(raw),
                   certificate_preflight=plan["certificate"])
    return start_retained(args, context)


def start_input(context):
    return {**reference(context), "recreate_attempt": context["retry_attempt"],
            "recreate_terminal_sha256": context["retry_terminal_sha256"]}


def start_retained(args, context):
    d = dev()
    original = context["original_request_context"]
    failed = context["failed_parent"]
    control = original["control"]
    root = str(PurePosixPath(reference(context)["plan_path"]).parent)
    require(control.read_bytes(root + "/start-claim.json", optional=True) is None,
            "a start claim already exists; no second backend launch")
    from copy import copy
    start_args = copy(args)
    require(d.include_untracked_from_compose(failed["document"]) == [],
            "retained untracked inputs are unsupported by this retry")
    start_args.include_untracked = []
    start_args.gpu_access = failed["value"]["inputs"]["gpu_access_requested"]
    start_args.native_contract = failed["value"]["inputs"].get("native_contracts")
    from docker_dev_network import retained_requested_subnet
    start_args.network_subnet = retained_requested_subnet(failed["document"], None)
    reuse = {"state": original["state"], "host_certificate": d._certificate_path(original["state"]),
             "owner_marker": original["state"] / d._session_host().OWNER_NAME,
             "receipt": {"image_id": context["plan"]["failed"]["image_id"]},
             "operator_probe_environment_record": d._operator_probe_record_from_retained(
                 failed["value"], failed["document"]),
             "frontend_start_handoff": context["plan"]["frontend_handoff"]}
    d.start(start_args, reuse_state=reuse,
            retained_device_access=d._retained_device_access(failed["value"], failed["document"]),
            failed_held_ui_start_context=context)
    return readback(context)


def validate_start_context(args, context, reuse_state, *, operation=None, before_compose=False):
    """Revalidate retained retirement and authority before any new service."""
    require(isinstance(context, Mapping) and context.get("schema") == CONTEXT_SCHEMA,
            "unsupported typed start context")
    d = dev()
    original = context["original_request_context"]
    control = original["control"]
    ref = assert_saved_plan(control, context)
    plan = context["plan"]
    from docker_volume_held_ui_retry_source import validate as validate_source
    validate_source(original["selected"], plan["new_source"])
    expected_args = {"attempt": args.attempt, "config_sha256": args.config_sha256,
                     "request_id": args.request_id, "run_id": args.run_id,
                     "plan_sha256": args.expected_plan_sha256}
    require(all(plan["original"].get(key) == value for key, value in expected_args.items()),
            "start arguments differ from the original accepted authority")
    assert_pointers(context)
    from docker_volume_stop_diagnostic import _port_matches
    _port_matches(context["failed_parent"]["document"], args.port)
    attempt = context["retry_attempt"]
    require(isinstance(attempt, str) and TOKEN.fullmatch(attempt), "retirement attempt is invalid")
    root = "recreate-services/attempts/" + attempt
    raw, terminal = read_record(control, root + "/terminal.json", "retry retirement terminal")
    require(digest(raw) == context["retry_terminal_sha256"]
            and terminal.get("schema") == "fullmag.docker-build-operation.v1"
            and terminal.get("phase") == "recreate-services"
            and terminal.get("state") == "succeeded"
            and terminal.get("attempt") == attempt
            and terminal.get("inputs", {}).get("failed_held_ui_start") == ref
            and terminal.get("fresh_state") is False
            and terminal.get("previous_state_root") == str(original["state"])
            and control.read_bytes("recreate-services/current.json") == raw
            and control.read_bytes("recreate-services/verified.json") == raw,
            "retained retirement terminal or phase pointers changed")
    from docker_volume_fresh_runtime import pinned_group_archive
    generation = pinned_group_archive(control, control.read("group-ledger-generation.json"))
    require(isinstance(generation, Mapping) and generation.get("operation_attempt") == attempt,
            "the exact archived native/ledger generation changed")
    removed = {plan["failed"]["backend_container_id"], plan["failed"]["frontend_container_id"]}
    require(set(terminal.get("removed_containers", [])) == removed,
            "retirement removed a different service pair")
    from docker_volume_container_recovery import _assert_container_absent
    for identifier in removed:
        _assert_container_absent(identifier)
    require(isinstance(reuse_state, Mapping)
            and Path(reuse_state.get("state", "")).resolve(strict=True) == original["state"]
            and reuse_state.get("frontend_start_handoff") == plan["frontend_handoff"],
            "the retry changed accepted state or frontend generation")
    parent = "held-ui-materialization/" + plan["original"]["request_id"] + "/"
    for name, expected in plan["authority_sha256"].items():
        active = control.read_bytes("runtime-control/" + parent + name)
        archived = control.read_bytes("runtime-archives/" + attempt + "/" + parent + name)
        require(active == archived and digest(active) == expected,
                "restored original authority changed: " + name)
    require(digest(control.read_bytes("runtime-archives/" + attempt + "/" + parent + "launch.json"))
            == plan["runtime"]["launch_sha256"]
            and control.read_bytes("runtime-control/" + parent + "launch.json", optional=True) is None,
            "the archived launch changed or a new launch already exists; no replay")
    if before_compose:
        d._validate_held_ui_successor_certificate(original, operation)
    else:
        require(certificate_pin(original, context["failed_parent"]) == plan["certificate"],
                "the retained filesystem certificate changed before start")
    from docker_volume_held_ui_retry_probe import observe_archived
    observed = observe_archived(
        control, context["failed_parent"]["actual"]["backend"], original["request"],
        {"runtime": plan["runtime"], "native_locks": plan["native_locks"]}, attempt,
    )
    require(observed["runtime"]["store_snapshot"] == plan["runtime"]["store_snapshot"]
            and observed["native_locks"] == plan["native_locks"],
            "accepted store or archived native fences changed before start")
    require(observed.get("released_snapshot_sha256") == plan["released_snapshot_sha256"],
            "archived released reservations or local leases changed before start")
    assert_consumers(context)
    return context


def before_start(args, context, control, operation, reuse_state):
    from docker_volume_pre_ack_retry import _publish_raw
    require(control.project == context["plan"]["namespace"]["compose_project"]
            and control.volume == context["plan"]["namespace"]["control_volume"]
            and control.namespace == context["plan"]["namespace"]["namespace"],
            "new DEV lease selected another namespace")
    # Use the exact live lease object for all remaining reads.
    context["original_request_context"]["control"] = control
    validate_start_context(args, context, reuse_state, operation=operation)
    path = str(PurePosixPath(reference(context)["plan_path"]).parent / "start-claim.json")
    require(control.read_bytes(path, optional=True) is None, "a start claim exists; no launch replay")
    claim = {**start_input(context), "schema": "fullmag.held-ui-start-retry-start-claim.v1",
             "development_attempt": operation["receipt"]["attempt"]}
    _publish_raw(control, path, canonical(claim) + b"\n")
    operation["receipt"]["failed_held_ui_start"] = start_input(context)
    control.write(operation["root"] + "/receipt.json", operation["receipt"])


def before_compose(args, context, control, operation, reuse_state):
    validate_start_context(args, context, reuse_state, operation=operation, before_compose=True)
    document = control.read(operation["root"] + "/compose.json")
    prior = context["failed_parent"]["document"]
    require(document.get("networks") == prior.get("networks"),
            "the retry changed the retained private network")
    for name in ("backend", "frontend"):
        current_service = document["services"][name]
        previous_service = prior["services"][name]
        for field in ("cpus", "mem_limit", "memswap_limit", "mem_reservation", "cpuset",
                      "pids_limit", "deploy", "networks", "network_mode", "ports"):
            require(current_service.get(field) == previous_service.get(field),
                    "the retry changed retained " + name + " " + field)
    current_environment = document["services"]["backend"]["environment"]
    old_environment = prior["services"]["backend"]["environment"]
    require(dev().include_untracked_from_compose(document) == []
            and dev().include_untracked_from_compose(prior) == [],
            "the retry changed its tracked-source allowlist")
    require(current_environment.get("FULLMAG_DOCKER_DEVICE_ACCESS")
                == old_environment.get("FULLMAG_DOCKER_DEVICE_ACCESS")
            and current_environment.get("FULLMAG_STATE_ROOT") == str(context["original_request_context"]["state"]),
            "the retry changed device access or accepted state")
    path = str(PurePosixPath(reference(context)["plan_path"]).parent / "start-claim.json")
    require(control.read(path) == {
        **start_input(context), "schema": "fullmag.held-ui-start-retry-start-claim.v1",
        "development_attempt": operation["receipt"]["attempt"],
    }, "the one-shot start claim changed")


def readback(context):
    d = dev()
    original = context["original_request_context"]
    control = original["control"]
    ref = assert_saved_plan(control, context)
    path = str(PurePosixPath(ref["plan_path"]).parent / "start-claim.json")
    claim = control.read(path)
    attempt = claim.get("development_attempt")
    require(isinstance(attempt, str) and TOKEN.fullmatch(attempt), "start attempt is invalid")
    expected_claim = {**start_input(context), "schema": "fullmag.held-ui-start-retry-start-claim.v1",
                      "development_attempt": attempt}
    require(claim == expected_claim and control.read_bytes("active", optional=True) is None,
            "the retry start is still active or its once-only claim changed; no replay")
    root = "development/attempts/" + attempt
    raw, terminal = read_record(control, root + "/terminal.json", "retry DEV terminal")
    require(terminal.get("state") == "succeeded"
            and terminal.get("attempt") == attempt
            and terminal.get("inputs", {}).get("failed_held_ui_start") == start_input(context)
            and control.read_bytes("development/current.json") == raw
            and control.read_bytes("development/verified.json") == raw
            and terminal.get("state_root") == str(original["state"])
            and terminal.get("compose_project") == control.project
            and terminal.get("control_volume") == control.volume,
            "the retry has no exact succeeded and verified DEV; no replay")
    for key in ("backend_volumes", "frontend_volume", "private_group_storage",
                "frontend_generation_id", "frontend_generation_subpath"):
        require(terminal.get(key) == context["failed_parent"]["value"].get(key),
                "the retry changed retained storage " + key)
    process = control.read("runtime-control/runtime-service/process-tree.json")
    require(process.get("schema") == "fullmag.docker-process-tree.v1"
            and process.get("state") == "ready"
            and process.get("api_diagnostic_only", False) is False
            and process.get("service_owner", {}).get("state") == "ready",
            "the successor API/native owner is not really ready")
    runtime, ack, launch = d._held_ui_launch_and_ack(original, process)
    require(launch["launch_id"] != context["plan"]["runtime"]["launch_id"],
            "the failed launch identity was replayed")
    provenance = control.read(root + "/provenance.json")
    target = launch["input"]["target_runtime"]
    require(target["image_id"] == terminal["inputs"]["image_id"]
            and target["build_id"] == provenance.get("commit")
            and target["source_sha256"] == provenance.get("source_snapshot_sha256")
            and target["build_id"] == context["plan"]["new_source"]["commit"]
            and target["source_sha256"] == context["plan"]["new_source"]["source_snapshot_sha256"]
            and provenance.get("source_digest") == context["plan"]["new_source"]["source_digest"]
            and target["config_sha256"] == digest(control.read_bytes("runtime-control/runtime-service/docker-all.json"))
            and process.get("accepted_store") == context["plan"]["namespace"]["accepted_store"]
            and target["accepted_store_binding"] == context["plan"]["namespace"]["accepted_store_binding"],
            "the launch changed the actual built target or accepted store")
    final_pin = terminal.get("held_ui_successor_certificate_final", {})
    host = d._session_host()
    certificate_raw = host.read_owned_regular(d._certificate_path(original["state"]))
    owner_raw = host.read_owned_regular(original["state"] / host.OWNER_NAME)
    require(final_pin.get("restart_verified") is True and certificate_raw == owner_raw
            and digest(certificate_raw) == final_pin.get("certificate_sha256")
            and digest(owner_raw) == final_pin.get("owner_marker_sha256"),
            "the successor filesystem admission was not verified")
    return {"state": "restored", "attempt": attempt, "plan_sha256": context["plan_sha256"],
            "request_sha256": original["request_sha256"], "run_id": ack["run_id"],
            "command_id": ack["command_id"], "launch_id": launch["launch_id"],
            "api_instance_id": runtime["api_instance_id"], "gate_action": ack["gate_action"],
            "start_release_sha256": ack["start_release_sha256"],
            "backend_container": terminal["backend_container"],
            "frontend_container": terminal["frontend_container"]}


def saved_context(args, controller):
    """Observe a claimed attempt; only an unstarted succeeded retirement can start."""
    import docker_volume_held_ui_materialization as held
    d = dev()
    original = d._load_held_ui_request_context(
        args, controller=held, expected_plan_sha256=args.expected_plan_sha256,
        require_original_state_binding=False,
    )
    original["controller"] = held
    original = d._held_ui_context_with_recreate_claim(original)
    control = original["control"]
    root = retry_root(args)
    raw = control.read_bytes(root + "/plan.json", optional=True)
    if raw is None:
        return None
    plan = json.loads(raw)
    plan, plan_sha = controller.retry_plan(plan)
    require(raw == canonical(plan) + b"\n", "saved retry plan is not canonical")
    require(plan["failed"]["attempt"] == args.failed_held_start_attempt
            and plan["failed"]["terminal_sha256"] == args.failed_held_start_sha256
            and plan["original"]["attempt"] == args.attempt
            and plan["original"]["config_sha256"] == args.config_sha256
            and plan["original"]["request_id"] == args.request_id
            and plan["original"]["run_id"] == args.run_id
            and plan["original"]["plan_sha256"] == args.expected_plan_sha256
            and plan["original"]["request_sha256"] == original["request_sha256"],
            "saved retry plan differs from the explicit operator pins")
    claim = control.read(root + "/recreate-claim.json", optional=True)
    if claim is None:
        # Publication failed before any stop was reachable. A fresh capture
        # must still match the entire existing plan before claiming an action.
        return None
    require(control.read_bytes("active", optional=True) is None,
            "the claimed retry is still active; only observation is allowed")
    attempt = claim.get("recreate_attempt")
    require(isinstance(attempt, str) and TOKEN.fullmatch(attempt), "saved retirement attempt is invalid")
    context = {"schema": CONTEXT_SCHEMA, "plan": plan, "plan_sha256": plan_sha,
               "original_request_context": original}
    require(claim == {**reference(context), "schema": "fullmag.held-ui-start-retry-recreate-claim.v1",
                      "recreate_attempt": attempt}, "saved recreation claim differs")
    recreate_raw, terminal = read_record(
        control, "recreate-services/attempts/" + attempt + "/terminal.json", "claimed retry terminal",
    )
    require(terminal.get("state") == "succeeded"
            and terminal.get("inputs", {}).get("failed_held_ui_start") == reference(context),
            "the claimed retirement did not succeed; resources retained, no stop/remove replay")
    failed_root = "development/attempts/" + plan["failed"]["attempt"]
    failed_raw, failed_value = read_record(control, failed_root + "/terminal.json", "saved failed parent")
    compose_raw, compose = read_record(control, failed_root + "/compose.json", "saved failed Compose")
    from docker_volume_stop_diagnostic import _port_matches
    _port_matches(compose, args.port)
    require(digest(failed_raw) == plan["failed"]["terminal_sha256"]
            and digest(compose_raw) == plan["failed"]["compose_sha256"]
            and digest(original["previous_raw"]) == plan["failed"]["verified_sha256"]
            and digest(historical_recreate(original, args)["raw"])
                == plan["original"]["recreate_terminal_sha256"],
            "saved immutable lineage changed")
    actual = control.read("recreate-services/attempts/" + attempt + "/retained-containers.json")
    require(isinstance(actual, Mapping) and set(actual) == {"backend", "frontend"}
            and all(actual[name].get("Id") == plan["failed"][name + "_container_id"]
                    for name in actual), "saved retired pair differs")
    context.update(
        failed_parent={"raw": failed_raw, "value": failed_value, "document_raw": compose_raw,
                       "document": compose, "verified_raw": original["previous_raw"], "actual": actual},
        retry_attempt=attempt, retry_terminal_sha256=digest(recreate_raw),
        certificate_preflight=plan["certificate"],
    )
    return context
