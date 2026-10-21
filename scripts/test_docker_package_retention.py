"""Interpreted regressions for the trusted Docker package-retention route."""

from __future__ import annotations

from contextlib import contextmanager
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import docker_build_control as build_control
import docker_package_retention as retention


def _report(inputs_sha256: str, *, state: str = "dry-run", plan_sha256: str = "a" * 64):
    return {
        "schema": retention.RETENTION_REPORT_SCHEMA,
        "state": state,
        "package_root": retention.PACKAGE_ROOT,
        "plan_sha256": plan_sha256,
        "operation_inputs_sha256": inputs_sha256,
        "group_plan_sha256": retention._group_plan_sha256(plan_sha256, inputs_sha256),
        "scope": "obsolete-backup-trees",
        "allocation": {
            "scope": "obsolete-backup-trees",
            "allocated_bytes_before": 4096,
            "targets": [{"name": ".backend-package-backup-old", "allocated_bytes": 4096}],
        },
        "scope_allocated_bytes_before": 4096,
        "scope_allocated_bytes_after": 0,
        "scope_allocated_bytes_delta": 4096,
        "filesystem_available_path": retention.PACKAGE_ROOT,
        "filesystem_available_bytes_before": 100000,
        "filesystem_available_bytes_after": 104096,
        "filesystem_available_bytes_delta": 4096,
        "filesystem_available_delta_is_observed_only": True,
    }


class _Control:
    def __init__(self, *, fail_on=None, reads=None):
        self.operation_inputs = None
        self.receipt = None
        self.writes = {}
        self.volume = "fullmag-control-test"
        self.project = "fullmag-test"
        self.fail_on = fail_on
        self.reads = dict(reads or {})

    @contextmanager
    def operation(self, phase, inputs, **_kwargs):
        self.operation_inputs = (phase, inputs)
        self.receipt = {"state": "starting"}
        operation = {"root": "package-retention/attempts/test", "receipt": self.receipt}
        yield operation

    def write(self, path, value):
        if self.fail_on is not None and path.endswith(self.fail_on):
            raise retention.BuildControlError("injected durable write failure")
        self.writes[path] = value

    def read(self, path, *, optional=False):
        if path in self.writes:
            return self.writes[path]
        if path in self.reads:
            return self.reads[path]
        if optional:
            return None
        raise retention.BuildControlError("unexpected control read")


class DockerPackageRetentionTests(unittest.TestCase):
    def test_report_validation_binds_schema_plan_root_and_group_inputs(self):
        inputs_sha256 = "b" * 64
        valid = _report(inputs_sha256)
        self.assertIs(
            retention._validate_report(valid, "dry-run", inputs_sha256),
            valid,
        )
        for field, value, message in (
            ("schema", "wrong", "schema"),
            ("package_root", "/host/storage", "package root"),
            ("plan_sha256", "c" * 64, "plan sha256"),
            ("group_plan_sha256", "c" * 64, "group plan"),
        ):
            invalid = dict(valid)
            invalid[field] = value
            with self.subTest(field=field), self.assertRaisesRegex(
                retention.BuildControlError, message
            ):
                retention._validate_report(invalid, "dry-run", inputs_sha256)

    def test_launcher_passes_group_input_digest_and_records_group_plan(self):
        inputs = {"schema": "fullmag.direct-compose.package-retention-inputs.v1", "source": {"commit": "a" * 40}}
        inputs_sha256 = retention._sha(inputs)
        report = _report(inputs_sha256)
        control = _Control()
        group = SimpleNamespace(control=control, document={"services": {"backend": {}, "frontend": {}}})
        command_seen = {}

        def capture(_group, _control, _operation, _inputs, command, **_kwargs):
            command_seen["argv"] = command
            return report

        args = SimpleNamespace(
            repo_root=Path("/repo"),
            source_root=Path("/repo"),
            apply=False,
            plan_sha256=None,
        )
        with patch.object(retention, "require_host"), \
                patch.object(retention, "_selected_group", return_value=group), \
                patch.object(retention, "_operation_inputs", return_value=inputs), \
                patch.object(retention, "_run_managed_retention_container", side_effect=capture):
            self.assertEqual(retention.run(args), 0)

        argv = list(command_seen["argv"])
        self.assertIn("--operation-input-sha256", argv)
        self.assertEqual(argv[argv.index("--operation-input-sha256") + 1], inputs_sha256)
        receipt = control.receipt
        self.assertEqual(receipt["operation_inputs_sha256"], inputs_sha256)
        self.assertEqual(receipt["backend_plan_sha256"], report["plan_sha256"])
        self.assertEqual(
            receipt["group_plan_sha256"],
            retention._group_plan_sha256(report["plan_sha256"], inputs_sha256),
        )

    def test_absence_probe_transport_failure_keeps_outcome_unknown(self):
        with patch.object(retention, "docker_capture", side_effect=FileNotFoundError("Docker unavailable")):
            with self.assertRaises(retention.ControlOutcomeUnknown):
                retention._retention_container_is_absent({"name": "fullmag-retention-owned"})

    def test_transport_unknown_keeps_named_container_and_operation_pending(self):
        inputs = {
            "schema": "fullmag.direct-compose.package-retention-inputs.v1",
            "images": {
                "backend": {"image_id": "sha256:" + "a" * 64},
                "backend_labels_sha256": "b" * 64,
            },
            "volumes": {"services": {"backend": []}},
            "network": {"name": "fullmag-test-net"},
        }
        group = SimpleNamespace(
            identity={"project_name": "fullmag-test", "worktree_id": "worktree-test"},
            document={
                "name": "fullmag-test",
                "services": {"backend": {"image": "sha256:" + "a" * 64, "labels": {}}}
            },
            control=SimpleNamespace(volume="fullmag-control-test"),
        )
        operation = {
            "root": "package-retention/attempts/" + "c" * 32,
            "receipt": {
                "phase": "package-retention",
                "attempt": "c" * 32,
                "state": "starting",
            },
        }
        control = _Control()
        with patch.object(
            retention,
            "compose_capture",
            side_effect=retention.ControlOutcomeUnknown("Docker transport disconnected"),
        ), patch.object(
            retention,
            "_inspect_retention_container",
            side_effect=retention.ControlOutcomeUnknown("container outcome unknown"),
        ), patch.object(
            retention,
            "_retention_container_is_absent",
            side_effect=retention.ControlOutcomeUnknown("container absence unknown"),
        ):
            with self.assertRaises(retention.ControlOutcomeUnknown):
                retention._run_managed_retention_container(
                    group,
                    control,
                    operation,
                    inputs,
                    ["retention", "--output", retention.PACKAGE_ROOT, "--build-root", "/build"],
                    expected_state="dry-run",
                    plan_sha256=None,
                    group_plan_sha256=None,
                )
        self.assertTrue(operation["daemon_pending"])
        self.assertEqual(
            operation["receipt"]["managed_container"]["name"],
            "fullmag-package-retention-fullmag-test-" + "c" * 32,
        )
        self.assertEqual(
            control.writes[operation["root"] + "/receipt.json"]["daemon_pending"],
            True,
        )

    def test_compose_failure_with_confirmed_absence_reconciles_without_claiming_no_effects(self):
        attempt = "a" * 32
        inputs = {
            "schema": "fullmag.direct-compose.package-retention-inputs.v1",
            "images": {
                "backend": {"image_id": "sha256:" + "a" * 64},
                "backend_labels_sha256": "b" * 64,
            },
            "volumes": {"services": {"backend": []}},
            "network": {"name": "fullmag-test-net"},
        }
        group = SimpleNamespace(
            identity={"project_name": "fullmag-test", "worktree_id": "worktree-test"},
            document={
                "name": "fullmag-test",
                "services": {"backend": {"image": "sha256:" + "a" * 64, "labels": {}}},
            },
            control=SimpleNamespace(volume="fullmag-control-test"),
        )
        operation = {
            "root": "package-retention/attempts/" + attempt,
            "receipt": {
                "phase": "package-retention",
                "attempt": attempt,
                "state": "starting",
            },
        }
        control = _Control()
        with patch.object(
            retention,
            "compose_capture",
            side_effect=retention.BuildControlError("compose exited 1 before container creation"),
        ), patch.object(
            retention,
            "_inspect_retention_container",
            side_effect=retention.ControlOutcomeUnknown("container is absent"),
        ), patch.object(retention, "_retention_container_is_absent", return_value=True):
            with self.assertRaises(retention.ControlOutcomeUnknown):
                retention._run_managed_retention_container(
                    group,
                    control,
                    operation,
                    inputs,
                    ["retention", "--output", retention.PACKAGE_ROOT, "--build-root", "/build"],
                    expected_state="dry-run",
                    plan_sha256=None,
                    group_plan_sha256=None,
                )
        self.assertTrue(operation["daemon_pending"])
        durable_receipt = control.writes[operation["root"] + "/receipt.json"]
        self.assertEqual(durable_receipt["managed_container_state"], "absent-after-launch-error")
        self.assertTrue(durable_receipt["effects_unknown"])
        control.reads[operation["root"] + "/receipt.json"] = durable_receipt
        control.reads[operation["root"] + "/report.json"] = None
        with patch.object(retention, "_retention_container_is_absent", return_value=True), patch.object(
            retention, "_wait_for_control_active_clear"
        ):
            self.assertEqual(
                retention._reconcile_active_operation(
                    control, attempt, SimpleNamespace()
                ),
                2,
            )
        final = control.writes[operation["root"] + "/terminal.json"]
        self.assertEqual(final["state"], "failed-confirmed")
        self.assertTrue(final["effects_unknown"])
        self.assertEqual(final["verification"], "NOT VERIFIED")

    def test_report_write_failure_cannot_publish_succeeded_receipt(self):
        inputs = {
            "schema": "fullmag.direct-compose.package-retention-inputs.v1",
            "source": {"commit": "a" * 40},
        }
        inputs_sha256 = retention._sha(inputs)
        report = _report(inputs_sha256)
        control = _Control(fail_on="/report.json")
        group = SimpleNamespace(
            control=control,
            document={"services": {"backend": {}, "frontend": {}}},
        )
        args = SimpleNamespace(
            repo_root=Path("/repo"),
            source_root=Path("/repo"),
            apply=False,
            plan_sha256=None,
            group_plan_sha256=None,
            reconcile_attempt=None,
        )
        with patch.object(retention, "require_host"), \
                patch.object(retention, "_selected_group", return_value=group), \
                patch.object(retention, "_operation_inputs", return_value=inputs), \
                patch.object(retention, "_run_managed_retention_container", return_value=report):
            with self.assertRaisesRegex(retention.BuildControlError, "durable write"):
                retention.run(args)
        self.assertNotEqual(control.receipt.get("state"), "succeeded")

    def test_report_write_failure_keeps_named_container_pending(self):
        inputs = {
            "schema": "fullmag.direct-compose.package-retention-inputs.v1",
            "source": {"commit": "a" * 40},
            "images": {
                "backend": {"image_id": "sha256:" + "a" * 64},
                "backend_labels_sha256": "b" * 64,
            },
            "volumes": {"services": {"backend": []}},
            "network": {"name": "fullmag-test-net"},
        }
        inputs_sha256 = retention._sha(inputs)
        report = _report(inputs_sha256)
        control = _Control(fail_on="/report.json")
        group = SimpleNamespace(
            identity={"project_name": "fullmag-test", "worktree_id": "worktree-test"},
            document={
                "name": "fullmag-test",
                "services": {"backend": {"image": "sha256:" + "a" * 64, "labels": {}}},
            },
            control=SimpleNamespace(volume="fullmag-control-test"),
        )
        operation = {"root": "package-retention/attempts/" + "c" * 32, "receipt": {"attempt": "c" * 32}}
        with patch.object(retention, "compose_capture", return_value=(
            json.dumps(report, sort_keys=True).encode("utf-8") + b"\n"
        )), patch.object(
            retention,
            "_inspect_retention_container",
            return_value={"State": {"Running": False, "ExitCode": 0}},
        ), patch.object(retention, "_remove_retention_container") as remove:
            with self.assertRaisesRegex(retention.BuildControlError, "durable write"):
                retention._run_managed_retention_container(
                    group,
                    control,
                    operation,
                    inputs,
                    ["retention", "--output", retention.PACKAGE_ROOT, "--build-root", "/build"],
                    expected_state="dry-run",
                    plan_sha256=None,
                    group_plan_sha256=None,
                )
        remove.assert_not_called()
        self.assertTrue(operation["daemon_pending"])
        self.assertTrue(
            control.writes[operation["root"] + "/receipt.json"]["daemon_pending"]
        )

    def test_successful_cleanup_keeps_durable_pending_until_shared_finalizer(self):
        inputs = {
            "schema": "fullmag.direct-compose.package-retention-inputs.v1",
            "source": {"commit": "a" * 40},
            "images": {
                "backend": {"image_id": "sha256:" + "a" * 64},
                "backend_labels_sha256": "b" * 64,
            },
            "volumes": {"services": {"backend": []}},
            "network": {"name": "fullmag-test-net"},
        }
        inputs_sha256 = retention._sha(inputs)
        report = _report(inputs_sha256)
        control = _Control()
        group = SimpleNamespace(
            identity={"project_name": "fullmag-test", "worktree_id": "worktree-test"},
            document={
                "name": "fullmag-test",
                "services": {"backend": {"image": "sha256:" + "a" * 64, "labels": {}}},
            },
            control=SimpleNamespace(volume="fullmag-control-test"),
        )
        operation = {"root": "package-retention/attempts/" + "b" * 32, "receipt": {"attempt": "b" * 32}}
        with patch.object(
            retention,
            "compose_capture",
            return_value=json.dumps(report, sort_keys=True).encode("utf-8") + b"\n",
        ), patch.object(
            retention,
            "_inspect_retention_container",
            return_value={"State": {"Running": False, "ExitCode": 0}},
        ), patch.object(retention, "_remove_retention_container"):
            self.assertEqual(
                retention._run_managed_retention_container(
                    group,
                    control,
                    operation,
                    inputs,
                    ["retention", "--output", retention.PACKAGE_ROOT, "--build-root", "/build"],
                    expected_state="dry-run",
                    plan_sha256=None,
                    group_plan_sha256=None,
                ),
                report,
            )
        self.assertTrue(operation["daemon_pending"])
        self.assertTrue(
            control.writes[operation["root"] + "/receipt.json"]["daemon_pending"]
        )

    def test_build_control_terminal_marker_is_last_and_current_failure_has_no_marker(self):
        root = "package-retention/attempts/" + "d" * 32
        receipt = {"state": "succeeded", "daemon_pending": True}

        writes = []

        class Writer:
            def write(self, path, _value):
                writes.append(path)

        build_control._publish_operation_records(
            Writer(), "package-retention", root, receipt
        )
        self.assertEqual(
            writes,
            [
                root + "/receipt.json",
                "package-retention/current.json",
                "package-retention/verified.json",
                root + "/terminal.json",
            ],
        )

        writes.clear()

        class FailingWriter(Writer):
            def write(self, path, value):
                super().write(path, value)
                if path == "package-retention/current.json":
                    raise build_control.BuildControlError("injected current write failure")

        with self.assertRaisesRegex(build_control.BuildControlError, "current write"):
            build_control._publish_operation_records(
                FailingWriter(), "package-retention", root, receipt
            )
        self.assertNotIn(root + "/terminal.json", writes)

    def test_reconcile_persists_recovered_report_before_removal(self):
        inputs_sha256 = "e" * 64
        attempt = "f" * 32
        root = "package-retention/attempts/" + attempt
        report = _report(inputs_sha256)
        contract = {
            "control_volume": "fullmag-control-test",
            "project": "fullmag-test",
            "service": "backend",
            "expected_state": "dry-run",
            "name": "fullmag-package-retention-fullmag-test-" + attempt,
            "operation_inputs_sha256": inputs_sha256,
            "plan_sha256": None,
            "group_plan_sha256": None,
        }
        receipt = {
            "phase": "package-retention",
            "attempt": attempt,
            "state": "outcome-unknown-resources-retained",
            "daemon_pending": True,
            "managed_container": contract,
        }
        control = _Control(
            reads={root + "/receipt.json": receipt, root + "/report.json": None}
        )
        events = []

        def write(path, value):
            events.append(path)
            control.writes[path] = value

        control.write = write
        with patch.object(
            retention,
            "_inspect_retention_container",
            return_value={"State": {"Running": False, "ExitCode": 0}},
        ), patch.object(
            retention,
            "_retention_container_logs",
            return_value=json.dumps(report, sort_keys=True).encode("utf-8") + b"\n",
        ), patch.object(retention, "_remove_retention_container") as remove, patch.object(
            retention, "_wait_for_control_active_clear"
        ):
            self.assertEqual(
                retention._reconcile_active_operation(
                    control, attempt, SimpleNamespace()
                ),
                0,
            )
        remove.assert_called_once_with(contract)
        self.assertLess(events.index(root + "/report.json"), events.index("package-retention/current.json"))
        self.assertEqual(events[-1], root + "/terminal.json")

    def test_reconcile_retries_authenticated_cleanup_for_durable_report(self):
        inputs_sha256 = "1" * 64
        attempt = "2" * 32
        root = "package-retention/attempts/" + attempt
        report = _report(inputs_sha256)
        contract = {
            "control_volume": "fullmag-control-test",
            "project": "fullmag-test",
            "service": "backend",
            "expected_state": "dry-run",
            "name": "fullmag-package-retention-fullmag-test-" + attempt,
            "operation_inputs_sha256": inputs_sha256,
            "plan_sha256": None,
            "group_plan_sha256": None,
        }
        receipt = {
            "phase": "package-retention",
            "attempt": attempt,
            "state": "outcome-unknown-resources-retained",
            "daemon_pending": True,
            "managed_container": contract,
        }
        control = _Control(
            reads={root + "/receipt.json": receipt, root + "/report.json": report}
        )
        present = SimpleNamespace(returncode=0, stdout=b"[]", stderr=b"")
        with patch.object(retention, "docker_capture", return_value=present), patch.object(
            retention,
            "_inspect_retention_container",
            return_value={"State": {"Running": False, "ExitCode": 0}},
        ), patch.object(retention, "_remove_retention_container") as remove, patch.object(
            retention, "_wait_for_control_active_clear"
        ):
            self.assertEqual(
                retention._reconcile_active_operation(
                    control, attempt, SimpleNamespace()
                ),
                0,
            )
        remove.assert_called_once_with(contract)
        self.assertEqual(
            control.writes[root + "/terminal.json"]["state"],
            "succeeded",
        )

    def test_final_publication_recovers_after_each_record_write_failure(self):
        inputs_sha256 = "3" * 64
        attempt = "4" * 32
        root = "package-retention/attempts/" + attempt
        report = _report(inputs_sha256)
        contract = {
            "control_volume": "fullmag-control-test",
            "project": "fullmag-test",
            "service": "backend",
            "expected_state": "dry-run",
            "name": "fullmag-package-retention-fullmag-test-" + attempt,
            "operation_inputs_sha256": inputs_sha256,
            "plan_sha256": report["plan_sha256"],
            "group_plan_sha256": report["group_plan_sha256"],
        }
        durable_receipt = {
            "phase": "package-retention",
            "attempt": attempt,
            "state": "succeeded",
            "daemon_pending": False,
            "managed_container_state": "removed",
            "managed_container": contract,
            "report_sha256": retention._sha(report),
            "operation_inputs_sha256": inputs_sha256,
            "backend_plan_sha256": report["plan_sha256"],
            "group_plan_sha256": report["group_plan_sha256"],
        }

        class FailOnceControl(_Control):
            def __init__(self, fail_path):
                super().__init__(
                    reads={
                        root + "/receipt.json": durable_receipt,
                        root + "/report.json": report,
                    }
                )
                self.fail_path = fail_path
                self.failed = False

            def write(self, path, value):
                if (
                    path == self.fail_path
                    and not self.failed
                    and path.endswith("/terminal.json")
                ):
                    self.failed = True
                    raise build_control.BuildControlError(
                        "injected publication write failure"
                    )
                super().write(path, value)
                if path == self.fail_path and not self.failed:
                    self.failed = True
                    raise build_control.BuildControlError(
                        "injected publication write failure"
                    )

        for fail_path in (
            root + "/receipt.json",
            "package-retention/current.json",
            "package-retention/verified.json",
            root + "/terminal.json",
        ):
            with self.subTest(fail_path=fail_path):
                control = FailOnceControl(fail_path)
                with patch.object(
                    retention, "_retention_container_is_absent", return_value=True
                ), patch.object(retention, "_wait_for_control_active_clear"), patch.object(
                    retention, "_remove_retention_container"
                ) as remove:
                    with self.assertRaisesRegex(
                        retention.BuildControlError, "publication write failure"
                    ):
                        retention._reconcile_active_operation(
                            control, attempt, SimpleNamespace()
                        )
                    self.assertNotIn(root + "/terminal.json", control.writes)
                    self.assertEqual(
                        retention._reconcile_active_operation(
                            control, attempt, SimpleNamespace()
                        ),
                        0,
                    )
                remove.assert_not_called()
                self.assertIn(root + "/terminal.json", control.writes)
                self.assertEqual(
                    control.writes[root + "/terminal.json"]["state"],
                    "succeeded",
                )

    def test_apply_rejects_a_group_plan_from_different_inputs_before_compose(self):
        inputs = {"schema": "fullmag.direct-compose.package-retention-inputs.v1"}
        control = _Control()
        group = SimpleNamespace(control=control, document={"services": {}})
        args = SimpleNamespace(
            repo_root=Path("/repo"),
            source_root=Path("/repo"),
            apply=True,
            plan_sha256="a" * 64,
            group_plan_sha256="b" * 64,
        )
        with patch.object(retention, "require_host"), \
                patch.object(retention, "_selected_group", return_value=group), \
                patch.object(retention, "_operation_inputs", return_value=inputs), \
                patch.object(retention, "compose_capture") as capture, \
                self.assertRaisesRegex(retention.BuildControlError, "group plan"):
            retention.run(args)
        capture.assert_not_called()

    def test_just_route_and_shell_adapter_are_present(self):
        root = Path(__file__).resolve().parents[1]
        justfile = (root / "justfile").read_text(encoding="utf-8")
        shell = (root / "scripts" / "just_storage_shell.sh").read_text(encoding="utf-8")
        self.assertIn(
            'docker-dev-package-retention source_root apply="false" plan_sha256="" group_plan_sha256=""',
            justfile,
        )
        self.assertIn("scripts/docker_package_retention.py", justfile)
        self.assertIn("scripts/docker_package_retention.py", shell)
        self.assertIn("--operation-input-sha256", str(Path(retention.__file__).read_text(encoding="utf-8")))


if __name__ == "__main__":
    unittest.main()
