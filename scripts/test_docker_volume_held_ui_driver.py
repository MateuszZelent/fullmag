"""Mock-only held UI apply routing tests; no Docker/runtime actions are issued."""
from __future__ import annotations

import ast
import inspect
import unittest
import hashlib
import json
import uuid
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import ANY, patch

import docker_volume_dev as subject
import docker_volume_held_ui_materialization as held_controller


PLAN_SHA = "a" * 64
REQUEST_SHA = "b" * 64
REQUEST_ID = "c2119b25-9cf7-4bfa-a87c-cecfdc706ede"
RUN_ID = "run-live-6b6552a649f3cd4a87309ab4b48a1f0c83c0a884636a180dea580f83e0bf8cd0"
ATTEMPT = "d" * 32
RECREATE_ATTEMPT = "e" * 32
PREVIOUS_RAW = b"old-development-terminal"


class FakeControl:
    def __init__(self):
        self.values = {
            "development/current.json": PREVIOUS_RAW,
            "development/verified.json": PREVIOUS_RAW,
        }

    def read_bytes(self, relative, optional=False):
        value = self.values.get(relative)
        if value is None and not optional:
            raise AssertionError("unexpected missing control record: " + relative)
        return value


class FakeHost:
    HOST_SCHEMA = "fullmag.linux-native-host.v1"
    OWNER_NAME = ".fullmag-linux-native-owner.json"
    HOST_CERT_PATH = "/run/fullmag/linux-native-host.json"

    @staticmethod
    def read_owned_regular(path):
        return Path(path).read_bytes()

    @staticmethod
    def local_volume(_state):
        return {"device_identity": "pinned-test-device"}


class HeldUiCertificatePins(unittest.TestCase):
    @staticmethod
    def write_evidence(path, value):
        Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")

    def test_precompose_rechecks_owner_certificate_written_by_normal_start(self):
        with TemporaryDirectory() as temporary:
            state = Path(temporary).resolve()
            host = FakeHost()
            certificate = {
                "schema": host.HOST_SCHEMA, "storage_profile": "linux-native-v1",
                "role": "session", "owner_token": "a" * 32,
                "image_id": "sha256:" + "b" * 64,
                "restart_verified": False, "host_inode": state.stat().st_ino,
                "device_identity": "pinned-test-device",
            }
            cert_path = state / "linux-native-host.json"
            owner_path = state / host.OWNER_NAME
            self.write_evidence(cert_path, certificate)
            self.write_evidence(owner_path, certificate)
            control = SimpleNamespace(write=lambda _path, _value: None)
            operation = {"root": "development/attempts/" + ATTEMPT, "receipt": {}}

            pin = subject._record_held_ui_rotated_certificate(
                host, state, cert_path, certificate, control, operation,
            )
            self.assertEqual(pin["certificate_sha256"], hashlib.sha256(cert_path.read_bytes()).hexdigest())
            with patch.object(subject, "_session_host", return_value=host):
                observed = subject._validate_held_ui_successor_certificate(
                    {"state": state}, operation,
                )
            self.assertEqual(observed, certificate)

            changed = dict(certificate, device_identity="foreign-device")
            self.write_evidence(cert_path, changed)
            self.write_evidence(owner_path, changed)
            with patch.object(subject, "_session_host", return_value=host):
                with self.assertRaisesRegex(subject.BuildControlError, "changed before Compose"):
                    subject._validate_held_ui_successor_certificate({"state": state}, operation)

    def test_final_success_certificate_must_descend_from_pinned_owner(self):
        with TemporaryDirectory() as temporary:
            state = Path(temporary).resolve()
            host = FakeHost()
            certificate = {
                "schema": host.HOST_SCHEMA, "storage_profile": "linux-native-v1",
                "role": "session", "owner_token": "a" * 32,
                "image_id": "sha256:" + "b" * 64,
                "restart_verified": False, "host_inode": state.stat().st_ino,
                "device_identity": "pinned-test-device",
            }
            cert_path = state / "linux-native-host.json"
            owner_path = state / host.OWNER_NAME
            self.write_evidence(cert_path, certificate)
            self.write_evidence(owner_path, certificate)
            control = SimpleNamespace(write=lambda _path, _value: None)
            operation = {"root": "development/attempts/" + ATTEMPT, "receipt": {}}
            subject._record_held_ui_rotated_certificate(
                host, state, cert_path, certificate, control, operation,
            )
            verified = dict(certificate, restart_verified=True)
            self.write_evidence(cert_path, verified)
            self.write_evidence(owner_path, verified)
            with patch.object(subject, "_session_host", return_value=host):
                final = subject._record_held_ui_final_certificate(
                    host, state, cert_path, verified, control, operation,
                )
            self.assertIs(final["restart_verified"], True)
            self.assertEqual(final["owner_token"], operation["receipt"][
                "held_ui_successor_certificate_pin"]["owner_token"])
            self.assertEqual(final["certificate_sha256"], hashlib.sha256(cert_path.read_bytes()).hexdigest())


class HeldUiSuccessorReadback(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        state = Path(self.temporary.name).resolve()
        control = FakeControl()
        control.project = "fullmag-interactive-study"
        control.volume = "fullmag-control"
        control.namespace = ""
        control.namespace_registry_sha256 = None
        source = {
            "source_root": "/workspace/fullmag",
            "backend_container_id": "1" * 64,
            "frontend_container_id": "2" * 64,
        }
        accepted = {"run_id": RUN_ID, "command_id": "fm-5886f18f-96bd-481b-a064-726f49b22d07",
                    "old_api_instance_id": "75c6d4d1-00a9-416d-b27e-6fda461ad85d"}
        previous_document = {
            "name": control.project,
            "services": {
                "backend": {"environment": {"FULLMAG_DOCKER_DEVICE_ACCESS": "cpu"}, "gpus": False,
                            "networks": ["fullmag"]},
                "frontend": {"environment": {}, "networks": ["fullmag"], "volumes": []},
            },
        }
        current_document = {
            "name": control.project,
            "services": {
                "backend": {"environment": {
                    "FULLMAG_STATE_ROOT": str(state),
                    held_controller.REQUEST_ENV: "held-ui-materialization/" + REQUEST_ID + "/request.json",
                    held_controller.REQUEST_DIGEST_ENV: REQUEST_SHA,
                    "FULLMAG_DOCKER_DEVICE_ACCESS": "cpu",
                }, "gpus": False, "networks": ["fullmag"]},
                "frontend": {"environment": {}, "networks": ["fullmag"], "volumes": []},
            },
        }
        previous = {
            "attempt": ATTEMPT, "state_root": str(state),
            "inputs": {"source_root": source["source_root"], "source_project_id": "project-id",
                       "source_worktree_id": "worktree-id", "source_checkout_kind": "worktree",
                       "gpu_access_requested": "auto", "device_access": "cpu",
                       "gpu_preflight": "NOT_REQUIRED"},
            "backend_volumes": ["retained-backend-volume"],
            "frontend_volume": "retained-frontend-volume",
            "private_group_storage": None,
        }
        previous_raw = held_controller.canonical(previous) + b"\n"
        previous_document_raw = held_controller.canonical(previous_document) + b"\n"
        context = {
            "control": control, "controller": held_controller,
            "state": state, "identity": {"project_id": "project-id", "worktree_id": "worktree-id",
                                          "checkout_kind": "worktree"},
            "request": {"plan": {"maintenance_request_id": REQUEST_ID, "plan_sha256": PLAN_SHA},
                        "source_scope": source, "accepted": accepted},
            "request_path": "held-ui-materialization/" + REQUEST_ID + "/request.json",
            "request_sha256": REQUEST_SHA, "recreate_input": {
                "schema": "fullmag.held-ui-materialization-recreate-input.v1",
                "request_path": "held-ui-materialization/" + REQUEST_ID + "/request.json",
                "request_sha256": REQUEST_SHA, "maintenance_request_id": REQUEST_ID,
                "plan_sha256": PLAN_SHA, "stop_attempt": "c" * 32,
                "stop_terminal_sha256": "f" * 64, "source_scope": source,
                "run_id": RUN_ID, "command_id": accepted["command_id"],
            },
            "claim": {"recreate_attempt": RECREATE_ATTEMPT}, "claim_sha256": "e" * 64,
            "previous": previous, "previous_raw": previous_raw,
            "document": previous_document, "document_raw": previous_document_raw,
            "proofs": {
                "preflight": {"accepted_store_binding": "a" * 64},
                "api_quiescence": {"retained_process": {
                    "accepted_store": "/state/runs/docker-all/session-store"}},
            },
        }
        current_inputs = {
            **previous["inputs"], "image_id": "sha256:" + "b" * 64,
            "held_ui_materialization": subject._held_ui_start_input(context),
            "completed_recreation": {"attempt": RECREATE_ATTEMPT,
                                      "terminal_sha256": hashlib.sha256(b"recreate terminal").hexdigest()},
        }
        final_certificate = {
            "schema": FakeHost.HOST_SCHEMA, "storage_profile": "linux-native-v1",
            "role": "session", "owner_token": "a" * 32,
            "image_id": current_inputs["image_id"], "restart_verified": True,
            "host_inode": state.stat().st_ino, "device_identity": "pinned-test-device",
        }
        cert_path = state / "linux-native-host.json"
        owner_path = state / FakeHost.OWNER_NAME
        encoded_certificate = json.dumps(final_certificate, ensure_ascii=False, indent=2) + "\n"
        cert_path.write_text(encoded_certificate)
        owner_path.write_text(encoded_certificate)
        raw_certificate = cert_path.read_bytes()
        current = {
            "schema": "fullmag.docker-build-operation.v1", "phase": "development",
            "state": "succeeded", "attempt": "f" * 32,
            "compose_project": control.project, "control_volume": control.volume,
            "control_namespace": "", "namespace_registry_sha256": None,
            "state_root": str(state), "config_sha256": hashlib.sha256(
                held_controller.canonical(current_document)).hexdigest(),
            "inputs": current_inputs,
            "backend_container": "3" * 64, "frontend_container": "4" * 64,
            "backend_volumes": previous["backend_volumes"],
            "frontend_volume": previous["frontend_volume"],
            "private_group_storage": None,
            "held_ui_successor_certificate_pin": {
                "schema": "fullmag.held-ui-materialization-successor-certificate-pin.v1",
                "state_root": str(state), "certificate_sha256": "5" * 64,
                "owner_marker_sha256": "6" * 64, "storage_profile": "linux-native-v1",
                "owner_token": "a" * 32, "image_id": current_inputs["image_id"],
                "host_inode": state.stat().st_ino,
            },
            "held_ui_successor_certificate_final": {
                "schema": "fullmag.held-ui-materialization-final-certificate.v1",
                "state_root": str(state), "certificate_sha256": hashlib.sha256(raw_certificate).hexdigest(),
                "owner_marker_sha256": hashlib.sha256(raw_certificate).hexdigest(),
                "storage_profile": "linux-native-v1", "owner_token": "a" * 32,
                "image_id": current_inputs["image_id"], "host_inode": state.stat().st_ino,
                "restart_verified": True,
            },
        }
        current_raw = held_controller.canonical(current) + b"\n"
        control.values["development/attempts/" + current["attempt"] + "/compose.json"] = (
            held_controller.canonical(current_document) + b"\n"
        )
        self.context = context
        self.current = current
        self.current_raw = current_raw
        self.current_document = current_document
        self.process = {
            "accepted_store": "/state/runs/docker-all/session-store",
            "bootstrap": {"store_root": "/state/runs/docker-all/session-store",
                          "binding": "a" * 64},
        }
        self.runtime = {"api_instance_id": str(uuid.uuid4())}
        self.ack = {"accepted_store_binding": "a" * 64}

    def test_succeeded_readback_keeps_same_state_store_volumes_device_and_network(self):
        with patch.object(subject, "_held_ui_recreate_terminal",
                          return_value={"raw": b"recreate terminal"}), \
             patch.object(subject, "_session_host", return_value=FakeHost()):
            self.assertTrue(subject._held_ui_validate_successor_state(
                SimpleNamespace(request_id=REQUEST_ID), self.context,
                self.current_raw, self.current, self.process, self.runtime, self.ack,
            ))

    def test_successor_readback_rejects_changed_device_volume_and_certificate(self):
        mutations = (
            lambda value: value["inputs"].update(device_access="gpu"),
            lambda value: value.update(frontend_volume="foreign-volume"),
            lambda value: value["held_ui_successor_certificate_final"].update(owner_token="f" * 32),
        )
        for mutate in mutations:
            value = json.loads(json.dumps(self.current))
            mutate(value)
            with self.subTest(current=value), \
                 patch.object(subject, "_held_ui_recreate_terminal",
                              return_value={"raw": b"recreate terminal"}), \
                 patch.object(subject, "_session_host", return_value=FakeHost()), \
                 self.assertRaises(subject.BuildControlError):
                subject._held_ui_validate_successor_state(
                    SimpleNamespace(request_id=REQUEST_ID), self.context,
                    held_controller.canonical(value) + b"\n", value,
                    self.process, self.runtime, self.ack,
                )


class CompletedRecreationStartLease(unittest.TestCase):
    def setUp(self):
        self.control = FakeControl()
        self.operation = {
            "root": "development/attempts/" + ATTEMPT,
            "receipt": {"attempt": ATTEMPT},
        }
        self.control._active_operation = self.operation
        self.control.values["active"] = (ATTEMPT + "\n").encode()
        self.args = SimpleNamespace(completed_recreation_attempt=RECREATE_ATTEMPT)
        self.selected = Path("/workspace/fullmag")
        self.layout = {"runtime_root": "/runtime"}
        self.reuse_state = {"state": "/runtime/held", "owner_marker": "/runtime/held/.owner"}

    def validate(self, *, held=None, current=None):
        if current is None:
            current = {
                "reuse_state": self.reuse_state,
                "retained_device_access": "cpu",
            }
            if held is None:
                current.update(previous_config_sha256="a" * 64, native_restart_metadata=None)
        with patch.object(subject, "_completed_recreation_start_context",
                          return_value=current) as completed:
            subject._revalidate_completed_recreation_start_handoff(
                self.control, self.args, self.selected, self.layout, self.operation,
                reuse_state=self.reuse_state, retained_device_access="cpu",
                previous_config_sha256=(None if held is not None else "a" * 64),
                validated_startup_diagnostic_restart=None,
                validated_native_restart_metadata=None,
                validated_held_ui=held,
            )
        return completed

    def test_held_start_rechecks_dedicated_handoff_under_start_lease(self):
        held = {"request_sha256": REQUEST_SHA, "claim_sha256": "f" * 64}
        completed = self.validate(held=held)
        completed.assert_called_once_with(
            self.control, self.args, self.selected, self.layout, held_ui_context=held,
        )

    def test_held_start_rejects_changed_handoff_before_production_compose_callsite(self):
        held = {"request_sha256": REQUEST_SHA, "claim_sha256": "f" * 64}
        drifted = {
            "reuse_state": {"state": "/runtime/foreign"},
            "retained_device_access": "cpu",
        }
        compose = unittest.mock.Mock()
        with patch.object(subject, "_completed_recreation_start_context", return_value=drifted), \
             patch.object(subject, "_start_compose_services", compose), \
             self.assertRaisesRegex(subject.BuildControlError, "handoff changed"):
            subject._revalidate_completed_recreation_start_handoff(
                self.control, self.args, self.selected, self.layout, self.operation,
                reuse_state=self.reuse_state, retained_device_access="cpu",
                previous_config_sha256=None, validated_startup_diagnostic_restart=None,
                validated_native_restart_metadata=None, validated_held_ui=held,
            )
        compose.assert_not_called()

    def test_ordinary_completed_recreation_keeps_legacy_restart_comparison(self):
        completed = self.validate()
        completed.assert_called_once_with(self.control, self.args, self.selected, self.layout)

    def test_completed_handoff_requires_the_exact_active_development_lease(self):
        held = {"request_sha256": REQUEST_SHA, "claim_sha256": "f" * 64}
        self.control.values["active"] = ("0" * 32 + "\n").encode()
        with patch.object(subject, "_completed_recreation_start_context") as completed:
            with self.assertRaisesRegex(subject.BuildControlError, "active development lease"):
                subject._revalidate_completed_recreation_start_handoff(
                    self.control, self.args, self.selected, self.layout, self.operation,
                    reuse_state=self.reuse_state, retained_device_access="cpu",
                    previous_config_sha256=None, validated_startup_diagnostic_restart=None,
                    validated_native_restart_metadata=None, validated_held_ui=held,
                )
        completed.assert_not_called()

    def test_production_start_revalidates_handoff_before_compose(self):
        tree = ast.parse(inspect.getsource(subject.start))
        calls = {
            node.func.id if isinstance(node.func, ast.Name) else node.func.attr: node.lineno
            for node in ast.walk(tree) if isinstance(node, ast.Call)
        }
        self.assertLess(
            calls["_revalidate_completed_recreation_start_handoff"],
            calls["_start_compose_services"],
        )


def request_context(*, claimed=False):
    control = FakeControl()
    request = {
        "plan": {"maintenance_request_id": REQUEST_ID},
        "accepted": {"run_id": RUN_ID},
    }
    context = {
        "control": control,
        "controller": held_controller,
        "request": request,
        "request_path": "held-ui-materialization/" + REQUEST_ID + "/request.json",
        "request_sha256": REQUEST_SHA,
        "request_raw": b"immutable-request",
        "start_environment": {"request": "path"},
        "start_metadata": {"metadata": "pinned"},
        "recreate_input": {"recreate": "pinned"},
        "previous_raw": PREVIOUS_RAW,
        "selected": "/source",
        "layout": {"runtime_root": "/runtime"},
        "plan_sha256": PLAN_SHA,
    }
    if claimed:
        context.update(claim={"recreate_attempt": RECREATE_ATTEMPT}, claim_sha256="f" * 64)
    else:
        context.update(claim=None, claim_sha256=None)
    control.values["runtime-control/held-ui-materialization/" + REQUEST_ID + "/request.json"] = context[
        "request_raw"
    ]
    return context


def args():
    return SimpleNamespace(
        apply=True, preview=False, expected_plan_sha256=PLAN_SHA,
        request_id=REQUEST_ID, run_id=RUN_ID, attempt=ATTEMPT,
    )


class HeldUiPrivateApplyDriver(unittest.TestCase):
    def test_first_application_enters_retained_recreate_once_then_reads_exact_result(self):
        source = request_context()
        source["control"].values.pop(
            "runtime-control/held-ui-materialization/" + REQUEST_ID + "/request.json",
        )
        claimed = request_context(claimed=True)
        result = {"state": "restored", "run_id": RUN_ID, "command_id": "fm-command"}
        with patch.object(subject, "_held_ui_control_for_args", return_value=(
                 "/source", {"runtime_root": "/runtime"}, {}, source["control"])), \
             patch.object(subject, "_stop_held_ui_materialization", return_value={
                 "plan_sha256": PLAN_SHA, "request_path": source["request_path"],
                 "request_sha256": REQUEST_SHA}) as stop, \
             patch.object(subject, "_load_held_ui_request_context", return_value=source), \
             patch.object(subject, "_held_ui_context_with_recreate_claim",
                          side_effect=[source, claimed]), \
             patch.object(subject, "_validate_held_ui_materialization_context", return_value=source), \
             patch.object(subject, "_retained_operation", return_value=None) as recreate, \
             patch.object(subject, "_held_ui_readback_or_resume_start", return_value=result) as readback:
            actual = subject._apply_held_ui_materialization(args(), controller=source["controller"])

        self.assertEqual(actual, result)
        stop.assert_called_once()
        recreate.assert_called_once_with(
            ANY, recreate_services=True, held_ui_materialization=subject._held_ui_context_value(source),
        )
        readback.assert_called_once_with(ANY, claimed)

    def test_existing_unknown_claim_never_reenters_recreate_or_start(self):
        context = request_context(claimed=True)
        with patch.object(subject, "_held_ui_control_for_args", return_value=(
                 "/source", {"runtime_root": "/runtime"}, {}, context["control"])), \
             patch.object(subject, "_stop_held_ui_materialization", return_value={
                 "plan_sha256": PLAN_SHA, "request_path": context["request_path"],
                 "request_sha256": REQUEST_SHA}), \
             patch.object(subject, "_load_held_ui_request_context", return_value=context), \
             patch.object(subject, "_held_ui_context_with_recreate_claim", return_value=context), \
             patch.object(subject, "_held_ui_readback_or_resume_start",
                          side_effect=subject.BuildControlError("recreate outcome unknown")), \
             patch.object(subject, "_retained_operation") as recreate, \
             patch.object(subject, "start") as start:
            with self.assertRaisesRegex(subject.BuildControlError, "recreate outcome unknown"):
                subject._apply_held_ui_materialization(args(), controller=context["controller"])

        recreate.assert_not_called()
        start.assert_not_called()

    def test_completed_removal_resumes_only_start_and_never_removes_again(self):
        context = request_context(claimed=True)
        context["control"].values[
            "recreate-services/attempts/" + RECREATE_ATTEMPT + "/terminal.json"
        ] = b"completed-recreate-terminal"
        result = {"state": "restored", "run_id": RUN_ID}
        with patch.object(subject, "_held_ui_control_for_args", return_value=(
                 "/source", {"runtime_root": "/runtime"}, {}, context["control"])), \
             patch.object(subject, "_stop_held_ui_materialization", return_value={
                 "plan_sha256": PLAN_SHA, "request_path": context["request_path"],
                 "request_sha256": REQUEST_SHA}), \
             patch.object(subject, "_load_held_ui_request_context", return_value=context), \
             patch.object(subject, "_held_ui_context_with_recreate_claim", return_value=context), \
             patch.object(subject, "_held_ui_readback_or_resume_start", side_effect=[None, result]), \
             patch.object(subject, "_validate_held_ui_materialization_context", return_value=context), \
             patch.object(subject, "_completed_recreation_start_context", return_value={
                 "reuse_state": {"state": "/retained"},
             }) as completed, \
             patch.object(subject, "start") as start, \
             patch.object(subject, "_retained_operation") as recreate:
            actual = subject._apply_held_ui_materialization(args(), controller=context["controller"])

        self.assertEqual(actual, result)
        recreate.assert_not_called()
        start.assert_called_once()
        completed.assert_called_once()


if __name__ == "__main__":
    unittest.main()
