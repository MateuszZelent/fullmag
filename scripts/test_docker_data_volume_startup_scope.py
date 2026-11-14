"""Temporary pending-marker capability tests; no startup or mount operations."""

from contextlib import ExitStack
import contextvars
import copy
import hashlib
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

from scripts import docker_dev_data_volume_admission as admission_parent
from scripts import docker_dev_data_volume_copy as copy_parent
from scripts import test_docker_dev_data_volume_copy as copy_fixtures


class StartupScopeFixture:
    def __init__(self, test_case):
        self.test_case = test_case
        self.case = copy_fixtures.CopyParentSequencingTests()
        self.case.setUp()
        test_case.addCleanup(self.case.doCleanups)

        self.storage = self.case.op / "storage"
        self.runtime = self.storage / "runs/docker-all/session-store"
        self.state_root = self.runtime / self.case.volume
        self.user_root = self.storage / "user-data/compose-fixture"
        marker_path = self.storage / "index/data-volumes/worktree-fixture.pending.json"
        marker_path.parent.mkdir(parents=True)
        self.runtime.mkdir(parents=True)
        self.state_root.mkdir()
        self.user_root.mkdir(parents=True)
        self.layout = {
            "storage_root": str(self.storage),
            "runtime_root": str(self.runtime),
            "repo_root": str(self.case.source),
            "worktree_id": "worktree-fixture",
            "env": {"FULLMAG_PROJECT_ID": "project-fixture"},
        }
        self.pending = {
            "schema": "fullmag.data-volume-pending.v1",
            "project_id": "project-fixture",
            "worktree_id": "worktree-fixture",
            "compose_project": "compose-fixture",
            "source_root": str(self.case.source),
            "volume_id": self.case.volume,
            "plan_sha256": "a" * 64,
            "linux_request_sha256": "1" * 64,
            "copy_receipt_sha256": "9" * 64,
            "state_root": str(self.state_root),
            "user_data_root": str(self.user_root),
        }
        self.marker_path = marker_path
        self._write_marker()
        self.pending_ref = {
            "path": str(marker_path),
            "sha256": hashlib.sha256(marker_path.read_bytes()).hexdigest(),
        }

        self.control = copy_fixtures.FakeControl()
        self.control.op["receipt"]["attempt"] = "c" * 32
        self.context = copy.deepcopy(self.case.context)
        self.context.update(
            layout=self.layout,
            identity={"project_name": "compose-fixture", "project_id": "project-fixture",
                      "worktree_id": "worktree-fixture"},
            copy_receipt_sha256="9" * 64,
            copy_request_sha256="7" * 64,
            drain={"stop_attempt": self.case.stop, "stop_sha256": self.case.stop_sha,
                   "process_receipt_sha256": "f" * 64},
        )
        self.root_rows = {
            "state": {"canonical_root": str(self.state_root)},
            "user_data": {"canonical_root": str(self.user_root)},
        }
        self.bound_terminal = {
            "state": "binds-switched-not-admitted",
            "receipt_sha256": "8" * 64,
            "result": {"request_sha256": "7" * 64, "switch": {"roots": self.root_rows}},
        }
        self.bound = {"context": self.context, "terminal": self.bound_terminal}
        self.relocated = object()
        self.native_before = {"fixture": "captured-before-admission-root"}
        self.terminal = None
        self._stack = ExitStack()
        test_case.addCleanup(self._stack.close)

    def _write_marker(self):
        self.marker_path.write_text(json.dumps(self.pending, sort_keys=True) + "\n")

    def issue(self, issuer=admission_parent):
        if issuer is admission_parent:
            self._stack.enter_context(self.case.patches())
            self._stack.enter_context(copy_parent.copied_group(
                self.case.source, self.case.volume, self.case.stop, self.case.stop_sha
            ))
            copied = copy_parent._CURRENT_COPY_SCOPE.get()
        else:
            direct_copy = issuer.copy_parent
            copied = direct_copy._CopiedGroupScope(
                self.context, {"receipt_sha256": "9" * 64}
            )
            token = direct_copy._CURRENT_COPY_SCOPE.set(copied)
            self._stack.callback(direct_copy._CURRENT_COPY_SCOPE.reset, token)
        self._stack.enter_context(mock.patch.object(
            issuer, "_load_bound", return_value=(self.context, self.relocated)
        ))
        self._stack.enter_context(mock.patch.object(
            issuer, "select_checkout", side_effect=lambda source, _raw: Path(source)
        ))
        self._stack.enter_context(mock.patch.object(
            issuer.storage, "resolve_layout", return_value=self.layout
        ))
        self._stack.enter_context(mock.patch.object(
            issuer, "compose_project_identity", return_value=self.context["identity"]
        ))
        self._stack.enter_context(mock.patch.object(issuer, "require_relocated"))
        # The root request schema rejects transient storage roots; this fixture
        # uses a private temporary tree only for its tiny terminal/pending files.
        self._stack.enter_context(mock.patch.object(
            issuer.root_admission, "validate_request", side_effect=lambda value: value
        ))
        self._stack.enter_context(mock.patch.object(
            issuer, "_existing_control", return_value=self.control
        ))

        class FixtureFence(copy_fixtures.FakeFence):
            def __init__(fixture, *args, relocated=None):
                super().__init__(*args)
                fixture.relocated = relocated

        self._stack.enter_context(mock.patch.object(
            issuer, "CopyFence", side_effect=FixtureFence
        ))
        self._stack.enter_context(mock.patch.object(
            issuer, "observe_stopped_group", return_value=self.case.snapshot
        ))

        def run_root_admission(fence, _source, _distro, request_path, request_sha, *,
                               retain_native_snapshot=False):
            self.test_case.assertTrue(retain_native_snapshot)
            raw = Path(request_path).read_bytes()
            self.test_case.assertEqual(hashlib.sha256(raw).hexdigest(), request_sha)
            request = json.loads(raw)
            self.test_case.assertEqual(request["token"], self.control.op["receipt"]["attempt"])
            self.test_case.assertTrue(fence.inside)
            self.test_case.assertFalse(fence.released)
            result = {
                "schema": "fullmag.data-volume-linux-admission-result.v1",
                "state": "admission-prepared-not-admitted",
                "volume_id": request["volume_id"],
                "token": request["token"],
                "request_sha256": request_sha,
                "pending_marker": self.pending_ref,
                "namespace_admitted": False,
                "data_migrated": False,
                "originals_retired": False,
            }
            result_raw = (json.dumps(result, sort_keys=True) + "\n").encode()
            self.terminal = {
                "state": "admission-prepared-not-admitted",
                "receipt_sha256": hashlib.sha256(result_raw).hexdigest(),
                "result": result,
            }
            (self.case.op / "linux-admission-started.json").write_text(
                json.dumps({"request_sha256": request_sha}, sort_keys=True) + "\n"
            )
            (self.case.op / "linux-admission-result.json").write_text(
                result_raw.decode()
            )
            self.test_case.assertTrue((self.case.op / "journal.json").is_file())
            fence.finish(self.terminal["receipt_sha256"])
            return self.terminal, self.native_before

        self._stack.enter_context(mock.patch.object(
            issuer, "run_root_admission", side_effect=run_root_admission
        ))
        self.prepared = issuer.prepare_bound_group(copied, self.bound)
        return self.prepared

    def validator_patch(self, issuer=admission_parent):
        module_name = (issuer.__package__ + ".docker_data_volume_admission_job"
                       if issuer.__package__ else "docker_data_volume_admission_job")
        job = importlib.import_module(module_name)
        return mock.patch.object(job, "validate_terminal", return_value=self.terminal)


class StartupScopeContractTests(unittest.TestCase):
    def test_no_active_scope_is_none_and_unscoped_verification_refuses(self):
        self.assertIsNone(startup_scope.current_scope())
        with self.assertRaises(ValueError):
            startup_scope.verify_pending(None, {}, "compose-fixture", {})

    def test_live_issued_scope_verifies_exact_pending_without_granting_authority(self):
        fixture = StartupScopeFixture(self)
        prepared = fixture.issue()
        with fixture.validator_patch() as validator:
            with startup_scope.startup_scope(prepared) as scope:
                self.assertIs(startup_scope.current_scope(), scope)
                result = startup_scope.verify_pending(
                    scope, fixture.layout, "compose-fixture", fixture.pending,
                    state_root=fixture.state_root, user_data_root=fixture.user_root,
                )
                self.assertEqual(result["state"], "pending-prepared-not-registered")
                self.assertFalse(result["namespace_admitted"])
                self.assertFalse(result["data_migrated"])
                self.assertFalse(result["originals_retired"])
                self.assertEqual(result["pending"], fixture.pending)
            validator.assert_called_once()
            self.assertIs(validator.call_args.kwargs["expected_before"], prepared["native_before"])
        self.assertIsNone(startup_scope.current_scope())

    def test_direct_script_issuer_is_resolved_without_a_second_scope_contextvar(self):
        direct = importlib.import_module("docker_dev_data_volume_admission")
        fixture = StartupScopeFixture(self)
        prepared = fixture.issue(direct)
        self.assertEqual(type(prepared).__module__, "docker_dev_data_volume_admission")
        with fixture.validator_patch(direct):
            with startup_scope.startup_scope(prepared) as scope:
                self.assertIs(startup_scope.current_scope(), scope)
                result = startup_scope.verify_pending(
                    scope, fixture.layout, "compose-fixture", fixture.pending
                )
                self.assertEqual(result["state"], "pending-prepared-not-registered")

    def test_layout_group_and_optional_roots_are_exact(self):
        fixture = StartupScopeFixture(self)
        prepared = fixture.issue()
        with fixture.validator_patch(), startup_scope.startup_scope(prepared) as scope:
            wrong_layout = dict(fixture.layout, worktree_id="other-worktree")
            for layout, compose, state, user in (
                (wrong_layout, "compose-fixture", None, None),
                (fixture.layout, "other-compose", None, None),
                (fixture.layout, "compose-fixture", fixture.runtime, None),
                (fixture.layout, "compose-fixture", None, fixture.storage / "user-data/other"),
            ):
                with self.subTest(compose=compose, state=state, user=user), self.assertRaises(ValueError):
                    startup_scope.verify_pending(
                        scope, layout, compose, fixture.pending, state_root=state, user_data_root=user
                    )

    def test_missing_or_changed_pending_bytes_refuse(self):
        fixture = StartupScopeFixture(self)
        prepared = fixture.issue()
        with fixture.validator_patch(), startup_scope.startup_scope(prepared) as scope:
            original = fixture.marker_path.read_bytes()
            fixture.marker_path.unlink()
            with self.assertRaises((ValueError, OSError)):
                startup_scope.verify_pending(scope, fixture.layout, "compose-fixture", fixture.pending)
            fixture.marker_path.write_bytes(original + b" ")
            with self.assertRaises(ValueError):
                startup_scope.verify_pending(scope, fixture.layout, "compose-fixture", fixture.pending)

    def test_symlink_pending_marker_refuses_without_following_target(self):
        fixture = StartupScopeFixture(self)
        prepared = fixture.issue()
        target = fixture.case.op / "foreign-marker.json"
        target.write_text(json.dumps(fixture.pending))
        with fixture.validator_patch(), startup_scope.startup_scope(prepared) as scope:
            fixture.marker_path.unlink()
            fixture.marker_path.symlink_to(target)
            with self.assertRaises((ValueError, OSError)):
                startup_scope.verify_pending(scope, fixture.layout, "compose-fixture", fixture.pending)

    def test_stale_native_snapshot_refuses_before_scope_is_entered(self):
        fixture = StartupScopeFixture(self)
        prepared = fixture.issue()
        job = importlib.import_module("scripts.docker_data_volume_admission_job")
        with mock.patch.object(job, "validate_terminal", side_effect=ValueError("stale native")) as validate:
            with self.assertRaisesRegex(ValueError, "stale native"):
                with startup_scope.startup_scope(prepared):
                    self.fail("stale native state must fail before yielding")
        self.assertIs(validate.call_args.kwargs["expected_before"], prepared["native_before"])
        self.assertIsNone(startup_scope.current_scope())

    def test_admission_terminal_bytes_are_rechecked_during_active_scope(self):
        fixture = StartupScopeFixture(self)
        prepared = fixture.issue()
        result_path = fixture.case.op / "linux-admission-result.json"
        with fixture.validator_patch(), startup_scope.startup_scope(prepared) as scope:
            original = result_path.read_bytes()
            result_path.write_bytes(original + b" ")
            with self.assertRaises(ValueError):
                startup_scope.current_scope()
            result_path.write_bytes(original)
            self.assertIs(startup_scope.current_scope(), scope)

    def test_nested_scope_and_cloned_or_mutated_scope_refuse(self):
        fixture = StartupScopeFixture(self)
        prepared = fixture.issue()
        with fixture.validator_patch(), startup_scope.startup_scope(prepared) as scope:
            with self.assertRaises(ValueError):
                with startup_scope.startup_scope(prepared):
                    pass
            with self.assertRaises((ValueError, AttributeError)):
                startup_scope.verify_pending(copy.copy(scope), fixture.layout, "compose-fixture", fixture.pending)
            with self.assertRaises(AttributeError):
                scope._prepared = {}

    def test_saved_scope_expires_and_prepared_mutation_invalidates_active_scope(self):
        fixture = StartupScopeFixture(self)
        prepared = fixture.issue()
        with fixture.validator_patch(), startup_scope.startup_scope(prepared) as scope:
            self.assertIs(startup_scope.current_scope(), scope)
        with self.assertRaises(ValueError):
            startup_scope.verify_pending(scope, fixture.layout, "compose-fixture", fixture.pending)

        fixture2 = StartupScopeFixture(self)
        prepared2 = fixture2.issue()
        with fixture2.validator_patch(), startup_scope.startup_scope(prepared2):
            original_state = prepared2["terminal"]["state"]
            prepared2["terminal"]["state"] = "changed"
            with self.assertRaises(ValueError):
                startup_scope.current_scope()
            prepared2["terminal"]["state"] = original_state

    def test_active_scope_refuses_context_in_other_thread_and_process(self):
        fixture = StartupScopeFixture(self)
        prepared = fixture.issue()
        with fixture.validator_patch(), startup_scope.startup_scope(prepared) as scope:
            errors = []
            inherited = contextvars.copy_context()

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


if __name__ == "__main__":
    unittest.main()
