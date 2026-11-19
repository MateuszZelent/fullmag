"""Pure ownerless-abort contracts; no Docker, signals, API or filesystem mutation."""
import ast
import base64
import copy
import unittest
import contextlib
import json
import io
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import docker_volume_empty_api_abort as subject
from docker_build_control import BuildControlError, canonical

IMAGE = "sha256:" + "a" * 64


def process():
    return {"schema": "fullmag.docker-process-tree.v1", "state": "failed_outcome_retained",
            "api_pid": 18897, "api_exit_code": -6, "api_diagnostic_only": False,
            "accepted_store": "/state/runs/docker-all/session-store", "bootstrap": {"schema": "fullmag.docker-accepted-store-bootstrap.v1",
                "store_root": "/state/runs/docker-all/session-store", "created": True,
                "binding": "0d68a6bc4fcfc7e892f948de50821e1de9d237596a74bda3d44a014010848dda"},
            "qualification": "NOT VERIFIED", "error": "API binding did not become ready: API loopback probe failed for test"}


def guest(stopped=False):
    value = process()
    if stopped:
        value.update(state="shutdown_unknown", shutdown_error=subject.SHUTDOWN_ERROR)
    raw = canonical(value) + b"\n"
    return {"schema": subject.PROBE_SCHEMA, "process_raw": base64.b64encode(raw).decode(), "process_sha256": subject.sha(raw),
        "runtime_services_entries": [], "store_runtime_services": {"state": "absent", "entries": []},
        "runs_entries": [], "activation_active": False,
        "config": {"schema_version": "runtime_service_config.v2", "target_id": "docker-all",
                   "store_root": "/state/runs/docker-all/session-store", "host_execution": {"ledger_root": "/host-ledger/ledger"}},
        "config_sha256": "b" * 64, "package_sha256": "c" * 64, "provenance_sha256": "d" * 64,
        "package": {"schema": "fullmag.direct-compose.backend-build-receipt.v1", "state": "succeeded", "source": {"commit": "commit"}},
        "provenance": {"schema": "fullmag.docker-all-image.v1", "state": "succeeded", "image_id": IMAGE, "build_receipt_sha256": "c" * 64},
        "released": {"schema": "fullmag.pre-ack-released-observation.v1", "active_count": 0, "leases": [], "reservations": []},
        "api_pid_absent": True, "api_port_closed": True,
        "process_pins": [{"role": "init", "pid": 1, "start_ticks": 100}, {"role": "supervisor", "pid": 4, "start_ticks": 101}]}


class Contracts(unittest.TestCase):
    def test_exact_abort_and_ownerless_shutdown_preserve_all_other_fields(self):
        subject.process_contract(process())
        subject.validate_guest(guest(), IMAGE)
        subject.validate_transition(guest(), guest(stopped=True), IMAGE)

    def test_owner_runtime_activation_or_drain_cannot_be_fabricated(self):
        for key in ("runtime_pid", "service_owner", "terminal_service_owner", "startup_activation", "accepted_reattach", "owner_pin"):
            for value in (None, {}, {"state": "failed"}):
                altered = process()
                altered[key] = value
                with self.subTest(key=key, value=value), self.assertRaises(BuildControlError):
                    subject.process_contract(altered)
        for value in ("drained", "ready", "shutdown_unknown"):
            altered = process()
            altered["state"] = value
            with self.assertRaises(BuildControlError):
                subject.process_contract(altered)

    def test_process_exit_and_cause_are_exact(self):
        for key, value in (("api_exit_code", -15), ("api_exit_code", "-6"), ("api_pid", True),
                           ("api_diagnostic_only", True), ("error", "other failure"), ("bootstrap", {})):
            altered = process()
            altered[key] = value
            with self.subTest(key=key), self.assertRaises(BuildControlError):
                subject.process_contract(altered)

    def test_bootstrap_requires_exact_created_schema_and_canonical_binding(self):
        for key, value in (("schema", "other"), ("store_root", "/other"), ("binding", "f" * 64),
                           ("created", False), ("created", 1), ("created", "true")):
            altered = process()
            altered["bootstrap"][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(BuildControlError):
                subject.process_contract(altered)
        altered = process()
        altered["bootstrap"]["unexpected"] = True
        with self.assertRaises(BuildControlError):
            subject.process_contract(altered)

    def test_owner_runs_activation_native_or_open_api_refused(self):
        for key, value in (("runtime_services_entries", ["OWNER.json"]), ("runtime_services_entries", ["OWNER.lock"]),
                           ("store_runtime_services", {"state": "empty", "entries": ["OWNER.lock"]}),
                           ("store_runtime_services", {}), ("runs_entries", ["run-user"]), ("activation_active", True), ("api_pid_absent", False),
                           ("api_port_closed", False), ("process_pins", [{"role": "native", "pid": 12, "start_ticks": 1}])):
            altered = guest()
            altered[key] = value
            with self.subTest(key=key), self.assertRaises(BuildControlError):
                subject.validate_guest(altered, IMAGE)

    def test_lease_or_reservation_unknown_refused(self):
        for mutate in (lambda x: x["released"].update(active_count=1),
                       lambda x: x["released"].update(active_count=False),
                       lambda x: x["released"].update(leases=[["active", "sha"]]),
                       lambda x: x["released"].pop("reservations"),
                       lambda x: x["released"].update(reservations=[{"state": "committed"}])):
            altered = guest()
            mutate(altered)
            with self.assertRaises(BuildControlError):
                subject.validate_guest(altered, IMAGE)

    def test_package_provenance_and_config_tamper_refused(self):
        for mutate in (lambda x: x["provenance"].update(build_receipt_sha256="e" * 64),
                       lambda x: x["provenance"].update(image_id="sha256:" + "f" * 64),
                       lambda x: x["package"].update(state="failed"),
                       lambda x: x["config"]["host_execution"].update(ledger_root="/other"),
                       lambda x: x.update(process_sha256="f" * 64)):
            altered = guest()
            mutate(altered)
            with self.assertRaises(BuildControlError):
                subject.validate_guest(altered, IMAGE)

    def test_shutdown_unknown_does_not_allow_changed_namespace_or_error(self):
        altered = guest(stopped=True)
        altered["config_sha256"] = "f" * 64
        with self.assertRaises(BuildControlError):
            subject.validate_transition(guest(), altered, IMAGE)
        value = process()
        value.update(state="shutdown_unknown", shutdown_error="runtime service owner is not ready")
        with self.assertRaises(BuildControlError):
            subject.process_contract(value, stopped=True)

    def test_fixed_probe_contains_no_signals_or_lifecycle_calls(self):
        ast.parse(subject.PROBE)
        for forbidden in ("os.kill(", "pidfd_send_signal", "SIGTERM", "service-recover", "service-drain", "unlink(", "mkdir("):
            self.assertNotIn(forbidden, subject.PROBE)


class Control:
    project = "group"
    volume = "control-group"
    namespace = ""
    namespace_registry_sha256 = None
    image = IMAGE
    identity = {"project_name": "group"}

    def __init__(self):
        self.records = {}
        self.last_operation = None

    def read_bytes(self, path, *, optional=False, maximum=subject.MAXIMUM):
        if optional:
            return self.records.get(path)
        return self.records[path]

    def prepare(self):
        pass

    def write(self, path, value):
        self.records[path] = canonical(value) + b"\n"

    @contextlib.contextmanager
    def operation(self, phase, inputs):
        receipt = {"schema": "fullmag.docker-build-operation.v1", "phase": phase, "attempt": "e" * 32,
                   "compose_project": self.project, "control_volume": self.volume, "inputs": inputs}
        root = phase + "/attempts/" + receipt["attempt"]
        operation = {"root": root, "receipt": receipt, "helper_container_id": "f" * 64, "daemon_pending": False}
        self.last_operation = operation
        try:
            yield operation
        except Exception:
            receipt["state"] = "failed-confirmed" if not operation["daemon_pending"] else "outcome-unknown-resources-retained"
            raise
        finally:
            self.write(root + "/terminal.json", receipt)
            self.write(root + "/receipt.json", receipt)


def services(stopped=False):
    return {role: {"Id": value * 64, "Image": IMAGE, "Config": {"Labels": {}}, "HostConfig": {}, "Mounts": [],
                   "State": {"StartedAt": role + "-start", "Running": not stopped, "OOMKilled": False,
                             "Pid": 0 if stopped else 100, "ExitCode": (1 if role == "backend" else 0) if stopped else 0}}
            for role, value in (("backend", "1"), ("frontend", "2"))}


class Lifecycle(unittest.TestCase):
    def setUp(self):
        self.control = Control()
        self.args = SimpleNamespace(repo_root=Path("/tmp"), source_root=Path("/source"), attempt="a" * 32,
            config_sha256="b" * 64, port=3242, apply=True, preview=False, expected_plan_sha256="c" * 64)
        self.plan = {"schema": subject.SCHEMA, "plan_sha256": "c" * 64, "image_id": IMAGE,
                     "services": {role: subject.service_pin(row) for role, row in services().items()}, "guest": guest()}
        self.commands = []

    def run_stop(self, *, plan_drift=False, wrong_exit=False):
        def docker(*args, **kwargs):
            self.commands.append(args)
            if args[:2] == ("volume", "inspect"):
                return SimpleNamespace(returncode=0, stdout=b"[]")
            if args[0] == "stop":
                self.assertEqual(args, ("stop", "--time", "60", "1" * 64, "2" * 64))
                return SimpleNamespace(returncode=0, stdout=b"")
            if args[0] == "inspect":
                rows = services(stopped=True)
                if wrong_exit:
                    rows["backend"]["State"]["ExitCode"] = 0
                return SimpleNamespace(stdout=json.dumps(list(rows.values())).encode())
            raise AssertionError(args)
        plans = [(self.plan, services(), {})]
        if plan_drift:
            plans.append(({**self.plan, "plan_sha256": "d" * 64}, services(), {}))
        else:
            plans.append(plans[0])
        with contextlib.ExitStack() as stack:
            for patch in (
                mock.patch("docker_dev_host.require_host"),
                mock.patch("docker_dev._select_source", return_value=(Path("/source"), {})),
                mock.patch("docker_dev._compose_identity", return_value={"project_name": "group"}),
                mock.patch("docker_build_control.toolchain_configuration", return_value={"services": {
                    "fem-gpu-toolchain": {"build": {"args": {"FULLMAG_CUDA_BASE_IMAGE": IMAGE}}}}}),
                mock.patch("docker_build_control.BuildControl", return_value=self.control),
                mock.patch("docker_build_control.docker_capture", side_effect=docker),
                mock.patch.object(subject, "_plan", side_effect=plans),
                mock.patch.object(subject, "_probe", return_value=guest(stopped=True)),
                mock.patch("docker_volume_stop_unadmitted._preflight_terminal_process_receipt"),
            ):
                stack.enter_context(patch)
            return subject.stop(self.args)

    def test_preview_does_not_stop_or_claim_drained(self):
        self.args.apply, self.args.preview, self.args.expected_plan_sha256 = False, True, None
        result = self.run_stop()
        self.assertFalse(result["stop_applied"])
        self.assertEqual(result["process_outcome"], "failed_outcome_retained")
        self.assertFalse(any(command[0] == "stop" for command in self.commands))

    def test_apply_stops_only_pinned_pair_and_preserves_shutdown_unknown(self):
        result = self.run_stop()
        self.assertTrue(result["stop_applied"])
        self.assertEqual(result["process_outcome"], "shutdown_unknown")
        self.assertEqual(result["native_owner"], "absent")
        receipt = self.control.last_operation["receipt"]
        self.assertTrue(receipt["empty_api_abort_stopped"])
        self.assertEqual(receipt["state"], "succeeded")
        self.assertFalse(self.control.last_operation["daemon_pending"])

    def test_wrong_plan_or_changed_last_pins_refuse_before_stop(self):
        self.args.expected_plan_sha256 = "9" * 64
        with self.assertRaises(BuildControlError):
            self.run_stop()
        self.assertFalse(any(command[0] == "stop" for command in self.commands))
        self.commands = []
        self.args.expected_plan_sha256 = self.plan["plan_sha256"]
        with self.assertRaises(BuildControlError):
            self.run_stop(plan_drift=True)
        self.assertFalse(any(command[0] == "stop" for command in self.commands))

    def test_wrong_ownerless_exit_keeps_unknown_operation_after_stop(self):
        with self.assertRaises(BuildControlError):
            self.run_stop(wrong_exit=True)
        self.assertTrue(self.control.last_operation["daemon_pending"])
        self.assertEqual(self.control.last_operation["receipt"]["state"], "outcome-unknown-resources-retained")

    def test_actual_new_phase_consumer_check_refuses_foreign_consumer(self):
        helper = "f" * 64
        operation = {"receipt": {"phase": subject.PHASE, "attempt": "e" * 32}, "helper_container_id": helper}
        self.control.records["active"] = ("e" * 32 + "\n").encode()
        self.control._assert_live_operation_helper = lambda _: helper
        self.control._inspect_operation_helper = lambda _: helper
        ids = {name: row["Id"] for name, row in services().items()}
        expected = set(ids.values()) | {helper}
        with mock.patch("docker_volume_unclaimed_cancellation._project_container_ids", return_value=expected), \
             mock.patch("docker_volume_unclaimed_cancellation._volume_consumer_ids", return_value=expected):
            subject._assert_consumers(self.control, operation, ids)
        with mock.patch("docker_volume_unclaimed_cancellation._project_container_ids", return_value=expected | {"9" * 64}), \
             mock.patch("docker_volume_unclaimed_cancellation._volume_consumer_ids", return_value=expected):
            with self.assertRaises(BuildControlError):
                subject._assert_consumers(self.control, operation, ids)

    def test_foreign_active_marker_refuses_even_with_exact_consumers(self):
        helper = "f" * 64
        operation = {"receipt": {"phase": subject.PHASE, "attempt": "e" * 32}, "helper_container_id": helper}
        self.control._assert_live_operation_helper = lambda _: helper
        self.control._inspect_operation_helper = lambda _: helper
        self.control.records["active"] = ("9" * 32 + "\n").encode()
        with self.assertRaises(BuildControlError):
            subject._assert_consumers(self.control, operation, {name: row["Id"] for name, row in services().items()})


class FreshProof(unittest.TestCase):
    def setUp(self):
        self.control = Control()
        self.selected = Path("/source")
        self.args = SimpleNamespace(attempt="a" * 32, config_sha256="", port=3242)
        self.actual = services(stopped=True)
        self.document = {"name": "group", "services": {"backend": {"environment": {"FULLMAG_STARTUP_ENABLED": "0"}},
            "frontend": {"ports": [{"host_ip": "127.0.0.1", "target": 8080, "protocol": "tcp", "mode": "ingress", "published": "3242"}]}}}
        self.args.config_sha256 = subject.sha(canonical(self.document))
        self.previous = {"schema": "fullmag.docker-build-operation.v1", "phase": "development", "state": "failed-confirmed",
            "attempt": self.args.attempt, "compose_project": "group", "control_volume": self.control.volume,
            "inputs": {"source_root": str(self.selected), "image_id": IMAGE}, "config_sha256": self.args.config_sha256,
            **{name + "_started_at": row["State"]["StartedAt"] for name, row in self.actual.items()}}
        root = "development/attempts/" + self.args.attempt
        for path in (root + "/terminal.json", root + "/receipt.json", "development/current.json"):
            self.control.write(path, self.previous)
        self.control.write(root + "/compose.json", self.document)
        self.control.records[root + "/process-failure.json"] = base64.b64decode(guest()["process_raw"])
        _, _, records = subject._development(self.control, self.args, self.selected)
        body = {"schema": subject.SCHEMA, "scope": subject._scope(self.control, self.args, self.selected), **records,
                "services": {role: subject.service_pin(row) for role, row in self.actual.items()}, "guest": guest(), "image_id": IMAGE}
        self.plan = {**body, "plan_sha256": subject.sha(canonical(body))}
        self.token = "e" * 32
        self.root = subject.PHASE + "/attempts/" + self.token + "/"
        self.control.write(self.root + "plan.json", self.plan)
        self.control.write(self.root + "after.json", guest(stopped=True))
        self.control.write(self.root + "stopped-services.json", self.actual)
        terminal = {"schema": "fullmag.docker-build-operation.v1", "phase": subject.PHASE, "state": "succeeded",
            "attempt": self.token, "compose_project": "group", "control_volume": self.control.volume,
            "inputs": {"source_root": str(self.selected), "attempt": self.args.attempt, "config_sha256": self.args.config_sha256,
                       "empty_api_abort": True, "preview_only": False}, "config_sha256": self.args.config_sha256,
            "empty_api_abort_stopped": True, "stop_applied": True, "owner_state": "absent", "process_outcome": "shutdown_unknown",
            "plan_sha256": self.plan["plan_sha256"], "after_sha256": subject.sha(self.control.records[self.root + "after.json"]),
            "stopped_services_sha256": subject.sha(self.control.records[self.root + "stopped-services.json"])}
        self.control.write(self.root + "terminal.json", terminal)
        self.control.write(self.root + "receipt.json", terminal)
        self.pin = (self.token, subject.sha(self.control.records[self.root + "terminal.json"]))

    def validate(self):
        with mock.patch.object(subject, "_probe", return_value=guest(stopped=True)):
            return subject.validate_fresh(self.control, self.args, self.selected, self.actual, self.pin)

    def test_fresh_archive_requires_exact_raw_stop_cas_and_preserves_unknown(self):
        self.assertEqual(self.validate()["process_outcome"], "shutdown_unknown")
        self.pin = (self.token, "9" * 64)
        with self.assertRaises(BuildControlError):
            self.validate()

    def test_foreign_cid_config_namespace_and_proof_tamper_refused(self):
        self.actual["backend"]["Id"] = "9" * 64
        with self.assertRaises(BuildControlError):
            self.validate()
        self.actual = services(stopped=True)
        self.args.config_sha256 = "9" * 64
        with self.assertRaises(BuildControlError):
            self.validate()
        self.args.config_sha256 = subject.sha(canonical(self.document))
        self.control.namespace = "other"
        with self.assertRaises(BuildControlError):
            self.validate()
        self.control.namespace = ""
        self.control.records[self.root + "after.json"] += b" "
        with self.assertRaises(BuildControlError):
            self.validate()

    def test_current_owner_or_nonempty_namespace_refuses_fresh(self):
        with mock.patch.object(subject, "_probe", side_effect=BuildControlError("OWNER exists")):
            with self.assertRaises(BuildControlError):
                subject.validate_fresh(self.control, self.args, self.selected, self.actual, self.pin)

    def test_development_with_script_or_startup_receipt_is_refused(self):
        root = "development/attempts/" + self.args.attempt
        for mutate in (lambda x: x["inputs"].update(script="user.py"), lambda x: x.update(startup={"state": "pending"})):
            original = copy.deepcopy(self.previous)
            mutate(self.previous)
            for path in (root + "/terminal.json", root + "/receipt.json", "development/current.json"):
                self.control.write(path, self.previous)
            with self.assertRaises(BuildControlError):
                subject._development(self.control, self.args, self.selected)
            self.previous = original

    def test_pin_is_fresh_only_and_normal_mode_is_unchanged(self):
        plain = SimpleNamespace()
        self.assertIsNone(subject.fresh_pin(plain, recreate_services=True))
        args = SimpleNamespace(empty_api_abort_stop=self.token, empty_api_abort_stop_sha256=self.pin[1], fresh_state=True)
        self.assertEqual(subject.fresh_pin(args, recreate_services=True), self.pin)
        for kwargs in ({"restart_idle_service": True}, {"stop_after_drain": True}, {"retire_only": True}):
            with self.assertRaises(BuildControlError):
                subject.fresh_pin(args, recreate_services=True, **kwargs)
        args.fresh_state = False
        with self.assertRaises(BuildControlError):
            subject.fresh_pin(args, recreate_services=True)


class CommandLine(unittest.TestCase):
    def test_cli_exposes_only_explicit_preview_apply_and_paired_fresh_pins(self):
        import docker_dev
        parser = docker_dev._parser()
        common = ["--attempt", "a" * 32, "--config-sha256", "b" * 64,
                  "--source-root", "/source", "--port", "3242"]
        preview = parser.parse_args(["stop-empty-api-abort-volume", *common, "--preview"])
        self.assertTrue(preview.preview)
        self.assertFalse(preview.apply)
        apply = parser.parse_args(["stop-empty-api-abort-volume", *common, "--apply", "--expected-plan-sha256", "c" * 64])
        self.assertTrue(apply.apply)
        self.assertEqual(apply.expected_plan_sha256, "c" * 64)
        fresh = parser.parse_args(["recreate-volume", *common, "--fresh-state", "--empty-api-abort-stop", "e" * 32,
                                   "--empty-api-abort-stop-sha256", "f" * 64])
        self.assertEqual(subject.fresh_pin(fresh, recreate_services=True), ("e" * 32, "f" * 64))

    def test_dispatcher_prints_preview_plan_and_stop_receipt_sha(self):
        import docker_dev
        result = {"state": "preview-passed", "plan_sha256": "c" * 64,
                  "stop_attempt": "e" * 32, "stop_terminal_sha256": "f" * 64, "stop_applied": False}
        output = io.StringIO()
        with mock.patch.object(subject, "stop", return_value=result) as stop, contextlib.redirect_stdout(output):
            status = docker_dev.main(["stop-empty-api-abort-volume", "--attempt", "a" * 32,
                "--config-sha256", "b" * 64, "--source-root", "/source", "--port", "3242", "--preview"])
        self.assertEqual(status, 0)
        self.assertEqual(json.loads(output.getvalue()), result)
        self.assertTrue(stop.call_args.args[0].preview)

    def test_fresh_rejects_unpaired_and_mixed_authorities(self):
        for attrs in ({"empty_api_abort_stop": "e" * 32}, {"empty_api_abort_stop_sha256": "f" * 64}):
            with self.assertRaises(BuildControlError):
                subject.fresh_pin(SimpleNamespace(fresh_state=True, **attrs), recreate_services=True)
        for flag in ("native_terminal_stop", "terminal_observation_stop", "recovery_authorization",
                     "script", "completed_recreation_attempt", "pending_activation", "quiesce_api", "capture_native_terminal"):
            args = SimpleNamespace(fresh_state=True, empty_api_abort_stop="e" * 32, empty_api_abort_stop_sha256="f" * 64)
            setattr(args, flag, True)
            with self.subTest(flag=flag), self.assertRaises(BuildControlError):
                subject.fresh_pin(args, recreate_services=True)


if __name__ == "__main__":
    unittest.main()
