"""Exercise the held-stop producer through the production proof validator."""
from __future__ import annotations

from contextlib import contextmanager
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import docker_volume_held_ui_lifecycle as lifecycle
import docker_volume_held_ui_materialization as controller
from test_docker_volume_held_ui_materialization import (
    RUN_ID, canonical, encoded_record, valid_proof_chain,
)


class MemoryControl:
    def __init__(self, source_scope):
        self.project = source_scope["compose_project"]
        self.volume = source_scope["control_volume"]
        self.namespace = source_scope["namespace"]
        self.namespace_registry_sha256 = source_scope["namespace_registry_sha256"]
        self.records = {}
        self._active_operation = None
        self._attempt = 0

    def read_bytes(self, path, *, optional=False, maximum=None):
        value = self.records.get(path)
        if value is None and not optional:
            raise AssertionError("missing test control record: " + path)
        if value is not None and maximum is not None and len(value) > maximum:
            raise AssertionError("oversized test control record: " + path)
        return value

    def write_bytes(self, path, data):
        if path in self.records:
            raise AssertionError("attempted to overwrite immutable record: " + path)
        self.records[path] = bytes(data)

    def helper_args(self, _command):
        return ("test-claim-writer",)

    @staticmethod
    def path(relative):
        return "/control/" + relative

    @contextmanager
    def operation(self, phase, inputs):
        if self._active_operation is not None:
            raise RuntimeError("test control operation already active")
        self._attempt += 1
        attempt = ("d" if self._attempt == 1 else "e") * 32
        receipt = {
            "schema": "fullmag.docker-build-operation.v1", "phase": phase,
            "state": "starting", "attempt": attempt,
            "compose_project": self.project, "control_volume": self.volume,
            "control_namespace": self.namespace,
            "namespace_registry_sha256": self.namespace_registry_sha256,
            "inputs": dict(inputs),
        }
        operation = {"receipt": receipt, "root": phase + "/attempts/" + attempt,
                     "lease_ready": True, "daemon_pending": False}
        self._active_operation = operation
        try:
            yield operation
        except BaseException:
            if not operation["daemon_pending"]:
                self._active_operation = None
            raise
        else:
            receipt["finished_at"] = 1
            receipt["filesystem_after"] = {"available_bytes": 1024}
            self.records[operation["root"] + "/terminal.json"] = encoded_record(receipt)
            self._active_operation = None


class ProductionHeldStop(unittest.TestCase):
    def test_produced_records_pass_production_stop_proof_validator(self):
        request_value, source_proofs = valid_proof_chain()
        accepted = request_value["accepted"]
        source_scope = request_value["source_scope"]
        preflight = source_proofs["preflight"]
        inventory = source_proofs["inventory"]
        plan, plan_sha = controller.build_preview_plan(
            attempt=request_value["plan"]["attempt"],
            maintenance_request_id=request_value["plan"]["maintenance_request_id"],
            source_scope=source_scope, accepted=accepted,
            preflight=preflight, inventory=inventory,
        )
        control = MemoryControl(source_scope)
        events = []
        active_services = {
            "backend": {"id": source_scope["backend_container_id"],
                        "image_id": "sha256:" + "5" * 64,
                        "started_at": source_scope["backend_started_at"],
                        "running": True, "exit_code": 0},
            "frontend": {"id": source_scope["frontend_container_id"],
                         "image_id": "sha256:" + "6" * 64,
                         "started_at": source_scope["frontend_started_at"],
                         "running": True, "exit_code": 0},
        }
        expected_services = {
            name: {key: service[key] for key in ("id", "image_id", "started_at")}
            for name, service in active_services.items()
        }

        def capture_fresh():
            return {
                "accepted": accepted, "preflight": preflight, "inventory": inventory,
                "source_scope": source_scope, "attempt": plan["attempt"],
                "maintenance_request_id": plan["maintenance_request_id"],
            }

        def inspect_services():
            return {key: dict(value) for key, value in active_services.items()}

        def stop_service(name, container_id):
            self.assertEqual(container_id, source_scope[name + "_container_id"])
            events.append(("stop", name))
            active_services[name]["running"] = False
            active_services[name]["exit_code"] = 0 if name == "frontend" else 1

        def preflight_drain(_service):
            events.append(("preflight-drain", None))

        native_drain = source_proofs["native_drain"]

        def read_drain(_service):
            events.append(("read-drain", None))
            return encoded_record(native_drain), native_drain

        def fake_docker_capture(*args, data=b"", **_kwargs):
            if args and args[0] == "test-claim-writer":
                path = "runtime-control/" + controller.quiescence_start_claim_relative(
                    plan["maintenance_request_id"],
                )
                control.write_bytes(path, data)
                return SimpleNamespace(returncode=0, stdout=b"CLAIMED\n", stderr=b"")
            if args[:2] == ("exec", "-i"):
                envelope = json.loads(data)
                intent = envelope["intent"]
                process = source_proofs["api_quiescence"]["retained_process"]
                process_sha = controller.sha(canonical(process) + b"\n")
                quiescence = {
                    "schema": "fullmag.native-terminal-api-quiescence.v1",
                    "intent_sha256": envelope["intent_sha256"],
                    "api_pin": intent["plan"]["native"]["api_pin"],
                    "api_closed": True, "signal": "SIGTERM",
                    "retained_process": process, "retained_process_sha256": process_sha,
                }
                fences = controller._expected_api_quiescence_fences(intent, process_sha)
                return SimpleNamespace(
                    returncode=0,
                    stdout=canonical({"receipt": quiescence, "fences": fences}),
                    stderr=b"",
                )
            raise AssertionError("unexpected daemon command in production proof test: " + repr(args))

        with patch("docker_build_control.docker_capture", side_effect=fake_docker_capture):
            result = lifecycle.execute_stop_only(
                control=control, controller=controller, plan=plan,
                expected_plan_sha256=plan_sha, expected_services=expected_services,
                capture_fresh=capture_fresh, inspect_services=inspect_services,
                stop_service=stop_service, preflight_drain=preflight_drain,
                read_drain=read_drain,
            )

        request_raw = control.read_bytes("runtime-control/" + controller.request_relative(
            plan["maintenance_request_id"],
        ))
        produced_request = controller.decode(request_raw, "produced request")
        self.assertEqual(result["state"], "stopped-awaiting-typed-recreate")
        proofs = controller.validate_stop_proofs(
            produced_request,
            lambda relative: control.read_bytes(
                ("" if relative.startswith("held-ui-materialization-stop/") else "runtime-control/")
                + relative,
                maximum=controller.MAX_PROOF_BYTES,
            ),
        )
        self.assertEqual(proofs["terminal"]["held_ui_stop_proofs"],
                         {key: produced_request["stop_authority"][key]
                          for key in ("preflight", "api_quiescence", "native_drain", "inventory")})
        self.assertEqual([event for event in events if event[0] == "stop"],
                         [("stop", "frontend"), ("stop", "backend")])
        self.assertEqual(sum(event[0] == "read-drain" for event in events), 1)
        self.assertEqual(produced_request["accepted"]["run_id"], RUN_ID)


if __name__ == "__main__":
    unittest.main()
