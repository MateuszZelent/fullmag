"""Fail-closed pending-cutover marker tests."""

import copy
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from scripts import fullmag_data_volume_guard as guard
from scripts import fullmag_data_volume_pending as pending


class GuardFixture:
    """Compose the existing registration/mount fixture without inheriting tests."""

    def __init__(self, test_case):
        from scripts.test_fullmag_data_volume_guard import RegisteredVolumeGuardTests

        self.case = RegisteredVolumeGuardTests(
            "test_no_index_and_no_registration_is_a_noop"
        )
        self.case.setUp()
        test_case.addCleanup(self.case.tearDown)
        self.case.repo_root = self.case.root / "selected-checkout"
        self.case.repo_root.mkdir()
        self.case.layout["repo_root"] = str(self.case.repo_root)

    def __getattr__(self, name):
        return getattr(self.case, name)

    def marker(self, **overrides):
        value = {
            "schema": pending.SCHEMA,
            "project_id": self.layout["env"]["FULLMAG_PROJECT_ID"],
            "worktree_id": self.layout["worktree_id"],
            "compose_project": self.compose_project,
            "source_root": str(self.repo_root),
            "volume_id": "a" * 32,
            "plan_sha256": "c" * 64,
            "linux_request_sha256": "d" * 64,
            "copy_receipt_sha256": "b" * 64,
            "state_root": str(self.state_root),
            "user_data_root": str(self.user_data_root),
        }
        value.update(overrides)
        return value

    def write_marker(self, value=None, raw=None):
        path = pending.pending_path(self.layout)
        path.parent.mkdir(parents=True, exist_ok=True)
        if raw is None:
            raw = json.dumps(
                value or self.marker(), separators=(",", ":"), allow_nan=False
            ).encode("utf-8")
        path.write_bytes(raw)
        return path, raw

    def write_active_registration(self, registration=None):
        registration = registration or self.registration()
        raw = self._write_registration(registration)
        self._write_index(raw)
        return raw


class PendingMarkerTests(unittest.TestCase):
    def fixture(self):
        return GuardFixture(self)

    def test_explicit_scope_cannot_bypass_absent_pending_or_committed_registration(self):
        fixture = self.fixture()
        fixture._write_index(b'', reference=False)
        with self.assertRaisesRegex(ValueError, 'Prepared migration startup requires'):
            guard.verify_registered_volume(fixture.layout, fixture.compose_project,
                                           migration_scope=object())
        fixture.write_marker()
        fixture.write_active_registration()
        with self.assertRaisesRegex(ValueError, 'Prepared migration startup requires'):
            guard.verify_registered_volume(fixture.layout, fixture.compose_project,
                                           migration_scope=object())

    def test_explicit_scope_still_requires_existing_index_and_valid_registration_reference(self):
        fixture = self.fixture()
        fixture.write_marker()
        with self.assertRaisesRegex(ValueError, 'Prepared migration startup requires'):
            guard.verify_registered_volume(fixture.layout, fixture.compose_project,
                                           migration_scope=object())
        fixture._write_index(b'', reference=False)
        before = fixture.index_path.read_bytes()
        document = json.loads(before)
        document['data_volume_registration'] = {'path': 'foreign'}
        fixture.index_path.write_text(json.dumps(document))
        with self.assertRaisesRegex(ValueError, 'open or incomplete'):
            guard.verify_registered_volume(fixture.layout, fixture.compose_project,
                                           migration_scope=object())

    def test_launcher_passes_only_the_current_internal_scope_to_the_volume_guard(self):
        from scripts import docker_dev as launcher
        import docker_data_volume_startup_scope as startup
        scope = object()
        with patch.object(startup, 'current_scope', return_value=scope), \
             patch('fullmag_data_volume_guard.verify_registered_volume', return_value={'fixture': 'verified'}) as verify:
            result = launcher._verify_registered_data_volume({'layout': 'fixture'}, 'project',
                state_root=Path('/canonical/state'), user_data_root=Path('/canonical/user'))
        self.assertEqual(result, {'fixture': 'verified'})
        verify.assert_called_once_with({'layout': 'fixture'}, 'project',
            state_root=Path('/canonical/state'), user_data_root=Path('/canonical/user'), migration_scope=scope)

    def test_live_prepared_handoff_is_scoped_and_ordinary_startup_stays_blocked(self):
        import docker_data_volume_startup_scope as startup
        from scripts.test_docker_data_volume_startup_scope import StartupScopeFixture
        fixture = StartupScopeFixture(self)
        prepared = fixture.issue()
        index_path = Path(fixture.layout['storage_root']) / 'index' / (fixture.layout['worktree_id'] + '.json')
        index_path.write_text(json.dumps({'schema': 'fullmag.worktree.v1',
                                         'worktree_id': fixture.layout['worktree_id']}))
        with fixture.validator_patch(), startup.startup_scope(prepared) as scope:
            result = guard.verify_registered_volume(fixture.layout, 'compose-fixture',
                state_root=fixture.state_root, user_data_root=fixture.user_root, migration_scope=scope)
            self.assertEqual(result['state'], 'pending-prepared-not-registered')
            self.assertFalse(result['namespace_admitted'])
            with self.assertRaisesRegex(ValueError, 'Pending data-volume migration'):
                guard.verify_registered_volume(fixture.layout, 'compose-fixture')
        with self.assertRaisesRegex(ValueError, 'active startup-scope'):
            guard.verify_registered_volume(fixture.layout, 'compose-fixture', migration_scope=scope)

    def test_pending_path_does_not_create_directories(self):
        fixture = self.fixture()
        path = pending.pending_path(fixture.layout)

        self.assertEqual(
            path,
            fixture.storage / "index" / "data-volumes" / "test-wt.pending.json",
        )
        self.assertFalse(path.parent.exists())

    def test_no_marker_and_no_registration_remains_noop(self):
        fixture = self.fixture()
        path = pending.pending_path(fixture.layout)
        with patch.object(guard, "_observe_mount") as observe_mount, patch.object(
            guard, "_observe_directory"
        ) as observe_directory:
            self.assertIsNone(
                guard.verify_registered_volume(fixture.layout, fixture.compose_project)
            )

        observe_mount.assert_not_called()
        observe_directory.assert_not_called()
        self.assertFalse(path.exists())
        self.assertFalse(path.parent.exists())

    def test_valid_pending_without_registration_blocks_before_mount_probe(self):
        fixture = self.fixture()
        path, before = fixture.write_marker()
        with patch.object(guard, "_observe_mount") as observe_mount, patch.object(
            guard, "_observe_directory"
        ) as observe_directory:
            with self.assertRaisesRegex(ValueError, "Pending data-volume migration"):
                guard.verify_registered_volume(fixture.layout, fixture.compose_project)

        observe_mount.assert_not_called()
        observe_directory.assert_not_called()
        self.assertEqual(path.read_bytes(), before)

    def test_validate_pending_rejects_open_foreign_and_drifted_scope(self):
        fixture = self.fixture()
        valid = fixture.marker()
        invalid = {
            "unknown field": lambda value: value.update(unexpected=True),
            "foreign project": lambda value: value.update(project_id="fullmag-fedcba9876543210"),
            "foreign worktree": lambda value: value.update(worktree_id="other-wt"),
            "foreign group": lambda value: value.update(compose_project="fullmag-worktree-other-wt"),
            "foreign source": lambda value: value.update(source_root=str(fixture.storage)),
            "boolean identity": lambda value: value.update(volume_id=True),
            "invalid digest": lambda value: value.update(plan_sha256="not-a-sha"),
            "drifted state root": lambda value: value.update(state_root=str(fixture.storage)),
            "drifted user root": lambda value: value.update(user_data_root=str(fixture.root / "other-user-data")),
        }
        for name, mutate in invalid.items():
            with self.subTest(case=name):
                value = copy.deepcopy(valid)
                mutate(value)
                with self.assertRaises(ValueError):
                    pending.validate_pending(value, fixture.layout, fixture.compose_project)

    def test_read_pending_rejects_symlink_malformed_and_unbounded_json(self):
        cases = ("symlink", "malformed", "unbounded")
        for case in cases:
            with self.subTest(case=case):
                fixture = self.fixture()
                path = pending.pending_path(fixture.layout)
                path.parent.mkdir(parents=True, exist_ok=True)
                if case == "symlink":
                    target = fixture.root / "marker-target.json"
                    target.write_bytes(json.dumps(fixture.marker()).encode("utf-8"))
                    path.symlink_to(target)
                elif case == "malformed":
                    path.write_bytes(b'{"schema":')
                else:
                    path.write_bytes(b" " * (pending.MAX_BYTES + 1))
                with self.assertRaises((OSError, ValueError)):
                    pending.read_pending(fixture.layout, fixture.compose_project)

    def test_registration_for_another_volume_does_not_resolve_pending(self):
        fixture = self.fixture()
        path, before = fixture.write_marker()
        registration = fixture.registration()
        registration["volume_id"] = "e" * 32
        raw = fixture._write_registration(registration)
        fixture._write_index(raw)
        index = json.loads(fixture.index_path.read_text(encoding="utf-8"))
        index["data_volume_registration"]["volume_id"] = registration["volume_id"]
        fixture.index_path.write_text(json.dumps(index), encoding="utf-8")

        with patch.object(guard, "_observe_mount") as observe_mount, patch.object(
            guard, "_observe_directory"
        ) as observe_directory:
            with self.assertRaisesRegex(ValueError, "does not resolve this pending"):
                guard.verify_registered_volume(fixture.layout, fixture.compose_project)

        observe_mount.assert_not_called()
        observe_directory.assert_not_called()
        self.assertEqual(path.read_bytes(), before)

    def test_matching_committed_registration_keeps_mount_guards_and_marker(self):
        fixture = self.fixture()
        path, before = fixture.write_marker()
        fixture.write_active_registration()
        mount_patch, directory_patch = fixture._probe_mocks()
        with mount_patch as observe_mount, directory_patch as observe_directory:
            result = guard.verify_registered_volume(fixture.layout, fixture.compose_project)

        self.assertEqual(result["state"], "verified")
        self.assertGreater(observe_mount.call_count, 0)
        self.assertGreater(observe_directory.call_count, 0)
        self.assertEqual(path.read_bytes(), before)

    def test_matching_registration_still_fails_when_mount_guard_fails(self):
        fixture = self.fixture()
        path, before = fixture.write_marker()
        fixture.write_active_registration()
        with patch.object(guard, "_observe_mount", side_effect=ValueError("mount absent")) as observe_mount, \
                patch.object(guard, "_observe_directory") as observe_directory:
            with self.assertRaisesRegex(ValueError, "mount absent"):
                guard.verify_registered_volume(fixture.layout, fixture.compose_project)

        self.assertEqual(observe_mount.call_count, 1)
        observe_directory.assert_not_called()
        self.assertEqual(path.read_bytes(), before)

    def test_second_ordinary_worktree_is_not_blocked_by_first_marker(self):
        fixture = self.fixture()
        marker_path, before = fixture.write_marker()
        other_layout = copy.deepcopy(fixture.layout)
        other_layout["worktree_id"] = "other-wt"
        other_layout["runtime_root"] = str(fixture.storage / "runtimes" / "other-wt")
        other_project = "fullmag-worktree-other-wt"
        other_path = pending.pending_path(other_layout)

        with patch.object(guard, "_observe_mount") as observe_mount, patch.object(
            guard, "_observe_directory"
        ) as observe_directory:
            self.assertIsNone(guard.verify_registered_volume(other_layout, other_project))

        observe_mount.assert_not_called()
        observe_directory.assert_not_called()
        self.assertFalse(other_path.exists())
        self.assertEqual(marker_path.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
