"""Managed stop-only producer for one exact held UI Compute intent."""
from __future__ import annotations

import json
from collections.abc import Mapping


STOP_PHASE = "held-ui-materialization-stop"
PUBLISH_PHASE = "held-ui-materialization-publish"


def _require(controller, condition, message):
    controller._require(bool(condition), message)


def _canonical_lf(controller, value):
    return controller.canonical(value) + b"\n"


def _operation_inputs(plan, expected_plan_sha256):
    scope = plan["source_scope"]
    accepted = plan["accepted"]
    return {
        "attempt": plan["attempt"],
        "source_root": scope["source_root"],
        "config_sha256": scope["runtime_config_sha256"],
        "source_scope": dict(scope),
        "maintenance_request_id": plan["maintenance_request_id"],
        "plan_sha256": expected_plan_sha256,
        "run_id": accepted["run_id"],
        "accepted_run_id": accepted["run_id"],
        "capture_held_ui_materialization": True,
    }


def _assert_plan(controller, plan, expected_plan_sha256, capture_fresh):
    captured = capture_fresh()
    _require(controller, isinstance(captured, Mapping)
             and set(captured) == {"accepted", "preflight", "inventory", "source_scope",
                                   "attempt", "maintenance_request_id"},
             "fresh held UI capture has an unsupported shape")
    accepted = captured["accepted"]
    preflight = captured["preflight"]
    inventory = captured["inventory"]
    source_scope = captured["source_scope"]
    _require(controller, captured["attempt"] == plan.get("attempt")
             and captured["maintenance_request_id"] == plan.get("maintenance_request_id"),
             "fresh held UI capture attempt or request UUID differs")
    _require(controller, isinstance(source_scope, Mapping)
             and source_scope == plan.get("source_scope")
             and isinstance(preflight, Mapping)
             and preflight.get("source_scope") == source_scope,
             "fresh API/source scope differs from the approved plan")
    controller.validate_preflight(preflight, accepted)
    controller.validate_inventory(inventory, accepted)
    actual_plan, actual_sha256 = controller.build_preview_plan(
        attempt=plan["attempt"],
        maintenance_request_id=plan["maintenance_request_id"],
        source_scope=source_scope,
        accepted=accepted,
        preflight=preflight,
        inventory=inventory,
    )
    _require(controller, actual_sha256 == expected_plan_sha256 and actual_plan == plan,
             "fresh API/native capture no longer matches the approved plan")
    _require(controller, accepted == plan["accepted"],
             "fresh accepted intent or request receipt differs from the approved plan")
    return accepted, preflight, inventory


def _assert_service_pins(controller, observed, expected, *, backend_running, frontend_running):
    _require(controller, isinstance(observed, Mapping) and set(observed) == {"backend", "frontend"},
             "held stop service inventory differs")
    _require(controller, isinstance(expected, Mapping) and set(expected) == {"backend", "frontend"},
             "approved service pins are incomplete")
    for name, should_run in (("backend", backend_running), ("frontend", frontend_running)):
        current = observed[name]
        pinned = expected[name]
        _require(controller, isinstance(current, Mapping) and isinstance(pinned, Mapping),
                 name + " service pin is malformed")
        _require(controller,
                 current.get("id") == pinned.get("id")
                 and current.get("image_id") == pinned.get("image_id")
                 and current.get("started_at") == pinned.get("started_at"),
                 name + " service incarnation differs from the approved source scope")
        _require(controller, current.get("running") is should_run,
                 name + " service running state differs at the held stop boundary")


def validate_api_to_drained_process(preflight, quiescence, process):
    """Accept only the supervisor's real API-exit rewrite and native drain."""
    from docker_volume_native_terminal_stop import QUIESCE_CAUSE, validate_drain

    retained = quiescence.get("retained_process") if isinstance(quiescence, Mapping) else None
    if not isinstance(retained, Mapping) or not isinstance(process, Mapping):
        raise ValueError("held UI API/native process receipts are malformed")
    if (process.get("state") != "drained"
            or retained.get("state") != "failed_outcome_retained"
            or retained.get("error") != QUIESCE_CAUSE
            or retained.get("api_diagnostic_only") is not False
            or process.get("error") != QUIESCE_CAUSE
            or process.get("api_diagnostic_only") is not False
            or process.get("api_pid") != quiescence.get("api_pin", {}).get("pid")
            or process.get("api_exit_code") != -15):
        raise ValueError("held UI supervisor API-exit transition differs")
    expected = dict(retained)
    expected["state"] = "drained"
    terminal_owner = process.get("terminal_service_owner")
    if not isinstance(terminal_owner, Mapping):
        raise ValueError("held UI native drain has no terminal service owner")
    expected["terminal_service_owner"] = dict(terminal_owner)
    if dict(process) != expected:
        raise ValueError("held UI process receipt changed outside the authenticated API-exit/native-drain transition")
    if preflight.get("api_pin", {}).get("pid") != quiescence.get("api_pin", {}).get("pid"):
        raise ValueError("held UI API/native drain is not anchored to preflight")
    validate_drain({"ready_owner": preflight["ready_owner_identity"],
                    "api_quiescence": quiescence}, process)


def _read_control_proof(control, relative, maximum):
    prefix = "" if relative.startswith("held-ui-materialization-stop/") else "runtime-control/"
    return control.read_bytes(prefix + relative, maximum=maximum)


def _build_request(controller, plan, stop_attempt, terminal_raw, proof_refs):
    maintenance_id = plan["maintenance_request_id"]
    terminal_path = ("held-ui-materialization-stop/attempts/" + stop_attempt
                     + "/terminal.json")
    request_root = controller.request_relative(maintenance_id).rsplit("/", 1)[0]
    request = {
        "schema": controller.REQUEST_SCHEMA,
        "plan": {"attempt": plan["attempt"], "plan_sha256": controller.sha(controller.canonical(plan)),
                 "maintenance_request_id": maintenance_id},
        "source_scope": dict(plan["source_scope"]),
        "accepted": dict(plan["accepted"]),
        "stop_authority": {
            "stop_attempt": stop_attempt,
            "terminal": {"path": terminal_path, "sha256": controller.sha(terminal_raw)},
            "preflight": dict(proof_refs["preflight"]),
            "api_quiescence": dict(proof_refs["api_quiescence"]),
            "native_drain": dict(proof_refs["native_drain"]),
            "inventory": dict(proof_refs["inventory"]),
        },
    }
    _require(controller, proof_refs["preflight"]["path"] == request_root + "/preflight.json"
             and proof_refs["inventory"]["path"] == request_root + "/inventory.json"
             and proof_refs["api_quiescence"]["path"] == request_root + "/api-quiescence.json"
             and proof_refs["native_drain"]["path"] == request_root + "/native-drain.json",
             "held stop proof references differ from the request UUID")
    return controller.validate_request(
        request,
        expected_maintenance_request_id=maintenance_id,
        expected_run_id=plan["accepted"]["run_id"],
        expected_plan_sha256=request["plan"]["plan_sha256"],
    )


def execute_stop_only(*, control, controller, plan: Mapping, expected_plan_sha256: str,
                      expected_services: Mapping, capture_fresh, inspect_services,
                      stop_service, preflight_drain, read_drain) -> dict:
    """Stop and authenticate one approved held run; never starts its replacement."""
    _require(controller, isinstance(plan, Mapping), "approved held UI plan is missing")
    expected_plan_sha256 = controller._digest(expected_plan_sha256, "approved plan digest")
    plan_sha256 = controller.sha(controller.canonical(plan))
    _require(controller, plan_sha256 == expected_plan_sha256,
             "approved plan bytes differ from the requested plan SHA")
    accepted = plan.get("accepted")
    source_scope = plan.get("source_scope")
    request_id = plan.get("maintenance_request_id")
    _require(controller, isinstance(accepted, Mapping) and isinstance(source_scope, Mapping),
             "approved held UI plan has no accepted/source bindings")
    inputs = _operation_inputs(plan, expected_plan_sha256)
    request_relative = controller.request_relative(request_id)
    intent_relative = controller.quiescence_intent_relative(request_id)
    claim_relative = controller.quiescence_start_claim_relative(request_id)
    for relative, label in ((request_relative, "completed request"),
                             (claim_relative, "spent API quiescence claim")):
        existing = control.read_bytes("runtime-control/" + relative, optional=True)
        _require(controller, existing is None,
                 "existing " + label + " forbids another stop attempt")
    _require(controller, isinstance(expected_services, Mapping)
             and set(expected_services) == {"backend", "frontend"},
             "approved backend/frontend service pins are incomplete")
    for name in ("backend", "frontend"):
        pinned = expected_services[name]
        _require(controller, isinstance(pinned, Mapping)
                 and pinned.get("id") == source_scope[name + "_container_id"]
                 and pinned.get("started_at") == source_scope[name + "_started_at"]
                 and isinstance(pinned.get("image_id"), str)
                 and pinned["image_id"].startswith("sha256:"),
                 name + " approved service incarnation differs from source scope")
    attempt = plan.get("attempt")

    with control.operation(STOP_PHASE, inputs) as operation:
        stop_attempt = controller._require_held_stop_operation(control, operation)
        _require(controller, stop_attempt != attempt,
                 "held stop attempt aliases the retained development attempt")
        receipt_inputs = operation["receipt"].get("inputs", {})
        _require(controller, isinstance(receipt_inputs, Mapping)
                 and all(receipt_inputs.get(key) == value for key, value in inputs.items()),
                 "held stop operation inputs differ from the approved scope")
        claim = control.read_bytes("runtime-control/" + claim_relative, optional=True)
        _require(controller, claim is None,
                 "API quiescence start claim already exists; replay is prohibited")

        accepted, preflight, inventory = _assert_plan(
            controller, plan, expected_plan_sha256, capture_fresh,
        )
        request_root = request_relative.rsplit("/", 1)[0]
        for leaf, label in (
            ("preflight.json", "preflight"),
            ("inventory.json", "inventory"),
            ("api-quiescence-intent.json", "API quiescence intent"),
            ("api-quiescence.json", "API quiescence receipt"),
            ("native-drain.json", "native drain proof"),
        ):
            existing = control.read_bytes(
                "runtime-control/" + request_root + "/" + leaf, optional=True,
            )
            _require(controller, existing is None,
                     "existing " + label + " artifact forbids a new held stop attempt")
        before_services = inspect_services()
        _assert_service_pins(controller, before_services, expected_services,
                             backend_running=True, frontend_running=True)
        preflight_drain(before_services["backend"])

        operation["daemon_pending"] = True
        operation["receipt"]["held_ui_stop_stage"] = "frontend-stop-outcome-unknown"
        stop_service("frontend", expected_services["frontend"]["id"])
        after_frontend = inspect_services()
        _assert_service_pins(controller, after_frontend, expected_services,
                             backend_running=True, frontend_running=False)
        operation["receipt"]["held_ui_stop_stage"] = "frontend-stopped"
        operation["daemon_pending"] = False

        accepted_after_frontend, preflight, inventory = _assert_plan(
            controller, plan, expected_plan_sha256, capture_fresh,
        )
        _require(controller, accepted_after_frontend == accepted,
                 "accepted RunIntent changed after frontend quiescence")
        proof_refs = controller.publish_api_quiescence_inputs(
            control, request_id, source_scope=source_scope, accepted=accepted,
            preflight=preflight, inventory=inventory,
        )
        intent, intent_raw, intent_sha256 = controller.prepare_api_quiescence_intent(
            attempt=plan["attempt"], maintenance_request_id=request_id,
            plan_sha256=expected_plan_sha256, source_scope=source_scope,
            accepted=accepted, preflight=preflight, inventory=inventory,
        )
        published_intent_path, published_intent_sha256 = controller.publish_api_quiescence_intent(
            control, intent, expected_plan_sha256=expected_plan_sha256,
        )
        _require(controller, published_intent_path == intent_relative
                 and published_intent_sha256 == intent_sha256,
                 "published quiescence intent differs from its immutable bytes")
        control.write_bytes(operation["root"] + "/api-quiescence-intent.json", intent_raw)
        operation["receipt"]["api_quiescence_intent_sha256"] = intent_sha256

        quiescence = controller.capture_held_api_quiescence(
            control, source_scope["backend_container_id"], intent,
            operation=operation, expected_plan_sha256=expected_plan_sha256,
            expected_intent_sha256=intent_sha256,
        )
        quiescence_raw = _canonical_lf(controller, quiescence)
        quiescence_relative = request_relative.rsplit("/", 1)[0] + "/api-quiescence.json"
        controller._publish_immutable_record(
            control, quiescence_relative, quiescence_raw, "API quiescence proof",
        )
        proof_refs["api_quiescence"] = {
            "path": quiescence_relative, "sha256": controller.sha(quiescence_raw),
        }

        # API exit changes the supervisor receipt once; the spent claim and the
        # retained post-close receipt forbid another API signal or restart.
        operation["daemon_pending"] = True
        durable_intent = control.read_bytes("runtime-control/" + intent_relative)
        _require(controller, durable_intent == intent_raw,
                 "quiescence intent changed after API closure")
        controller._validate_durable_quiescence_inputs(control, intent)
        before_backend_stop = inspect_services()
        _assert_service_pins(controller, before_backend_stop, expected_services,
                             backend_running=True, frontend_running=False)
        stop_service("backend", expected_services["backend"]["id"])
        stopped_services = inspect_services()
        _assert_service_pins(controller, stopped_services, expected_services,
                             backend_running=False, frontend_running=False)
        _require(controller, stopped_services["backend"].get("exit_code") == 1,
                 "API-quiesced backend did not exit through the expected supervisor path")
        native_drain_raw, native_drain = read_drain(stopped_services["backend"])
        validate_api_to_drained_process(preflight, quiescence, native_drain)
        native_drain_relative = request_relative.rsplit("/", 1)[0] + "/native-drain.json"
        controller._publish_immutable_record(
            control, native_drain_relative, native_drain_raw, "native drain proof",
        )
        proof_refs["native_drain"] = {
            "path": native_drain_relative, "sha256": controller.sha(native_drain_raw),
        }
        controller._validate_durable_quiescence_inputs(control, intent)

        stopped_pins = {
            name: {"id": service["id"], "image_id": service["image_id"],
                   "started_at": service["started_at"], "running": False}
            for name, service in stopped_services.items()
        }
        stopped_raw = _canonical_lf(controller, stopped_pins)
        receipt = operation["receipt"]
        receipt.update(
            state="succeeded", config_sha256=source_scope["runtime_config_sha256"],
            idle_backend_stopped=True,
            backend_container=source_scope["backend_container_id"],
            backend_started_at=source_scope["backend_started_at"],
            frontend_container=source_scope["frontend_container_id"],
            frontend_started_at=source_scope["frontend_started_at"],
            held_ui_stop_services=stopped_pins,
            held_ui_stop_services_sha256=controller.sha(stopped_raw),
            held_ui_stop_proofs={
                key: dict(proof_refs[key])
                for key in ("preflight", "api_quiescence", "native_drain", "inventory")
            },
        )
        operation["daemon_pending"] = False

    terminal_path = operation["root"] + "/terminal.json"
    terminal_raw = control.read_bytes(terminal_path)
    terminal = controller.decode(terminal_raw, "held UI stop terminal", maximum=controller.MAX_PROOF_BYTES)
    _require(controller, terminal.get("state") == "succeeded"
             and terminal.get("idle_backend_stopped") is True
             and terminal.get("api_quiescence_intent_sha256") == intent_sha256,
             "completed held stop terminal differs")
    authority = {
        "stop_attempt": stop_attempt,
        "terminal": {"path": "held-ui-materialization-stop/attempts/" + stop_attempt
                              + "/terminal.json", "sha256": controller.sha(terminal_raw)},
        **proof_refs,
    }
    request = _build_request(controller, plan, stop_attempt, terminal_raw, proof_refs)
    request["stop_authority"] = authority
    request = controller.validate_request(
        request, expected_maintenance_request_id=request_id,
        expected_run_id=accepted["run_id"], expected_plan_sha256=expected_plan_sha256,
    )

    # Publish the startup request under a second short group lease, after the
    # first operation's exact terminal bytes are final.
    publish_inputs = {
        "source_root": source_scope["source_root"],
        "config_sha256": source_scope["runtime_config_sha256"],
        "maintenance_request_id": request_id,
        "plan_sha256": expected_plan_sha256,
        "stop_attempt": stop_attempt,
        "run_id": accepted["run_id"],
        "request_sha256": controller.sha(_canonical_lf(controller, request)),
    }
    with control.operation(PUBLISH_PHASE, publish_inputs) as publish_operation:
        request_after_lock = control.read_bytes("runtime-control/" + request_relative, optional=True)
        _require(controller, request_after_lock is None,
                 "another request was published for this maintenance UUID")
        current_services = inspect_services()
        _assert_service_pins(controller, current_services, expected_services,
                             backend_running=False, frontend_running=False)
        current_terminal = control.read_bytes(terminal_path)
        _require(controller, current_terminal == terminal_raw,
                 "held stop terminal changed before request publication")
        controller.validate_stop_proofs(request, lambda relative: _read_control_proof(
            control, relative, controller.MAX_PROOF_BYTES,
        ))
        publish_operation["daemon_pending"] = True
        published_path, published_sha256 = controller.publish_request(control, request)
        saved_request, saved_raw = controller.load_request(control, request_id, published_sha256)
        _require(controller, saved_request == request and saved_raw == _canonical_lf(controller, request)
                 and published_path == request_relative,
                 "published held request did not read back byte-exactly")
        publish_operation["receipt"].update(state="succeeded", request_path=published_path,
                                             request_sha256=published_sha256,
                                             stop_attempt=stop_attempt)
        publish_operation["daemon_pending"] = False

    return {
        "state": "stopped-awaiting-typed-recreate",
        "attempt": stop_attempt,
        "request_path": request_relative,
        "request_sha256": published_sha256,
        "plan_sha256": expected_plan_sha256,
        "run_id": accepted["run_id"],
        "command_id": accepted["command_id"],
    }


def resume_publish_only(*, control, controller, plan: Mapping, claim: Mapping,
                        terminal_raw: bytes, proof_refs: Mapping,
                        expected_plan_sha256: str, expected_services: Mapping,
                        inspect_services, read_control_record) -> dict:
    """Publish or reconcile the request from one already completed held stop."""
    expected_plan_sha256 = controller._digest(expected_plan_sha256, "approved preview plan digest")
    plan_sha256 = controller.sha(controller.canonical(plan))
    _require(controller, plan_sha256 == expected_plan_sha256,
             "publish-only plan differs from the approved preview digest")
    accepted = plan.get("accepted")
    request_id = plan.get("maintenance_request_id")
    stop_attempt = claim.get("operation_attempt") if isinstance(claim, Mapping) else None
    _require(controller, isinstance(accepted, Mapping)
             and isinstance(claim, Mapping)
             and set(claim) == {
                 "schema", "state", "maintenance_request_id", "plan_sha256", "intent_sha256",
                 "run_id", "run_intent_sha256", "backend_container_id", "operation_attempt",
             }
             and claim.get("schema") == "fullmag.held-ui-materialization-api-quiescence-start.v1"
             and claim.get("state") == "started"
             and claim.get("maintenance_request_id") == request_id
             and claim.get("plan_sha256") == expected_plan_sha256
             and claim.get("run_id") == accepted.get("run_id")
             and claim.get("run_intent_sha256") == accepted.get("run_intent_sha256")
             and claim.get("backend_container_id") == plan.get("source_scope", {}).get("backend_container_id")
             and isinstance(stop_attempt, str)
             and len(stop_attempt) == 32
             and all(character in "0123456789abcdef" for character in stop_attempt),
             "publish-only claim has no exact stop attempt")
    terminal = controller.decode(terminal_raw, "held UI stop terminal",
                                 maximum=controller.MAX_PROOF_BYTES)
    _require(controller, terminal.get("attempt") == stop_attempt
             and terminal.get("state") == "succeeded"
             and terminal.get("idle_backend_stopped") is True
             and terminal.get("inputs", {}).get("plan_sha256") == expected_plan_sha256
             and terminal.get("inputs", {}).get("maintenance_request_id") == request_id
             and terminal.get("api_quiescence_intent_sha256") == claim.get("intent_sha256")
             and terminal.get("inputs", {}).get("run_id") == accepted.get("run_id"),
             "publish-only terminal does not bind the exact completed stop")
    terminal_proofs = terminal.get("held_ui_stop_proofs")
    _require(controller, isinstance(terminal_proofs, Mapping)
             and dict(terminal_proofs) == dict(proof_refs),
             "publish-only proof references differ from the succeeded terminal")
    request = _build_request(controller, plan, stop_attempt, terminal_raw, proof_refs)
    request_sha256 = controller.sha(_canonical_lf(controller, request))
    publish_inputs = {
        "source_root": plan["source_scope"]["source_root"],
        "config_sha256": plan["source_scope"]["runtime_config_sha256"],
        "maintenance_request_id": request_id,
        "plan_sha256": expected_plan_sha256,
        "stop_attempt": stop_attempt,
        "run_id": accepted["run_id"],
        "request_sha256": request_sha256,
    }

    def validate_completed_stop():
        current_services = inspect_services()
        _assert_service_pins(controller, current_services, expected_services,
                             backend_running=False, frontend_running=False)
        authority = request["stop_authority"]
        current_terminal = read_control_record(authority["terminal"]["path"])
        _require(controller, current_terminal == terminal_raw,
                 "publish-only terminal changed after stop completion")
        controller.validate_stop_proofs(request, read_control_record)

    validate_completed_stop()
    existing = control.read_bytes(
        "runtime-control/" + controller.request_relative(request_id), optional=True,
    )
    if existing is not None:
        loaded, loaded_raw = controller.load_request(control, request_id, request_sha256)
        _require(controller, loaded == request and loaded_raw == _canonical_lf(controller, request),
                 "existing request differs from the completed stop authority")
        return {"state": "stopped-awaiting-typed-recreate", "attempt": stop_attempt,
                "request_path": controller.request_relative(request_id),
                "request_sha256": request_sha256, "plan_sha256": expected_plan_sha256,
                "run_id": accepted["run_id"], "command_id": accepted["command_id"]}

    with control.operation(PUBLISH_PHASE, publish_inputs) as publish_operation:
        existing = control.read_bytes(
            "runtime-control/" + controller.request_relative(request_id), optional=True,
        )
        _require(controller, existing is None,
                 "another request was published for this maintenance UUID")
        validate_completed_stop()
        publish_operation["daemon_pending"] = True
        published_path, published_sha256 = controller.publish_request(control, request)
        saved_request, saved_raw = controller.load_request(control, request_id, published_sha256)
        _require(controller, saved_request == request
                 and saved_raw == _canonical_lf(controller, request)
                 and published_path == controller.request_relative(request_id)
                 and published_sha256 == request_sha256,
                 "publish-only request readback differs from its completed stop")
        publish_operation["receipt"].update(state="succeeded", request_path=published_path,
                                             request_sha256=published_sha256,
                                             stop_attempt=stop_attempt)
        publish_operation["daemon_pending"] = False
    return {"state": "stopped-awaiting-typed-recreate", "attempt": stop_attempt,
            "request_path": controller.request_relative(request_id),
            "request_sha256": request_sha256, "plan_sha256": expected_plan_sha256,
            "run_id": accepted["run_id"], "command_id": accepted["command_id"]}
