"""Post-start pending-marker scope tests; Docker and mounts remain simulated."""
from contextvars import copy_context
import copy
import importlib
import json
import os
from pathlib import Path
import sys
import threading
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_data_volume_startup_scope as startup_scope
import fullmag_data_volume_guard as guard

from scripts import test_docker_dev_data_volume_restart as restart_tests


def _issued_started_group(test_case, *, direct_issuer=False):
    original_restart = restart_tests.restart
    selected_restart = (
        importlib.import_module("docker_dev_data_volume_restart")
        if direct_issuer else original_restart
    )
    with mock.patch.object(restart_tests, "restart", selected_restart):
        harness = restart_tests.RestartHarness(
            "test_success_removes_exact_old_pair_releases_original_copy_sha_then_starts_standard_dev"
        )
        harness.setUp()
        test_case.addCleanup(harness.doCleanups)
        started = harness.call()

    helper = harness.helper

    # The existing sequencing harness's fake readback asserts that startup_scope
    # has closed. The real restart-context readback is safe while the distinct
    # post-start qualification scope is active, so adapt only this fake boundary.
    def revalidate_started(control, prepared, retained, evidence):
        if (control is not helper.control or prepared is not helper.prepared or
                retained is not helper.restart):
            raise ValueError("started evidence belongs to another retained restart")
        if copy.deepcopy(evidence) != helper.evidence:
            raise ValueError("Started runtime evidence changed after publication")
        helper.post_revalidation_calls += 1
        harness.events.append("revalidate-started-in-qualification-scope")
        if (helper.fail_post_revalidation or
                helper.fail_post_revalidation_at == helper.post_revalidation_calls):
            raise RuntimeError("post-scope started evidence drift")
        return copy.deepcopy(helper.evidence)

    patcher = mock.patch.object(helper, "revalidate_started", side_effect=revalidate_started)
    patcher.start()
    test_case.addCleanup(patcher.stop)
    return harness, started


class QualificationScopeContractTests(unittest.TestCase):
    def setUp(self):
        self.harness, self.started = _issued_started_group(self)
        self.fixture = self.harness.fixture
        self.prepared = self.harness.prepared
        self.helper = self.harness.helper

    def _verify(self, scope, **kwargs):
        return startup_scope.verify_pending(
            scope, self.fixture.layout, "compose-fixture", self.fixture.pending, **kwargs
        )

    def test_genuine_issued_started_group_verifies_pending_as_admitted(self):
        with startup_scope.qualification_scope(self.started) as scope:
            self.assertIs(startup_scope.current_scope(), scope)
            result = self._verify(
                scope, state_root=self.fixture.state_root, user_data_root=self.fixture.user_root
            )
            self.assertEqual(result["state"], "pending-started-not-registered")
            self.assertTrue(result["namespace_admitted"])
            self.assertFalse(result["data_migrated"])
            self.assertFalse(result["originals_retired"])
            self.assertEqual(result["pending"], self.fixture.pending)
        self.assertIsNone(startup_scope.current_scope())

    def test_direct_script_started_issuer_uses_the_same_scope_contextvar(self):
        harness, started = _issued_started_group(self, direct_issuer=True)
        self.assertEqual(type(started).__module__, "docker_dev_data_volume_restart")
        direct_issuer = sys.modules[type(started).__module__]
        self.assertIs(direct_issuer.startup_scope, startup_scope)
        with startup_scope.qualification_scope(started) as scope:
            self.assertIs(startup_scope.current_scope(), scope)
            result = startup_scope.verify_pending(
                scope, harness.fixture.layout, "compose-fixture", harness.fixture.pending
            )
            self.assertEqual(result["state"], "pending-started-not-registered")
            self.assertTrue(result["namespace_admitted"])

    def test_qualification_does_not_recheck_pre_native_admission_candidate(self):
        job = importlib.import_module("scripts.docker_data_volume_admission_job")
        with mock.patch.object(job, "validate_terminal",
                               side_effect=AssertionError("pre-start native candidate was replayed")):
            with startup_scope.qualification_scope(self.started) as scope:
                self.assertEqual(self._verify(scope)["state"], "pending-started-not-registered")

    def test_existing_pending_guard_reads_only_the_started_groups_two_roots(self):
        index_path = Path(self.fixture.storage) / "index" / "worktree-fixture.json"
        index_path.write_text(json.dumps({
            "schema": "fullmag.worktree.v1", "worktree_id": "worktree-fixture",
        }))
        with startup_scope.qualification_scope(self.started) as scope:
            with self.assertRaisesRegex(ValueError, "Pending data-volume migration"):
                guard.verify_registered_volume(self.fixture.layout, "compose-fixture")
            result = guard.verify_registered_volume(
                self.fixture.layout, "compose-fixture", state_root=self.fixture.state_root,
                user_data_root=self.fixture.user_root, migration_scope=scope,
            )
        self.assertEqual(result["state"], "pending-started-not-registered")
        self.assertEqual(result["pending"]["state_root"], str(self.fixture.state_root))
        self.assertEqual(result["pending"]["user_data_root"], str(self.fixture.user_root))
        self.assertTrue(result["namespace_admitted"])
        self.assertFalse(result["data_migrated"])
        self.assertFalse(result["originals_retired"])

    def test_started_readback_drift_refuses_at_scope_entry(self):
        self.helper.evidence["config_sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "Started runtime evidence changed"):
            with startup_scope.qualification_scope(self.started):
                self.fail("changed started evidence must fail before yielding")
        self.assertIsNone(startup_scope.current_scope())

    def test_started_readback_drift_refuses_during_scope_use(self):
        original = copy.deepcopy(self.helper.evidence)
        with startup_scope.qualification_scope(self.started) as scope:
            self.helper.evidence["config_sha256"] = "0" * 64
            with self.assertRaisesRegex(ValueError, "Started runtime evidence changed"):
                startup_scope.current_scope()
            self.helper.evidence = original
            self.assertIs(startup_scope.current_scope(), scope)

    def test_started_readback_drift_refuses_successful_scope_exit(self):
        original = copy.deepcopy(self.helper.evidence)
        with self.assertRaisesRegex(ValueError, "Started runtime evidence changed"):
            with startup_scope.qualification_scope(self.started):
                self.helper.evidence["config_sha256"] = "0" * 64
        self.helper.evidence = original
        self.assertIsNone(startup_scope.current_scope())

    def test_wrong_pending_layout_project_and_roots_refuse(self):
        with startup_scope.qualification_scope(self.started) as scope:
            wrong_layout = copy.deepcopy(self.fixture.layout)
            wrong_layout["worktree_id"] = "foreign-worktree"
            wrong_pending = copy.deepcopy(self.fixture.pending)
            wrong_pending["volume_id"] = "f" * 32
            cases = (
                (wrong_layout, "compose-fixture", self.fixture.pending, {}),
                (self.fixture.layout, "foreign-compose", self.fixture.pending, {}),
                (self.fixture.layout, "compose-fixture", wrong_pending, {}),
                (self.fixture.layout, "compose-fixture", self.fixture.pending,
                 {"state_root": self.fixture.runtime}),
                (self.fixture.layout, "compose-fixture", self.fixture.pending,
                 {"user_data_root": self.fixture.storage / "user-data/foreign"}),
            )
            for layout, project, pending, options in cases:
                with self.subTest(project=project, options=options), self.assertRaises(ValueError):
                    startup_scope.verify_pending(scope, layout, project, pending, **options)

    def test_scope_is_unforgeable_non_nested_and_expires(self):
        with startup_scope.qualification_scope(self.started) as scope:
            with self.assertRaises(ValueError):
                with startup_scope.qualification_scope(self.started):
                    pass
            with self.assertRaises((ValueError, AttributeError)):
                self._verify(copy.copy(scope))
            with self.assertRaises(AttributeError):
                scope._started = object()
        self.assertIsNone(startup_scope.current_scope())
        with self.assertRaises(ValueError):
            self._verify(scope)

    def test_forged_started_class_and_issuer_path_refuse(self):
        issuer_name = type(self.started).__module__
        issuer = sys.modules[issuer_name]
        spoof_type = type("StartedGroup", (), {"__module__": issuer_name})
        spoof = spoof_type()
        spoof._prepared = self.prepared
        with self.assertRaises(ValueError):
            with startup_scope.qualification_scope(spoof):
                self.fail("a matching module name cannot forge the exact StartedGroup class")
        with mock.patch.object(issuer, "__file__", str(self.fixture.case.op / "foreign.py")):
            with self.assertRaises(ValueError):
                with startup_scope.qualification_scope(self.started):
                    self.fail("an issuer from another source path must refuse")

    def test_prepared_layout_mutation_and_scope_mutation_refuse(self):
        original_layout = copy.deepcopy(self.prepared["context"]["layout"])
        with startup_scope.qualification_scope(self.started) as scope:
            self.prepared["context"]["layout"]["worktree_id"] = "changed-worktree"
            with self.assertRaises(ValueError):
                startup_scope.current_scope()
            self.fixture.layout.clear()
            self.fixture.layout.update(original_layout)
            self.assertIs(startup_scope.current_scope(), scope)

    def test_scope_does_not_cross_thread_or_process(self):
        with startup_scope.qualification_scope(self.started):
            errors = []
            inherited = copy_context()

            def other_thread():
                try:
                    inherited.run(startup_scope.current_scope)
                except ValueError as error:
                    errors.append(error)

            thread = threading.Thread(target=other_thread)
            thread.start()
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive())
            self.assertEqual(len(errors), 1)
            with mock.patch.object(startup_scope.os, "getpid", return_value=os.getpid() + 1):
                with self.assertRaises(ValueError):
                    startup_scope.current_scope()

    def test_loss_of_original_copy_host_scope_refuses(self):
        self.fixture._stack.close()
        with self.assertRaises(ValueError):
            with startup_scope.qualification_scope(self.started):
                self.fail("qualification cannot outlive the original copied-group host scope")


if __name__ == "__main__":
    unittest.main()
