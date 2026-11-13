"""Restart sequencing under an issued pending-volume scope; Docker is simulated."""

from argparse import Namespace
from contextlib import contextmanager
from copy import deepcopy
import hashlib
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import docker_data_volume_startup_scope as startup_scope
from scripts import docker_dev_data_volume_restart as restart
from scripts.test_docker_data_volume_startup_scope import StartupScopeFixture


def sha(value):
    return hashlib.sha256(value).hexdigest()


class FakeFence:
    def __init__(self, harness, control, actual, source, request, *, relocated):
        self.harness = harness
        self.control = control
        self.actual = actual
        self.source = source
        self.request = request
        self.relocated = relocated
        self.operation = control._active_operation
        self.identifier = "d" * 64
        self.released = False
        self.inside = False

    def __enter__(self):
        if self.operation is None or self.control._active_operation is not self.operation:
            raise ValueError("fake fence requires the active migration operation")
        self.inside = True
        self.operation["daemon_pending"] = True
        self.harness.fence = self
        return self

    def __exit__(self, error_type, error, traceback):
        self.inside = False
        if not self.released:
            self.operation["daemon_pending"] = True
            if error_type is None:
                raise RuntimeError("fake fence was left without terminal acknowledgement")
        return False

    def check(self):
        if not self.inside or self.control._active_operation is not self.operation or self.released:
            raise RuntimeError("fake fence is no longer held")

    def finish(self, receipt_sha256):
        self.check()
        if receipt_sha256 != self.harness.context["copy_receipt_sha256"]:
            raise ValueError("fence acknowledgement must use the original copy receipt")
        self.finished_sha256 = receipt_sha256
        self.released = True
        self.operation["daemon_pending"] = False


class FakeRetainedRestart:
    """Model the helper boundary while keeping its issuer/scope genuine."""

    def __init__(self, harness, components):
        self.harness = harness
        self.COMPONENTS = components
        self.restart = None
        self.revalidate_calls = 0
        self.fail_revalidate_at = None
        self.evidence = harness.started_evidence()
        self.start_arguments_calls = 0
        self.fail_post_revalidation = False
        self.post_revalidation_calls = 0
        self.fail_post_revalidation_at = None

    def _active(self, prepared):
        scope = startup_scope.current_scope()
        if scope is None or scope._prepared is not prepared:
            raise ValueError("retained restart helper requires the exact active startup scope")

    def prepare_context(self, control, prepared, snapshot, *, fence):
        self._active(prepared)
        if control._active_operation is None or not fence.inside or fence.released:
            raise ValueError("retained inputs require live old guards")
        self.restart = object()
        self.prepared = prepared
        self.control = control
        self.operation = control._active_operation
        self.fence = fence
        self.snapshot = deepcopy(snapshot)
        prepared._retained_restart = self.restart
        return self.restart

    def require_context(self, retained):
        if retained is not self.restart or self.restart is None:
            raise ValueError("unissued retained restart context")
        self._active(self.prepared)

    def revalidate_context(self, control, prepared, retained, snapshot, *, fence):
        self.require_context(retained)
        if (control is not self.control or prepared is not self.prepared or fence is not self.fence or
                snapshot != self.snapshot or fence.released):
            raise ValueError("retained inputs or old guards changed")
        self.revalidate_calls += 1
        if self.fail_revalidate_at == self.revalidate_calls:
            raise RuntimeError("retained context drift")
        return retained

    def summary(self, retained):
        self.require_context(retained)
        return {"schema": "fullmag.data-volume-retained-restart.v1", "safe_fixture": True}

    def start_arguments(self, retained):
        self.require_context(retained)
        if (self.control._active_operation is not None or self.operation["daemon_pending"] is not False or
                self.operation["receipt"].get("state") != "succeeded" or not self.fence.released):
            raise ValueError("start requires closed operation and released copy fence")
        self.start_arguments_calls += 1
        if self.start_arguments_calls != 1:
            raise ValueError("retained start arguments are one-shot")
        return Namespace(
            source_root=self.prepared["context"]["source"], script=None, profile="dev", port=3274,
        ), {
            "capture_terminal": True,
            "previous_config_sha256": None,
        }

    def validate_started(self, control, prepared, retained, captured):
        self.require_context(retained)
        if control._active_operation is not None or not captured.get("fixture_capture"):
            raise ValueError("standard start capture is not the exact terminal")
        self.harness.events.append("validate-started")
        return deepcopy(self.evidence)

    def revalidate_started(self, control, prepared, retained, evidence):
        if startup_scope.current_scope() is not None:
            raise ValueError("post-scope started evidence must be revalidated after scope exit")
        if control is not self.control or prepared is not self.prepared or retained is not self.restart:
            raise ValueError("started evidence is bound to another retained context")
        if deepcopy(evidence) != self.evidence:
            raise ValueError("started evidence changed after publication")
        self.post_revalidation_calls += 1
        self.harness.events.append("revalidate-started-outside-scope")
        if (self.fail_post_revalidation or
                self.fail_post_revalidation_at == self.post_revalidation_calls):
            raise RuntimeError("post-scope started evidence drift")
        return deepcopy(evidence)


class RestartHarness(unittest.TestCase):
    def setUp(self):
        self.fixture = StartupScopeFixture(self)
        self.context = self.fixture.context
        self.plan = self.context["plan"]
        self.volume = self.context["linux"]["volume_id"]
        self.plan.update(
            compose_project=self.context["identity"]["project_name"],
            source_root=str(self.context["source"]),
            volume_id=self.volume,
        )
        self.plan["runtime_pins"].update(
            attempt="3" * 32,
            config_sha256="2" * 64,
            state_root=str(self.fixture.state_root),
        )
        self.context["linux"]["source_roots"] = {
            "state": {"device": 101, "inode": 201},
            "user_data": {"device": 101, "inode": 202},
        }
        self.prepared = self.fixture.issue()
        self.control = self.fixture.control
        self.control.project = self.context["identity"]["project_name"]
        self.control.volume = "fullmag-control-fixture"
        self.control.namespace = ""
        self.control.write = mock.Mock()
        self.control._active_operation = None
        self.control.op["daemon_pending"] = False
        self.control.op["receipt"].update(state="starting", phase="data-volume-migration")

        self.old_ids = {
            "backend": self.plan["runtime_pins"]["backend"],
            "frontend": self.plan["runtime_pins"]["frontend"],
        }
        self.snapshot = {
            "actual": {
                role: {"Id": identifier, "Image": self.plan["runtime_pins"]["image_id"]}
                for role, identifier in self.old_ids.items()
            },
            "source_proof": {"proof": "same-old-state"},
            "process_receipt_sha256": self.context["drain"]["process_receipt_sha256"],
            "consumers": [],
        }
        self.events = []
        self.fence = None
        self.observations = []
        self.removed_result = {
            "state": "removed-services-observed",
            "removed_containers": deepcopy(self.old_ids),
            "observed_container_ids": ["a" * 64],
            "consumers": [],
        }
        self.helper = FakeRetainedRestart(
            self, __import__("docker_data_volume_restart_context").COMPONENTS,
        )
        self.stack = mock.patch.object(restart, "_restart_context_module", return_value=self.helper)
        self.stack.start()
        self.addCleanup(self.stack.stop)
        self.stack_patches = [
            mock.patch.object(restart, "CopyFence", side_effect=self.new_fence),
            mock.patch.object(restart, "observe_stopped_group", side_effect=self.observe_stopped),
            mock.patch.object(restart, "observe_removed_group", side_effect=self.observe_removed),
            mock.patch.object(restart, "docker_capture", side_effect=self.docker_capture),
        ]
        for patcher in self.stack_patches:
            patcher.start()
            self.addCleanup(patcher.stop)

        self.dev_module = ModuleType("docker_volume_dev")
        self.dev_module.__file__ = str(Path(restart.__file__).resolve().with_name("docker_volume_dev.py"))
        self.dev_module.start = mock.Mock(side_effect=self.standard_start)
        self.module_patch = mock.patch.dict("sys.modules", {"docker_volume_dev": self.dev_module})
        self.module_patch.start()
        self.addCleanup(self.module_patch.stop)

    def started_evidence(self):
        return {
            "schema": "fullmag.data-volume-started-evidence.v1",
            "development_attempt": "5" * 32,
            "development_terminal": {
                "relative": "development/attempts/" + "5" * 32 + "/terminal.json",
                "sha256": "6" * 64,
            },
            "config_sha256": "7" * 64,
            "source_commit": "8" * 40,
            "source_snapshot_sha256": "9" * 64,
            "backend_build_receipt_sha256": "a" * 64,
            "containers": {"backend": "b" * 64, "frontend": "c" * 64},
            "certificate_sha256": "d" * 64,
            "namespace_admitted": True,
            "data_migrated": False,
            "originals_retired": False,
        }

    def new_fence(self, control, actual, source, request, *, relocated=None):
        return FakeFence(self, control, actual, source, request, relocated=relocated)

    def observe_stopped(self, control, source, plan, attempt, stop_sha, *, fence=None, relocated=None):
        self.assertIs(control, self.control)
        self.assertEqual(source, self.context["source"])
        self.assertEqual((attempt, stop_sha), (self.context["drain"]["stop_attempt"],
                                               self.context["drain"]["stop_sha256"]))
        self.assertIs(relocated, self.prepared["relocated"])
        self.observations.append(fence)
        if fence is not None:
            self.assertIs(fence, self.fence)
            self.assertTrue(fence.inside)
        return deepcopy(self.snapshot)

    def observe_removed(self, control, source, plan, *, fence, relocated):
        self.events.append("observe-removed")
        self.assertIs(control, self.control)
        self.assertIs(fence, self.fence)
        self.assertTrue(fence.inside)
        self.assertIs(relocated, self.prepared["relocated"])
        return deepcopy(self.removed_result)

    def docker_capture(self, *argv, **kwargs):
        self.events.append(("docker", argv, kwargs))
        ids = [self.old_ids["backend"], self.old_ids["frontend"]]
        return SimpleNamespace(returncode=0, stdout=("\n".join(ids) + "\n").encode("ascii"), stderr=b"")

    def standard_start(self, args, **kwargs):
        self.events.append("standard-start")
        self.assertIsNotNone(startup_scope.current_scope())
        self.assertIsNone(self.control._active_operation)
        self.assertTrue(self.fence.released)
        restart._validate_start_arguments(args, kwargs, self.context)
        return {"fixture_capture": True}

    def call(self):
        with self.fixture.validator_patch():
            return restart.restart_prepared_group(self.prepared)

    def test_success_removes_exact_old_pair_releases_original_copy_sha_then_starts_standard_dev(self):
        started = self.call()
        self.assertEqual(self.fence.request["volume_id"], self.volume)
        self.assertEqual(self.fence.request["token"], self.control.op["receipt"]["attempt"])
        self.assertEqual(self.fence.finished_sha256, self.context["copy_receipt_sha256"])
        self.assertTrue(self.fence.released)
        self.assertFalse(self.control.op["daemon_pending"])
        self.assertEqual(self.control.op["receipt"]["state"], "succeeded")
        self.assertEqual(self.control.op["receipt"]["copy_receipt_acknowledgement_sha256"],
                         self.context["copy_receipt_sha256"])
        self.assertFalse(self.control.op["receipt"]["namespace_admitted"])
        self.assertFalse(self.control.op["receipt"]["data_migrated"])
        self.assertFalse(self.control.op["receipt"]["originals_retired"])
        docker_events = [event for event in self.events if isinstance(event, tuple) and event[0] == "docker"]
        self.assertEqual(len(docker_events), 1)
        self.assertEqual(docker_events[0][1], ("rm", self.old_ids["backend"], self.old_ids["frontend"]))
        self.assertEqual(docker_events[0][2], {"allow_failure": True, "timeout": 60})
        self.assertLess(self.events.index("observe-removed"), self.events.index("standard-start"))
        self.assertLess(self.events.index("standard-start"), self.events.index("validate-started"))
        self.assertLess(self.events.index("validate-started"),
                        self.events.index("revalidate-started-outside-scope"))
        self.assertEqual(started.as_record()["state"], "runtime-started-not-scientifically-qualified")
        self.assertEqual(restart.require_started_group(started, self.prepared), started.as_record())
        with self.assertRaises(ValueError):
            restart.require_started_group(object(), self.prepared)
        for name in restart.ARTIFACTS[:-1]:
            self.assertTrue((self.context["operation_root"] / name).exists(), name)
        final_path = self.context["operation_root"] / "restart-result.json"
        final_raw = final_path.read_bytes()
        final_path.write_bytes(final_raw + b" ")
        with self.assertRaisesRegex(ValueError, "evidence SHA"):
            restart.require_started_group(started, self.prepared)
        final_path.write_bytes(final_raw)
        (self.context["operation_root"] / "restart-failure.json").write_bytes(b"{}\n")
        with self.assertRaisesRegex(ValueError, "terminal operation changed"):
            restart.require_started_group(started, self.prepared)

    def test_existing_artifact_refuses_before_operation_or_any_observation(self):
        path = self.context["operation_root"] / "restart-removal-intent.json"
        path.write_bytes(b"retained\n")
        with self.fixture.validator_patch(), self.assertRaisesRegex(ValueError, "already exist"):
            restart.restart_prepared_group(self.prepared)
        self.assertIsNone(self.control._active_operation)
        self.assertEqual(self.observations, [])
        self.assertEqual(self.events, [])

    def test_overlap_with_another_control_operation_refuses_before_observation(self):
        self.control._active_operation = {"foreign": True}
        with self.fixture.validator_patch(), self.assertRaisesRegex(ValueError, "still open"):
            restart.restart_prepared_group(self.prepared)
        self.assertEqual(self.observations, [])
        self.assertFalse((self.context["operation_root"] / "restart-removal-intent.json").exists())

    def test_changed_stopped_pair_or_process_proof_refuses_before_fence_and_rm(self):
        changed = deepcopy(self.snapshot)
        changed["process_receipt_sha256"] = "0" * 64
        with mock.patch.object(restart, "observe_stopped_group", return_value=changed), \
                self.fixture.validator_patch(), self.assertRaisesRegex(ValueError, "process proof"):
            restart.restart_prepared_group(self.prepared)
        self.assertIsNone(self.fence)
        self.assertFalse(any(isinstance(event, tuple) and event[0] == "docker" for event in self.events))

    def test_second_retained_revalidation_failure_keeps_intent_and_does_not_remove(self):
        self.helper.fail_revalidate_at = 2
        with self.fixture.validator_patch(), self.assertRaisesRegex(RuntimeError, "context drift"):
            restart.restart_prepared_group(self.prepared)
        self.assertTrue(self.fence.inside is False)
        self.assertFalse(self.fence.released)
        self.assertTrue(self.control.op["daemon_pending"])
        self.assertTrue((self.context["operation_root"] / "restart-removal-intent.json").exists())
        self.assertFalse(any(isinstance(event, tuple) and event[0] == "docker" for event in self.events))
        with self.fixture.validator_patch(), self.assertRaisesRegex(ValueError, "already attempted"):
            restart.restart_prepared_group(self.prepared)

    def test_nonzero_rm_result_retains_fence_and_never_starts(self):
        with mock.patch.object(restart, "docker_capture", return_value=SimpleNamespace(
                returncode=1, stdout=b"", stderr=b"daemon refused")), \
                self.fixture.validator_patch(), self.assertRaisesRegex(ValueError, "did not complete"):
            restart.restart_prepared_group(self.prepared)
        self.assertFalse(self.fence.released)
        self.assertTrue(self.control.op["daemon_pending"])
        self.dev_module.start.assert_not_called()
        self.assertEqual(self.observations.count(self.fence), 2)

    def test_wrong_rm_ids_retains_fence_and_never_starts(self):
        with mock.patch.object(restart, "docker_capture", return_value=SimpleNamespace(
                returncode=0, stdout=("a" * 64 + "\n").encode(), stderr=b"")), \
                self.fixture.validator_patch(), self.assertRaisesRegex(ValueError, "exactly the requested"):
            restart.restart_prepared_group(self.prepared)
        self.assertFalse(self.fence.released)
        self.assertTrue(self.control.op["daemon_pending"])
        self.dev_module.start.assert_not_called()
        self.assertEqual(self.observations.count(self.fence), 2)

    def test_post_removal_inventory_containing_old_id_refuses_release_and_start(self):
        self.removed_result["observed_container_ids"] = sorted(["a" * 64, self.old_ids["backend"]])
        with self.fixture.validator_patch(), self.assertRaisesRegex(ValueError, "post-removal"):
            restart.restart_prepared_group(self.prepared)
        self.assertFalse(self.fence.released)
        self.assertTrue(self.control.op["daemon_pending"])
        self.dev_module.start.assert_not_called()

    def test_standard_start_error_never_issues_capability_or_allows_replay(self):
        self.dev_module.start.side_effect = RuntimeError("standard start outcome needs reconciliation")
        with self.fixture.validator_patch(), self.assertRaisesRegex(RuntimeError, "reconciliation"):
            restart.restart_prepared_group(self.prepared)
        self.assertTrue(self.fence.released)
        self.assertFalse(self.control.op["daemon_pending"])
        self.assertFalse(hasattr(self.prepared, "_restart_started_group"))
        self.assertTrue((self.context["operation_root"] / "restart-removal-result.json").exists())
        self.assertTrue((self.context["operation_root"] / "restart-start-intent.json").exists())
        self.assertFalse((self.context["operation_root"] / "restart-result.json").exists())
        with self.assertRaises(ValueError):
            restart.require_started_group(None, self.prepared)
        with self.fixture.validator_patch(), self.assertRaisesRegex(ValueError, "already attempted"):
            restart.restart_prepared_group(self.prepared)

    def test_forged_terminal_never_issues_capability_or_publishes_success(self):
        self.helper.evidence = {"namespace_admitted": True, "data_migrated": False}
        with self.fixture.validator_patch(), self.assertRaisesRegex(ValueError, "closed qualified start record"):
            restart.restart_prepared_group(self.prepared)
        self.assertTrue(self.fence.released)
        self.assertFalse(hasattr(self.prepared, "_restart_started_group"))
        self.assertFalse((self.context["operation_root"] / "restart-start-result.json").exists())
        self.assertFalse((self.context["operation_root"] / "restart-result.json").exists())

    def test_late_scope_exit_failure_does_not_publish_success_or_mint(self):
        original_scope = startup_scope.startup_scope

        @contextmanager
        def fail_after_close(prepared):
            with original_scope(prepared) as scope:
                yield scope
            raise RuntimeError("late scope bookend failure")

        with mock.patch.object(startup_scope, "startup_scope", side_effect=fail_after_close), \
                self.fixture.validator_patch(), self.assertRaisesRegex(RuntimeError, "late scope bookend"):
            restart.restart_prepared_group(self.prepared)
        self.assertTrue(self.fence.released)
        self.assertTrue((self.context["operation_root"] / "restart-start-intent.json").exists())
        self.assertFalse((self.context["operation_root"] / "restart-start-result.json").exists())
        self.assertFalse((self.context["operation_root"] / "restart-result.json").exists())
        self.assertFalse(hasattr(self.prepared, "_restart_started_group"))

    def test_post_scope_runtime_readback_failure_does_not_publish_success_or_mint(self):
        self.helper.fail_post_revalidation = True
        with self.fixture.validator_patch(), self.assertRaisesRegex(RuntimeError, "post-scope started evidence"):
            restart.restart_prepared_group(self.prepared)
        self.assertTrue(self.fence.released)
        self.assertTrue((self.context["operation_root"] / "restart-start-intent.json").exists())
        self.assertFalse((self.context["operation_root"] / "restart-start-result.json").exists())
        self.assertFalse((self.context["operation_root"] / "restart-result.json").exists())
        self.assertFalse(hasattr(self.prepared, "_restart_started_group"))

    def test_postpublication_revalidation_failure_retains_results_but_does_not_mint(self):
        self.helper.fail_post_revalidation_at = 2
        with self.fixture.validator_patch(), self.assertRaisesRegex(RuntimeError, "post-scope started evidence"):
            restart.restart_prepared_group(self.prepared)
        self.assertEqual(self.helper.post_revalidation_calls, 2)
        self.assertTrue((self.context["operation_root"] / "restart-start-result.json").exists())
        self.assertTrue((self.context["operation_root"] / "restart-result.json").exists())
        self.assertTrue((self.context["operation_root"] / "restart-failure.json").exists())
        _raw, failure = restart.qualification._read(
            self.context["operation_root"] / "restart-failure.json"
        )
        self.assertEqual(failure["state"], "outcome-unknown-resources-retained")
        self.assertFalse(hasattr(self.prepared, "_restart_started_group"))


if __name__ == "__main__":
    unittest.main()
