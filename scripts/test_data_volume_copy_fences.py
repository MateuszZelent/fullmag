import fcntl
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

from scripts import data_volume_copy_fences as fences


class CopyFenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="fullmag-copy-fences-")
        self.root = Path(self.temporary.name)
        self.state_root, self.runtime_control_root, self.ledger_root = self._make_fixture(
            self.root / "fixture"
        )
        self.paths = self._lock_paths(
            self.state_root, self.runtime_control_root, self.ledger_root
        )

    def tearDown(self):
        self.temporary.cleanup()

    @staticmethod
    def _make_fixture(root):
        state_root = root / "state"
        runtime_control_root = root / "runtime-control"
        ledger_root = root / "ledger"
        paths = CopyFenceTests._lock_paths(
            state_root, runtime_control_root, ledger_root
        )
        for path in paths:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"")
        return state_root, runtime_control_root, ledger_root

    @staticmethod
    def _lock_paths(state_root, runtime_control_root, ledger_root):
        owners = runtime_control_root / "runtime-services"
        store = state_root / "runs" / "docker-all" / "session-store"
        return (
            owners / "STARTUP-GATE.lock",
            owners / "LAUNCH.lock",
            owners / "OWNER.lock",
            ledger_root / "WRITER.lock",
            store / "WRITER.lock",
        )

    def _authenticate(self, calls=None, *, check_locked=False):
        calls = [] if calls is None else calls

        def authenticate():
            calls.append(len(calls) + 1)
            if check_locked:
                for path in self.paths:
                    self._assert_locked(path)
            return {"authentication": "ready-to-drained", "call": len(calls)}

        return authenticate, calls

    def _assert_locked(self, path):
        descriptor = os.open(path, os.O_RDONLY)
        try:
            with self.assertRaises(BlockingIOError):
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally:
            os.close(descriptor)

    def _assert_lockable(self, path):
        descriptor = os.open(path, os.O_RDONLY)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        finally:
            os.close(descriptor)

    def test_all_five_real_locks_are_held_across_yield_and_both_auth_calls(self):
        authenticate, calls = self._authenticate(check_locked=True)

        with fences.hold_copy_fences(
            self.state_root,
            self.runtime_control_root,
            self.ledger_root,
            authenticate=authenticate,
        ) as observation:
            for path in self.paths:
                self._assert_locked(path)
            self.assertEqual(calls, [1])
            self.assertEqual(observation["authentication"], {
                "authentication": "ready-to-drained", "call": 1
            })

        self.assertEqual(calls, [1, 2])
        for path in self.paths:
            self._assert_lockable(path)

    def test_lock_observation_order_and_inode_metadata_match_fstat(self):
        authenticate, _ = self._authenticate()
        real_flock = fcntl.flock
        acquired = []

        def recording_flock(descriptor, operation):
            if operation == fcntl.LOCK_EX | fcntl.LOCK_NB:
                info = os.fstat(descriptor)
                acquired.append((info.st_dev, info.st_ino))
            return real_flock(descriptor, operation)

        with patch.object(fences.fcntl, "flock", side_effect=recording_flock):
            with fences.hold_copy_fences(
                self.state_root,
                self.runtime_control_root,
                self.ledger_root,
                authenticate=authenticate,
            ) as observation:
                self.assertEqual(
                    [lock["path"] for lock in observation["locks"]],
                    [str(path) for path in self.paths],
                )
                self.assertEqual(
                    [(lock["device"], lock["inode"]) for lock in observation["locks"]],
                    [(os.stat(path).st_dev, os.stat(path).st_ino) for path in self.paths],
                )
                self.assertEqual(
                    acquired,
                    [(os.stat(path).st_dev, os.stat(path).st_ino) for path in self.paths],
                )
                encoded = json.dumps(observation, sort_keys=True)
                self.assertEqual(json.loads(encoded)["schema"], fences.SCHEMA)
                with self.assertRaises(TypeError):
                    observation["schema"] = "changed"
                with self.assertRaises(TypeError):
                    observation["locks"][0]["inode"] = 0

    def test_contended_middle_lock_refuses_before_auth_and_releases_earlier_locks(self):
        descriptor = os.open(self.paths[2], os.O_RDONLY)
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        calls = []
        try:
            with self.assertRaises(BlockingIOError):
                with fences.hold_copy_fences(
                    self.state_root,
                    self.runtime_control_root,
                    self.ledger_root,
                    authenticate=lambda: calls.append(True),
                ):
                    self.fail("contended lock must prevent yielding")
            self.assertEqual(calls, [])
            for path in self.paths[:2]:
                self._assert_lockable(path)
        finally:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
            os.close(descriptor)

    def test_missing_symlink_hardlink_and_nonregular_locks_are_rejected_without_creation(self):
        for kind in ("missing", "symlink", "hardlink", "directory"):
            with self.subTest(kind=kind):
                case_root = self.root / ("case-" + kind)
                state, runtime_control, ledger = self._make_fixture(case_root)
                paths = self._lock_paths(state, runtime_control, ledger)
                victim = paths[3]
                if kind == "missing":
                    victim.unlink()
                elif kind == "symlink":
                    victim.unlink()
                    victim.symlink_to(paths[0])
                elif kind == "hardlink":
                    os.link(victim, case_root / "extra-link")
                else:
                    victim.unlink()
                    victim.mkdir()
                before = tuple((path, path.exists(), path.is_symlink()) for path in paths)
                with self.assertRaises((OSError, ValueError)):
                    with fences.hold_copy_fences(
                        state,
                        runtime_control,
                        ledger,
                        authenticate=lambda: {"auth": "unused"},
                    ):
                        self.fail("invalid lock set must prevent yielding")
                after = tuple((path, path.exists(), path.is_symlink()) for path in paths)
                self.assertEqual(after, before)

    def test_replacement_during_entry_auth_is_detected_before_yield(self):
        calls = []
        original = self.paths[1]
        moved = original.with_name("LAUNCH.lock.original")

        def replace_during_auth():
            calls.append(True)
            os.replace(original, moved)
            original.write_bytes(b"")
            return {"auth": "proof"}

        with self.assertRaises(ValueError):
            with fences.hold_copy_fences(
                self.state_root,
                self.runtime_control_root,
                self.ledger_root,
                authenticate=replace_during_auth,
            ):
                self.fail("replacement during auth must prevent yielding")
        self.assertEqual(calls, [True])
        self._assert_lockable(moved)
        self._assert_lockable(original)

    def test_replacement_during_body_is_detected_on_exit_and_released(self):
        calls = []
        authenticate, calls = self._authenticate(calls)
        original = self.paths[4]
        moved = original.with_name("WRITER.lock.original")

        with self.assertRaises(ValueError):
            with fences.hold_copy_fences(
                self.state_root,
                self.runtime_control_root,
                self.ledger_root,
                authenticate=authenticate,
            ):
                os.replace(original, moved)
                original.write_bytes(b"")
        self.assertEqual(calls, [1])
        self._assert_lockable(moved)
        self._assert_lockable(original)

    def test_body_exception_is_preserved_when_exit_authentication_fails(self):
        calls = []

        def authenticate():
            calls.append(len(calls) + 1)
            if len(calls) == 2:
                raise ValueError("exit authentication failed")
            return {"auth": "proof"}

        with self.assertRaisesRegex(RuntimeError, "body failed") as raised:
            with fences.hold_copy_fences(
                self.state_root,
                self.runtime_control_root,
                self.ledger_root,
                authenticate=authenticate,
            ):
                raise RuntimeError("body failed")
        self.assertIsInstance(raised.exception.__cause__, ValueError)
        self.assertEqual(calls, [1, 2])
        for path in self.paths:
            self._assert_lockable(path)

    def test_authenticate_must_be_callable_and_boolean_result_is_not_authority(self):
        with self.assertRaises(ValueError):
            with fences.hold_copy_fences(
                self.state_root,
                self.runtime_control_root,
                self.ledger_root,
                authenticate=True,
            ):
                self.fail("boolean must not substitute for authentication")
        for path in self.paths:
            self._assert_lockable(path)

        calls = []
        with self.assertRaises(ValueError):
            with fences.hold_copy_fences(
                self.state_root,
                self.runtime_control_root,
                self.ledger_root,
                authenticate=lambda: calls.append(True) or True,
            ):
                self.fail("boolean authentication result must be refused")
        self.assertEqual(calls, [True])
        for path in self.paths:
            self._assert_lockable(path)


if __name__ == "__main__":
    unittest.main()
