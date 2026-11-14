"""Read-only exact absence observations after qualified service removal."""

from contextlib import ExitStack
import copy
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

from scripts import docker_data_volume_removed_group as removed
from scripts import test_docker_data_volume_stopped_group as fixtures


class RemovedGroupObserverTests(unittest.TestCase):
    def setUp(self):
        self.case = fixtures.StoppedCopySourceTests()
        self.case.setUp()
        self.addCleanup(self.case.doCleanups)
        self.operation = self.case.operation
        self.helper_id = "c" * 64
        self.fence_id = "d" * 64
        self.case.control._assert_live_operation_helper.return_value = self.helper_id
        self.helper = {
            "Id": self.helper_id,
            "Config": {"Labels": {"com.docker.compose.project": self.case.control.project}},
            "Mounts": [],
            "State": {"Status": "running", "Running": True, "Pid": 321},
        }
        self.fence_container = {
            "Id": self.fence_id,
            "Config": {"Labels": {"com.docker.compose.project": "foreign"}},
            "Mounts": [],
            "State": {"Status": "running", "Running": True, "Pid": 322},
        }
        self.case.actuals = [self.helper]
        self.calls = []
        self.view = {
            "old_roots": {role: path.with_name("." + path.name + ".retained-original")
                          for role, path in self.case.roots.items()},
            "canonical_roots": dict(self.case.roots),
            "consumer_roots": tuple(self.case.roots.values()) + tuple(
                path.with_name("." + path.name + ".retained-original")
                for path in self.case.roots.values()
            ) + (Path("/mounted-new/payload/state"), Path("/mounted-new/payload/user")),
        }
        self.relocated = SimpleNamespace(overlaps=mock.Mock(return_value=False))
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch.object(
            removed, "require_relocated", return_value=self.view
        ))
        self.stack.enter_context(mock.patch.object(
            removed, "docker_capture", side_effect=self.daemon
        ))
        self.physical = mock.Mock(side_effect=lambda value, *_:(Path(value), None))
        self.stack.enter_context(mock.patch.dict(
            removed._unqualified_consumers.__globals__,
            {"_migration_bind_identity": self.physical},
        ))

    def daemon(self, *args):
        self.calls.append(args)
        if args[0] == "ps":
            return SimpleNamespace(stdout=("\n".join(row["Id"] for row in self.case.actuals) + "\n").encode())
        self.assertEqual(args[0], "inspect")
        self.assertEqual(set(args[1:]), {row["Id"] for row in self.case.actuals})
        return SimpleNamespace(stdout=json.dumps(self.case.actuals).encode())

    def call(self, *, fence=None):
        return removed.observe_removed_group(
            self.case.control, self.case.source, self.case.plan,
            fence=fence, relocated=self.relocated,
        )

    def fence(self, **changes):
        value = {
            "control": self.case.control,
            "operation": self.operation,
            "request": {"volume_id": self.case.plan["volume_id"],
                        "token": self.operation["receipt"]["attempt"]},
            "relocated": self.relocated,
            "identifier": self.fence_id,
            "check": mock.Mock(),
        }
        value.update(changes)
        return SimpleNamespace(**value)

    def test_exact_old_pair_absence_returns_closed_read_only_result(self):
        result = self.call()
        self.assertEqual(result, {
            "state": "removed-services-observed",
            "removed_containers": {"backend": self.case.pins["backend"],
                                   "frontend": self.case.pins["frontend"]},
            "observed_container_ids": [self.helper_id],
            "consumers": [],
        })
        self.assertEqual([call[0] for call in self.calls], ["ps", "inspect", "ps"])
        self.case.control.write.assert_not_called()

    def test_success_rechecks_a_real_relocated_group_scope(self):
        from scripts import test_docker_data_volume_bind_job as bind_fixtures
        from scripts import test_docker_data_volume_relocated as relocated_fixtures

        base_scenario = bind_fixtures.BindTerminalScenario

        class PinnedScenario(base_scenario):
            def __init__(fixture_case, test_case):
                super().__init__(test_case)
                fixture_case.plan["runtime_pins"].update({
                    "attempt": "1" * 32,
                    "config_sha256": "2" * 64,
                    "runtime_witness_path": "iteration/attempts/" + "3" * 32 + "/terminal.json",
                    "runtime_witness_sha256": "4" * 64,
                    "state_root": fixture_case.source_roots["state"]["canonical_root"],
                })

        fixture = relocated_fixtures.RelocatedGroupTests()
        with mock.patch.object(bind_fixtures, "BindTerminalScenario", PinnedScenario):
            fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        case = fixture.case
        plan = case.plan
        relocated = fixture.issue()

        helper_id = "c" * 64
        operation = {"receipt": {"phase": "data-volume-migration", "attempt": "5" * 32},
                     "helper_container_id": helper_id}
        control = SimpleNamespace(
            project=plan["compose_project"], volume="fixture-control", image=plan["runtime_pins"]["image_id"],
            _active_operation=operation,
        )
        control._assert_live_operation_helper = mock.Mock(return_value=helper_id)
        helper = {"Id": helper_id, "Config": {"Labels": {}}, "Mounts": [],
                  "State": {"Running": True, "Status": "running", "Pid": 400}}
        with mock.patch.object(removed, "require_relocated",
                               side_effect=lambda value, source, selected: value.check(source, selected)), \
             mock.patch.object(removed, "docker_capture", side_effect=[
                 SimpleNamespace(stdout=(helper_id + "\n").encode()),
                 SimpleNamespace(stdout=json.dumps([helper]).encode()),
                 SimpleNamespace(stdout=(helper_id + "\n").encode()),
             ]):
            observed = removed.observe_removed_group(
                control, case.source_root, plan, relocated=relocated
            )
        self.assertEqual(observed["state"], "removed-services-observed")
        self.assertEqual(observed["observed_container_ids"], [helper_id])

    def test_either_retained_old_id_refuses_even_when_its_configuration_is_unknown(self):
        for old in (self.case.pins["backend"], self.case.pins["frontend"]):
            with self.subTest(old=old):
                self.case.actuals.append({"Id": old, "State": {"Status": "exited"}, "Mounts": []})
                try:
                    with self.assertRaisesRegex(ValueError, "old service container"):
                        self.call()
                finally:
                    self.case.actuals.pop()

    def test_unknown_stopped_group_resource_control_volume_and_dataset_consumers_refuse(self):
        consumers = [
            {"Id": "e" * 64, "Config": {"Labels": {"com.docker.compose.project": self.case.control.project}},
             "Mounts": [], "State": {"Status": "exited", "Running": False, "Pid": 0}},
            {"Id": "e" * 64, "Config": {"Labels": {"com.docker.compose.project": "other"}},
             "Mounts": [{"Type": "volume", "Name": self.case.control.volume, "Destination": "/data"}],
             "State": {"Status": "exited", "Running": False, "Pid": 0}},
            {"Id": "e" * 64, "Config": {"Labels": {"com.docker.compose.project": "other"}},
             "Mounts": [{"Type": "bind", "Source": str(self.case.roots["state"] / "results"),
                         "Destination": "/data", "RW": False}],
             "State": {"Status": "exited", "Running": False, "Pid": 0}},
        ]
        for consumer, reason in zip(consumers,
                                    ("additional-group-resource", "control-volume-reference", "dataset-bind-reference")):
            with self.subTest(reason=reason):
                self.case.actuals.append(consumer)
                try:
                    with self.assertRaisesRegex(ValueError, reason):
                        self.call()
                finally:
                    self.case.actuals.pop()

    def test_physical_alias_and_unproven_bind_identity_refuse(self):
        consumer = {"Id": "e" * 64, "Config": {"Labels": {"com.docker.compose.project": "foreign"}},
                    "Mounts": [{"Type": "bind", "Source": "/same-physical-dataset-alias",
                                "Destination": "/data", "RW": False}],
                    "State": {"Status": "exited", "Running": False, "Pid": 0}}
        self.relocated.overlaps.return_value = True
        self.case.actuals.append(consumer)
        try:
            with self.assertRaisesRegex(ValueError, "dataset-bind-reference"):
                self.call()
        finally:
            self.case.actuals.pop()
        self.relocated.overlaps.return_value = False
        self.physical.side_effect = ValueError("unknown physical identity")
        self.case.actuals.append(consumer)
        try:
            with self.assertRaisesRegex(ValueError, "unproven-bind-identity"):
                self.call()
        finally:
            self.case.actuals.pop()

    def test_late_container_id_drift_refuses(self):
        original = self.daemon
        calls = 0

        def drift(*args):
            nonlocal calls
            calls += 1
            if args[0] == "ps" and calls == 3:
                self.case.actuals.append({"Id": "e" * 64, "Config": {}, "Mounts": [],
                                          "State": {"Status": "exited", "Running": False, "Pid": 0}})
            return original(*args)

        with mock.patch.object(removed, "docker_capture", side_effect=drift):
            with self.assertRaisesRegex(ValueError, "inventory changed"):
                self.call()

    def test_inspect_failure_cannot_be_treated_as_absence(self):
        with mock.patch.object(removed, "docker_capture", side_effect=[
            SimpleNamespace(stdout=(self.helper_id + "\n").encode()),
            RuntimeError("inspect timed out"),
        ]):
            with self.assertRaisesRegex(RuntimeError, "inspect timed out"):
                self.call()

    def test_inspect_must_return_exactly_the_complete_ps_id_set(self):
        with mock.patch.object(removed, "docker_capture", side_effect=[
            SimpleNamespace(stdout=(self.helper_id + "\n").encode()),
            SimpleNamespace(stdout=json.dumps([self.helper, dict(self.helper, Id="e" * 64)]).encode()),
        ]):
            with self.assertRaisesRegex(ValueError, "inspection changed its complete inventory"):
                self.call()

    def test_operation_and_fence_must_be_the_live_exact_scope(self):
        self.case.control._active_operation = None
        with self.assertRaisesRegex(ValueError, "live migration lease"):
            self.call()
        self.case.control._active_operation = self.operation
        self.case.control._assert_live_operation_helper.reset_mock()
        self.case.control._assert_live_operation_helper.return_value = self.helper_id
        for invalid in (
            self.fence(operation=copy.deepcopy(self.operation)),
            self.fence(request={"volume_id": self.case.plan["volume_id"], "token": "0" * 32}),
            self.fence(request={"volume_id": "0" * 32,
                                "token": self.operation["receipt"]["attempt"]}),
            self.fence(relocated=object()),
            self.fence(control=object()),
            self.fence(identifier="short"),
        ):
            with self.subTest(fence=invalid), self.assertRaisesRegex(ValueError, "Foreign live copy fence"):
                self.call(fence=invalid)
            invalid.check.assert_not_called()
        with mock.patch.object(removed, "require_relocated", side_effect=ValueError("expired relocated scope")):
            with self.assertRaisesRegex(ValueError, "expired relocated scope"):
                self.call()

    def test_selected_source_project_image_and_pins_are_exact(self):
        for mutate in (
            lambda plan: plan.update(source_root="/foreign/source"),
            lambda plan: plan.update(compose_project="foreign-project"),
            lambda plan: plan["runtime_pins"].update(image_id="sha256:" + "0" * 64),
            lambda plan: plan["runtime_pins"].update(backend="bad-id"),
        ):
            plan = copy.deepcopy(self.case.plan)
            mutate(plan)
            with self.subTest(plan=plan), mock.patch.object(removed, "docker_capture") as capture, \
                    self.assertRaises(ValueError):
                removed.observe_removed_group(
                    self.case.control, self.case.source, plan, relocated=self.relocated
                )
            capture.assert_not_called()

    def test_full_inventory_must_contain_the_live_control_helper(self):
        other_id = "e" * 64
        other = {"Id": other_id, "Config": {}, "Mounts": [],
                 "State": {"Status": "exited", "Running": False, "Pid": 0}}
        self.case.actuals = [other]
        with self.assertRaisesRegex(ValueError, "helper/fence is absent"):
            self.call()

    def test_fence_is_checked_before_and_after_complete_observation(self):
        self.case.actuals.append(self.fence_container)
        fence = self.fence()
        result = self.call(fence=fence)
        self.assertEqual(result["state"], "removed-services-observed")
        self.assertGreaterEqual(fence.check.call_count, 2)
        self.assertIn(self.fence_id, result["observed_container_ids"])

    def test_full_container_id_inventory_requires_helper_and_unambiguous_full_ids(self):
        for output in (b"", (self.helper_id + "\n" + self.helper_id + "\n").encode(), b"short\n"):
            with self.subTest(output=output), mock.patch.object(
                    removed, "docker_capture", return_value=SimpleNamespace(stdout=output)):
                with self.assertRaisesRegex(ValueError, "inventory"):
                    self.call()


if __name__ == "__main__":
    unittest.main()
