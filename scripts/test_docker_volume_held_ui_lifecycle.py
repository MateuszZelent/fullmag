"""Mock-only state-transition tests for the held UI stop boundary."""
from __future__ import annotations

import hashlib
import json
import unittest
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import Mock

import docker_volume_held_ui_lifecycle as subject


PLAN_SHA = "a" * 64
ATTEMPT = "b" * 32
MAINTENANCE_ID = "c2119b25-9cf7-4bfa-a87c-cecfdc706ede"
RUN_ID = "run-live-6b6552a649f3cd4a87309ab4b48a1f0c83c0a884636a180dea580f83e0bf8cd0"
BACKEND_ID = "1" * 64
FRONTEND_ID = "2" * 64
BACKEND_IMAGE = "sha256:" + "3" * 64
FRONTEND_IMAGE = "sha256:" + "4" * 64
API_ID = "75c6d4d1-00a9-416d-b27e-6fda461ad85d"
OWNER_ID = {
    "owner_token": "a" * 32, "process_start_token": "100", "pid": 900,
    "host": "host", "target_id": "docker-all", "protocol": 2,
    "build_commit": "5" * 40, "build_snapshot": "6" * 64,
    "control_address": "127.0.0.1:1", "compute_pool_generation": 1,
    "preparation_pool_generation": 1, "compute_pool_id": "compute",
    "preparation_pool_id": "prepare", "children": [["compute", 901], ["preparation", 902]],
}


def canon(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False).encode("utf-8")


def encoded(value):
    return canon(value) + b"\n"


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def process_base():
    return {
        "schema": "fullmag.docker-process-tree.v1", "state": "failed_outcome_retained",
        "api_pid": 777, "api_exit_code": -15, "api_diagnostic_only": False,
        "error": "Fullmag API exited unexpectedly (-15)",
        "accepted_store": "/state/runs/docker-all/session-store",
        "bootstrap": {"schema": "fullmag.docker-accepted-store-bootstrap.v1",
                      "store_root": "/state/runs/docker-all/session-store",
                      "binding": "7" * 64},
        "service_owner": {"state": "ready", **OWNER_ID,
                           "children": [{"role": "compute", "pid": 901, "status": "running"},
                                        {"role": "preparation", "pid": 902, "status": "running"}]},
    }


def drained_process():
    result = process_base()
    result["state"] = "drained"
    result["terminal_service_owner"] = {"state": "drained", **OWNER_ID,
        "children": [{"role": "compute", "pid": 901, "status": "exited_success"},
                     {"role": "preparation", "pid": 902, "status": "exited_success"}]}
    return result


def fixtures(*, stop_backend_error=None, stale_plan=False, foreign_service=False,
             fresh_scope_drift=False, malformed_fresh_scope=False,
             fail_publish_admission=False):
    events = []
    records = {}
    source_scope = {
        "compose_project": "project-p22", "control_volume": "control-p22",
        "namespace": "", "namespace_registry_sha256": None,
        "source_root": "/repo/task", "state_root_sha256": "8" * 64,
        "backend_container_id": BACKEND_ID, "backend_started_at": "2026-11-13T15:00:00Z",
        "frontend_container_id": FRONTEND_ID, "frontend_started_at": "2026-11-13T15:00:01Z",
        "runtime_config_sha256": "9" * 64,
    }
    accepted = {
        "project_id": "project-live", "run_id": RUN_ID, "session_id": "session", "session_epoch": 1,
        "session_created_at_unix_ms": 1794582150656, "old_api_instance_id": API_ID,
        "old_request_scope_epoch": API_ID + ":1", "scene_revision": 2,
        "run_intent_sha256": "1" * 64, "run_intent_payload_sha256": "2" * 64,
        "definition_sha256": "3" * 64, "study_sha256": "4" * 64,
        "accepted_scene_sha256": "5" * 64, "execution_input_sha256": "6" * 64,
        "command_id": "fm-5886f18f-96bd-481b-a064-726f49b22d07", "command_kind": "relax",
        "client_intent_id": "study:relax:test", "request_id": "09126e13-8dce-4a7b-9093-350188eb660a",
        "request_sha256": "0" * 64, "request_key_sha256": "7" * 64,
        "request_receipt_sha256": "8" * 64,
    }
    inventory_side = {
        "run_id": RUN_ID, "store_id": "sha256:" + "a" * 64,
        "run_intent_sha256": accepted["run_intent_sha256"],
        "run_intent_payload_sha256": accepted["run_intent_payload_sha256"],
        "definition_sha256": accepted["definition_sha256"], "study_sha256": accepted["study_sha256"],
        "execution_input": {"schema_version": "fullmag.scene_execution_input.v1",
                            "sha256": accepted["execution_input_sha256"]},
        "run_files": [{"name": "live_demand.v1.json", "sha256": "b" * 64},
                       {"name": "run_intent.json", "sha256": accepted["run_intent_sha256"]}],
        "run_catalog_absent": True, "start_release_absent": True, "pending_materialization": True,
        "task_attempts": [], "leases": [], "workers": [], "outputs": [], "other_active_runs": [],
    }
    inventory = {"schema": "fullmag.held-ui-materialization-inventory.v1",
                 "before": inventory_side, "after": inventory_side}
    preflight = {
        "schema": "fullmag.held-ui-materialization-preflight.v1", "source_scope": source_scope,
        "api_response": {"snapshot": {"api_instance_id": API_ID}},
        "accepted_store_binding": "7" * 64, "native_config_sha256": "d" * 64,
        "process_sha256": "e" * 64, "api_pin": {"pid": 777, "start_token": "10",
            "ppid": 1, "argv": ["/opt/fullmag/package/bin/fullmag-api"],
            "exe": "/opt/fullmag/package/bin/fullmag-api"},
        "ready_owner_identity": OWNER_ID, "ready_owner_sha256": "f" * 64,
        "run_intent_sha256": accepted["run_intent_sha256"],
        "execution_input_sha256": accepted["execution_input_sha256"],
    }
    plan = {"schema": "fullmag.development-held-ui-materialization-plan.v1", "attempt": ATTEMPT,
            "maintenance_request_id": MAINTENANCE_ID, "source_scope": source_scope,
            "accepted": accepted, "current": {"api_instance_id": API_ID},
            "native": {"config_sha256": "d" * 64}, "inventory": inventory_side}
    service_pins = {"backend": {"id": BACKEND_ID, "image_id": BACKEND_IMAGE,
                    "started_at": source_scope["backend_started_at"]},
                    "frontend": {"id": FRONTEND_ID, "image_id": FRONTEND_IMAGE,
                    "started_at": source_scope["frontend_started_at"]}}

    class Control:
        project = "project-p22"
        volume = "control-p22"
        namespace = ""
        namespace_registry_sha256 = None
        _active_operation = None
        _fail_publish_admission_once = fail_publish_admission

        def read_bytes(self, relative, *, optional=False, maximum=None):
            if relative not in records:
                if optional:
                    return None
                raise AssertionError("missing fake control record: " + relative)
            return records[relative]

        def write_bytes(self, relative, data):
            if relative in records:
                raise AssertionError("immutable record overwritten: " + relative)
            records[relative] = bytes(data)

        @contextmanager
        def operation(self, phase, inputs):
            if phase == subject.PUBLISH_PHASE and self._fail_publish_admission_once:
                self._fail_publish_admission_once = False
                events.append(("publish-admission-failed", phase))
                raise RuntimeError("publish lease admission unavailable")
            if self._active_operation is not None:
                raise RuntimeError("operation already active")
            op_attempt = "d" * 32
            receipt = {"schema": "fullmag.docker-build-operation.v1", "phase": phase,
                       "attempt": op_attempt, "state": "starting", "inputs": dict(inputs),
                       "compose_project": self.project, "control_volume": self.volume,
                       "control_namespace": "", "namespace_registry_sha256": None}
            operation = {"receipt": receipt, "root": phase + "/attempts/" + op_attempt,
                         "lease_ready": True, "daemon_pending": False}
            self._active_operation = operation
            events.append(("lease", phase))
            try:
                yield operation
            except BaseException:
                if not operation["daemon_pending"]:
                    self._active_operation = None
                else:
                    events.append(("lease-retained", operation["receipt"].get("state")))
                raise
            else:
                receipt["finished_at"] = 1
                receipt["filesystem_after"] = {"available_bytes": 1}
                records[operation["root"] + "/terminal.json"] = encoded(receipt)
                self._active_operation = None
                events.append(("lease-released", receipt.get("state")))

    control = Control()

    plan_sha = sha(canon(plan))

    class Controller:
        REQUEST_SCHEMA = "fullmag.held-ui-materialization-request.v1"
        MAX_PROOF_BYTES = 256 * 1024
        _require = staticmethod(lambda condition, message: None if condition else (_ for _ in ()).throw(ValueError(message)))
        _digest = staticmethod(lambda value, _label: value)
        canonical = staticmethod(canon)
        sha = staticmethod(sha)
        decode = staticmethod(lambda raw, _label, **_kwargs: json.loads(raw))
        request_relative = staticmethod(lambda request_id: "held-ui-materialization/" + request_id + "/request.json")
        quiescence_intent_relative = staticmethod(lambda request_id: "held-ui-materialization/" + request_id + "/api-quiescence-intent.json")
        quiescence_start_claim_relative = staticmethod(lambda request_id: "held-ui-materialization/" + request_id + "/api-quiescence-start.json")

        def build_preview_plan(self, **kwargs):
            return plan, "0" * 64 if stale_plan else plan_sha

        def validate_preflight(self, value, accepted_value):
            if value.get("source_scope") != plan["source_scope"]:
                raise ValueError("fresh preflight source scope differs")
            return value

        def _require_held_stop_operation(self, control_value, operation):
            if (control_value._active_operation is not operation or not operation["lease_ready"]
                    or operation["daemon_pending"]
                    or operation["receipt"].get("phase") != subject.STOP_PHASE):
                raise ValueError("active held-stop lease differs")
            return operation["receipt"]["attempt"]

        def _validate_durable_quiescence_inputs(self, control_value, intent):
            relative = self.quiescence_intent_relative(MAINTENANCE_ID)
            raw = control_value.read_bytes("runtime-control/" + relative)
            if json.loads(raw) != intent:
                raise ValueError("durable intent changed")

        def validate_inventory(self, value, accepted_value):
            if value["before"] != value["after"] or any(value["before"][key] for key in ("leases", "workers", "outputs")):
                raise ValueError("inventory is not empty/stable")
            return value

        def publish_api_quiescence_inputs(self, control_value, request_id, **kwargs):
            events.append(("publish-inputs", None))
            root = "runtime-control/held-ui-materialization/" + request_id + "/"
            refs = {}
            for key, leaf in (("preflight", "preflight.json"), ("inventory", "inventory.json")):
                raw = encoded(kwargs[key])
                path = root + leaf
                control_value.write_bytes(path, raw)
                refs[key] = {"path": path.removeprefix("runtime-control/"), "sha256": sha(raw)}
            return refs

        def prepare_api_quiescence_intent(self, **kwargs):
            events.append(("prepare-intent", None))
            intent = {"schema": "fullmag.held-ui-materialization-api-quiescence-intent.v1",
                      "plan_sha256": plan_sha, "plan": plan,
                      "preflight_sha256": sha(encoded(preflight)), "inventory_sha256": sha(encoded(inventory)),
                      "ready_owner_identity": OWNER_ID}
            raw = encoded(intent)
            return intent, raw, sha(raw)

        def publish_api_quiescence_intent(self, control_value, intent, *, expected_plan_sha256):
            events.append(("publish-intent", None))
            path = self.quiescence_intent_relative(MAINTENANCE_ID)
            control_value.write_bytes("runtime-control/" + path, encoded(intent))
            return path, sha(encoded(intent))

        def capture_held_api_quiescence(self, control_value, backend_id, intent, **kwargs):
            events.append(("api-close", backend_id))
            claim_path = "runtime-control/" + self.quiescence_start_claim_relative(MAINTENANCE_ID)
            claim = {
                "schema": "fullmag.held-ui-materialization-api-quiescence-start.v1",
                "state": "started", "maintenance_request_id": MAINTENANCE_ID,
                "plan_sha256": plan_sha, "intent_sha256": kwargs["expected_intent_sha256"],
                "run_id": RUN_ID, "run_intent_sha256": accepted["run_intent_sha256"],
                "backend_container_id": BACKEND_ID, "operation_attempt": "d" * 32,
            }
            claim_raw = encoded(claim)
            control_value.write_bytes(claim_path, claim_raw)
            op = kwargs["operation"]
            op["receipt"]["held_ui_api_quiescence_claim"] = {
                "path": self.quiescence_start_claim_relative(MAINTENANCE_ID),
                "sha256": sha(claim_raw), "operation_attempt": "d" * 32,
                "state": "consumed", "quiescence_receipt_sha256": sha(encoded(quiescence)),
            }
            op["daemon_pending"] = False
            return {**quiescence,
                    "intent_sha256": kwargs["expected_intent_sha256"],
                    "retained_process_sha256": sha(encoded(quiescence["retained_process"]))}

        def _publish_immutable_record(self, control_value, relative, raw, label):
            control_value.write_bytes("runtime-control/" + relative, raw)
            events.append(("publish-" + label, None))
            return sha(raw)

        def validate_request(self, value, **kwargs):
            if value["accepted"]["run_id"] != RUN_ID:
                raise ValueError("run mismatch")
            return value

        def validate_stop_proofs(self, value, read_record):
            events.append(("validate-stop-proofs", None))
            for key in ("preflight", "api_quiescence", "native_drain", "inventory", "terminal"):
                read_record(value["stop_authority"][key]["path"])
            terminal = json.loads(read_record(value["stop_authority"]["terminal"]["path"]))
            read_record(terminal["held_ui_api_quiescence_claim"]["path"])
            return {}

        def publish_request(self, control_value, value):
            raw = encoded(value)
            path = "runtime-control/" + self.request_relative(MAINTENANCE_ID)
            control_value.write_bytes(path, raw)
            events.append(("publish-request", path))
            return self.request_relative(MAINTENANCE_ID), sha(raw)

        def load_request(self, control_value, request_id, expected_sha256):
            path = "runtime-control/" + self.request_relative(request_id)
            raw = control_value.read_bytes(path)
            if sha(raw) != expected_sha256:
                raise ValueError("request hash differs")
            return json.loads(raw), raw

    controller = Controller()
    quiescence = {
        "schema": "fullmag.native-terminal-api-quiescence.v1", "intent_sha256": "1" * 64,
        "api_pin": preflight["api_pin"], "api_closed": True, "signal": "SIGTERM",
        "retained_process": process_base(),
        "retained_process_sha256": sha(encoded(process_base())),
    }
    current_calls = []

    def capture_fresh():
        current_calls.append("capture")
        fresh_scope = dict(source_scope)
        if fresh_scope_drift:
            fresh_scope["backend_started_at"] = "changed"
        fresh_preflight = dict(preflight)
        if fresh_scope_drift:
            fresh_preflight["source_scope"] = fresh_scope
        return {
            "accepted": accepted,
            "preflight": fresh_preflight,
            "inventory": inventory,
            "source_scope": fresh_scope,
            "attempt": "other" if malformed_fresh_scope else ATTEMPT,
            "maintenance_request_id": MAINTENANCE_ID,
        }

    current_service_state = {name: {**value, "running": True, "exit_code": 0}
                             for name, value in service_pins.items()}
    if foreign_service:
        current_service_state["backend"]["id"] = "f" * 64

    def inspect_services():
        return {name: dict(value) for name, value in current_service_state.items()}

    def stop_service(name, container_id):
        events.append(("stop", name, container_id))
        if name == "backend" and stop_backend_error is not None:
            raise stop_backend_error
        current_service_state[name]["running"] = False
        current_service_state[name]["exit_code"] = 1 if name == "backend" else 0

    def preflight_drain(_backend):
        events.append(("preflight-drain", None))

    def read_drain(_backend):
        events.append(("read-drain", None))
        process = drained_process()
        return encoded(process), process

    return SimpleNamespace(
        control=control, controller=controller, events=events, records=records, plan=plan,
        plan_sha256=plan_sha, source_scope=source_scope, accepted=accepted,
        preflight=preflight, inventory=inventory, service_pins=service_pins,
        capture_fresh=capture_fresh, inspect_services=inspect_services,
        stop_service=stop_service, preflight_drain=preflight_drain, read_drain=read_drain,
        request_id=MAINTENANCE_ID, attempt=ATTEMPT, run_id=RUN_ID,
        stale_plan=stale_plan, foreign_service=foreign_service,
        fresh_scope_drift=fresh_scope_drift, malformed_fresh_scope=malformed_fresh_scope,
        fail_publish_admission=fail_publish_admission,
    )


class HeldStopLifecycle(unittest.TestCase):
    def test_success_has_ordered_frontend_quiescence_api_close_native_drain_and_request(self):
        fx = fixtures()
        result = subject.execute_stop_only(
            control=fx.control, controller=fx.controller, plan=fx.plan,
            expected_plan_sha256=fx.plan_sha256, expected_services=fx.service_pins,
            capture_fresh=fx.capture_fresh, inspect_services=fx.inspect_services,
            stop_service=fx.stop_service, preflight_drain=fx.preflight_drain,
            read_drain=fx.read_drain,
        )
        actions = [event[0] for event in fx.events]
        self.assertLess(actions.index("lease"), actions.index("stop"))
        self.assertLess(actions.index("stop"), actions.index("publish-inputs"))
        self.assertLess(actions.index("publish-inputs"), actions.index("api-close"))
        self.assertLess(actions.index("api-close"), actions.index("stop", actions.index("api-close")))
        self.assertLess(actions.index("read-drain"), actions.index("publish-request"))
        self.assertEqual(result["state"], "stopped-awaiting-typed-recreate")
        self.assertEqual(fx.control._active_operation, None)
        self.assertEqual(sum(event[0] == "api-close" for event in fx.events), 1)
        self.assertIn("runtime-control/held-ui-materialization/" + MAINTENANCE_ID + "/request.json",
                      fx.records)

    def test_stale_plan_is_rejected_before_frontend_stop_or_api_signal(self):
        fx = fixtures(stale_plan=True)
        with self.assertRaisesRegex(ValueError, "approved plan"):
            subject.execute_stop_only(
                control=fx.control, controller=fx.controller, plan=fx.plan,
                expected_plan_sha256=fx.plan_sha256, expected_services=fx.service_pins,
                capture_fresh=fx.capture_fresh, inspect_services=fx.inspect_services,
                stop_service=fx.stop_service, preflight_drain=fx.preflight_drain,
                read_drain=fx.read_drain,
            )
        self.assertFalse(any(event[0] in {"stop", "api-close"} for event in fx.events))

    def test_preexisting_immutable_capture_artifacts_are_rejected_before_frontend_stop(self):
        for leaf in (
            "preflight.json", "inventory.json", "api-quiescence-intent.json",
            "api-quiescence.json", "native-drain.json",
        ):
            with self.subTest(leaf=leaf):
                fx = fixtures()
                path = "runtime-control/held-ui-materialization/" + MAINTENANCE_ID + "/" + leaf
                fx.records[path] = b"preexisting immutable artifact\n"
                with self.assertRaisesRegex(ValueError, "forbids a new held stop attempt"):
                    subject.execute_stop_only(
                        control=fx.control, controller=fx.controller, plan=fx.plan,
                        expected_plan_sha256=fx.plan_sha256, expected_services=fx.service_pins,
                        capture_fresh=fx.capture_fresh, inspect_services=fx.inspect_services,
                        stop_service=fx.stop_service, preflight_drain=fx.preflight_drain,
                        read_drain=fx.read_drain,
                    )
                self.assertFalse(any(event[0] in {"stop", "api-close"} for event in fx.events))

    def test_foreign_service_id_is_rejected_before_any_stop(self):
        fx = fixtures(foreign_service=True)
        with self.assertRaisesRegex(ValueError, "service incarnation"):
            subject.execute_stop_only(
                control=fx.control, controller=fx.controller, plan=fx.plan,
                expected_plan_sha256=fx.plan_sha256, expected_services=fx.service_pins,
                capture_fresh=fx.capture_fresh, inspect_services=fx.inspect_services,
                stop_service=fx.stop_service, preflight_drain=fx.preflight_drain,
                read_drain=fx.read_drain,
            )
        self.assertFalse(any(event[0] in {"stop", "api-close"} for event in fx.events))

    def test_fresh_source_scope_drift_is_rejected_before_frontend_stop(self):
        fx = fixtures(fresh_scope_drift=True)
        with self.assertRaisesRegex(ValueError, "fresh API/source scope"):
            subject.execute_stop_only(
                control=fx.control, controller=fx.controller, plan=fx.plan,
                expected_plan_sha256=fx.plan_sha256, expected_services=fx.service_pins,
                capture_fresh=fx.capture_fresh, inspect_services=fx.inspect_services,
                stop_service=fx.stop_service, preflight_drain=fx.preflight_drain,
                read_drain=fx.read_drain,
            )
        self.assertFalse(any(event[0] in {"stop", "api-close"} for event in fx.events))

    def test_fresh_attempt_mismatch_is_rejected_before_frontend_stop(self):
        fx = fixtures(malformed_fresh_scope=True)
        with self.assertRaisesRegex(ValueError, "attempt or request UUID"):
            subject.execute_stop_only(
                control=fx.control, controller=fx.controller, plan=fx.plan,
                expected_plan_sha256=fx.plan_sha256, expected_services=fx.service_pins,
                capture_fresh=fx.capture_fresh, inspect_services=fx.inspect_services,
                stop_service=fx.stop_service, preflight_drain=fx.preflight_drain,
                read_drain=fx.read_drain,
            )
        self.assertFalse(any(event[0] in {"stop", "api-close"} for event in fx.events))

    def test_backend_stop_timeout_retains_group_lease_and_never_replays(self):
        fx = fixtures(stop_backend_error=TimeoutError("Docker stop outcome unknown"))
        with self.assertRaisesRegex(TimeoutError, "outcome unknown"):
            subject.execute_stop_only(
                control=fx.control, controller=fx.controller, plan=fx.plan,
                expected_plan_sha256=fx.plan_sha256, expected_services=fx.service_pins,
                capture_fresh=fx.capture_fresh, inspect_services=fx.inspect_services,
                stop_service=fx.stop_service, preflight_drain=fx.preflight_drain,
                read_drain=fx.read_drain,
            )
        self.assertTrue(fx.control._active_operation["daemon_pending"])
        backend_stops = [event for event in fx.events if event[:2] == ("stop", "backend")]
        self.assertEqual(len(backend_stops), 1)
        self.assertTrue(any(event[0] == "lease-retained" for event in fx.events))

    def test_only_truthful_supervisor_rewrite_then_successful_native_drain_is_accepted(self):
        retained = process_base()
        drained = drained_process()
        quiescence = {"schema": "fullmag.native-terminal-api-quiescence.v1",
                      "intent_sha256": "9" * 64,
                      "api_pin": {"pid": 777, "start_token": "10", "ppid": 1,
                                  "argv": ["/opt/fullmag/package/bin/fullmag-api"],
                                  "exe": "/opt/fullmag/package/bin/fullmag-api"},
                      "api_closed": True, "signal": "SIGTERM",
                      "retained_process": retained,
                      "retained_process_sha256": sha(encoded(retained))}
        subject.validate_api_to_drained_process(
            {"ready_owner_identity": OWNER_ID, "api_pin": {"pid": 777}}, quiescence, drained,
        )
        changed = dict(drained)
        changed["accepted_store"] = "/other/store"
        with self.assertRaisesRegex(Exception, "changed outside"):
            subject.validate_api_to_drained_process(
                {"ready_owner_identity": OWNER_ID, "api_pin": {"pid": 777}}, quiescence, changed,
            )

    def test_publish_only_resume_uses_spent_claim_without_repeating_stop_or_signal(self):
        fx = fixtures(fail_publish_admission=True)
        with self.assertRaisesRegex(RuntimeError, "publish lease admission unavailable"):
            subject.execute_stop_only(
                control=fx.control, controller=fx.controller, plan=fx.plan,
                expected_plan_sha256=fx.plan_sha256, expected_services=fx.service_pins,
                capture_fresh=fx.capture_fresh, inspect_services=fx.inspect_services,
                stop_service=fx.stop_service, preflight_drain=fx.preflight_drain,
                read_drain=fx.read_drain,
            )
        stop_attempt = "d" * 32
        terminal_path = "held-ui-materialization-stop/attempts/" + stop_attempt + "/terminal.json"
        terminal_raw = fx.records[terminal_path]
        terminal = json.loads(terminal_raw)
        claim_ref = terminal["held_ui_api_quiescence_claim"]
        claim = json.loads(fx.records["runtime-control/" + claim_ref["path"]])
        proof_refs = terminal["held_ui_stop_proofs"]

        def read_control_record(relative):
            path = relative if relative.startswith("held-ui-materialization-stop/") else "runtime-control/" + relative
            return fx.control.read_bytes(path)

        stops_before = [event for event in fx.events if event[0] == "stop"]
        signals_before = [event for event in fx.events if event[0] == "api-close"]
        result = subject.resume_publish_only(
            control=fx.control, controller=fx.controller, plan=fx.plan, claim=claim,
            terminal_raw=terminal_raw, proof_refs=proof_refs,
            expected_plan_sha256=fx.plan_sha256, expected_services=fx.service_pins,
            inspect_services=fx.inspect_services, read_control_record=read_control_record,
        )
        self.assertEqual(result["state"], "stopped-awaiting-typed-recreate")
        self.assertEqual([event for event in fx.events if event[0] == "stop"], stops_before)
        self.assertEqual([event for event in fx.events if event[0] == "api-close"], signals_before)
        self.assertEqual(sum(event[0] == "stop" and event[1] == "frontend" for event in fx.events), 1)
        self.assertEqual(sum(event[0] == "stop" and event[1] == "backend" for event in fx.events), 1)
        self.assertEqual(sum(event[0] == "api-close" for event in fx.events), 1)


if __name__ == "__main__":
    unittest.main()
