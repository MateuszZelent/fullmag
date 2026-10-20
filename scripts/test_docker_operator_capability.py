"""Source-level tests for the private direct-DEV backend operator capability."""

import importlib.util
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import Mock, patch


ENTRYPOINT = Path(__file__).resolve().parents[1] / "docker/all-in-one/entrypoint.py"
SPEC = importlib.util.spec_from_file_location("fullmag_docker_entrypoint_operator_test", ENTRYPOINT)
assert SPEC.loader is not None
entrypoint = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(entrypoint)


class OperatorCapabilityTests(unittest.TestCase):
    def _environment(self):
        return {
            "FULLMAG_DOCKER_ROLE": "backend",
            "FULLMAG_BUILD_CONTROL_VOLUME": "fullmag-build-control-test",
        }

    def _control_root(self, directory):
        root = Path(directory) / "backend"
        root.mkdir(mode=0o700)
        return root

    def test_direct_dev_rotation_and_bounded_read(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, self._environment(), clear=True), \
                patch.object(entrypoint.secrets, "token_hex", side_effect=("a" * 32, "b" * 32)):
            root = self._control_root(directory)
            first = entrypoint.prepare_operator_capability(root)
            path = entrypoint.operator_capability_path(root)
            self.assertEqual(first, "a" * 32)
            self.assertEqual(entrypoint.read_operator_capability(root), first)
            self.assertTrue(stat.S_ISDIR(path.parent.stat().st_mode))
            self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(path.stat().st_nlink, 1)
            self.assertEqual(path.stat().st_uid, os.getuid())

            second = entrypoint.prepare_operator_capability(root)
            self.assertEqual(second, "b" * 32)
            self.assertNotEqual(first, second)
            self.assertEqual(entrypoint.read_operator_capability(root), second)
            self.assertEqual(path.read_bytes(), (second + "\n").encode("ascii"))

    def test_api_child_gets_token_without_parent_environment_mutation(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, self._environment(), clear=True):
            root = self._control_root(directory)
            parent_environment = {
                "FULLMAG_DOCKER_ROLE": "backend",
                "FULLMAG_BUILD_CONTROL_VOLUME": "fullmag-build-control-test",
                entrypoint.OPERATOR_CAPABILITY_ENV: "host-supplied-token-must-not-pass",
            }
            before = dict(parent_environment)
            child_environment = entrypoint._api_environment_with_operator_capability(
                parent_environment, root
            )
            popen = Mock()
            popen(env=child_environment)
            supplied = popen.call_args.kwargs["env"]
            self.assertEqual(parent_environment, before)
            self.assertIsNot(supplied, parent_environment)
            self.assertRegex(supplied[entrypoint.OPERATOR_CAPABILITY_ENV], r"^[0-9a-f]{32}$")
            self.assertNotIn(entrypoint.OPERATOR_CAPABILITY_ENV, os.environ)
            self.assertNotIn("host-supplied-token-must-not-pass", supplied.values())

    def test_frozen_or_non_backend_modes_preserve_environment_without_publishing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self._control_root(directory)
            with patch.dict(os.environ, {"FULLMAG_DOCKER_ROLE": "frontend"}, clear=True):
                self.assertIsNone(entrypoint.prepare_operator_capability(root))
                frozen_environment = {entrypoint.OPERATOR_CAPABILITY_ENV: "legacy"}
                self.assertEqual(
                    entrypoint._api_environment_with_operator_capability(frozen_environment, root),
                    frozen_environment,
                )
            self.assertFalse((root / entrypoint.OPERATOR_CAPABILITY_DIRNAME).exists())

            with patch.dict(os.environ, {"FULLMAG_DOCKER_ROLE": "backend"}, clear=True):
                self.assertIsNone(entrypoint.prepare_operator_capability(root))

    def test_failed_temp_fsync_cleans_only_own_temp_and_keeps_old_token(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, self._environment(), clear=True):
            root = self._control_root(directory)
            old_token = entrypoint.prepare_operator_capability(root)
            path = entrypoint.operator_capability_path(root)
            with patch.object(entrypoint.os, "fsync", side_effect=OSError("injected fsync failure")):
                with self.assertRaisesRegex(RuntimeError, "cannot be published"):
                    entrypoint.prepare_operator_capability(root)
            self.assertEqual(path.read_bytes(), (old_token + "\n").encode("ascii"))
            self.assertEqual(list(path.parent.glob(f".{path.name}.*.tmp")), [])

    def test_environment_operator_token_injection_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(
                os.environ,
                {
                    **self._environment(),
                    entrypoint.OPERATOR_CAPABILITY_ENV: "host-supplied-token",
                },
                clear=True,
        ):
            with self.assertRaisesRegex(RuntimeError, "must not be supplied"):
                entrypoint._api_environment_with_operator_capability({}, self._control_root(directory))

    def test_invalid_control_volume_fails_closed_when_backend_gate_is_selected(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(
                os.environ,
                {"FULLMAG_DOCKER_ROLE": "backend", "FULLMAG_BUILD_CONTROL_VOLUME": "/host/path"},
                clear=True,
        ):
            with self.assertRaisesRegex(RuntimeError, "FULLMAG_BUILD_CONTROL_VOLUME"):
                entrypoint.prepare_operator_capability(self._control_root(directory))

    def test_existing_mode_conflict_is_not_replaced(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, self._environment(), clear=True):
            root = self._control_root(directory)
            token = entrypoint.prepare_operator_capability(root)
            path = entrypoint.operator_capability_path(root)
            original = path.read_bytes()
            path.chmod(0o644)
            with self.assertRaisesRegex(RuntimeError, "private regular"):
                entrypoint.prepare_operator_capability(root)
            self.assertEqual(path.read_bytes(), original)

    def test_symlink_and_hardlink_conflicts_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, self._environment(), clear=True):
            root = self._control_root(directory)
            entrypoint.prepare_operator_capability(root)
            path = entrypoint.operator_capability_path(root)
            payload = path.read_bytes()

            path.unlink()
            target = path.parent / "outside-token"
            target.write_bytes(b"foreign")
            os.symlink(target, path)
            with self.assertRaisesRegex(RuntimeError, "private regular"):
                entrypoint.prepare_operator_capability(root)
            self.assertTrue(path.is_symlink())
            path.unlink()

            path.write_bytes(payload)
            path.chmod(0o600)
            sibling = path.parent / "hardlink"
            os.link(path, sibling)
            with self.assertRaisesRegex(RuntimeError, "private regular"):
                entrypoint.prepare_operator_capability(root)
            self.assertEqual(path.read_bytes(), payload)
            sibling.unlink()

    def test_malformed_token_is_rejected_by_reader(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, self._environment(), clear=True):
            root = self._control_root(directory)
            entrypoint.prepare_operator_capability(root)
            path = entrypoint.operator_capability_path(root)
            path.write_bytes(b"A" * 32 + b"\n")
            with self.assertRaisesRegex(RuntimeError, "invalid format"):
                entrypoint.read_operator_capability(root)

    def test_temp_name_collision_does_not_remove_foreign_file(self):
        class FixedUuid:
            hex = "collision"

        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, self._environment(), clear=True):
            root = self._control_root(directory)
            path = entrypoint.operator_capability_path(root)
            path.parent.mkdir(mode=0o700)
            collision = path.parent / ".token.collision.tmp"
            collision.write_bytes(b"foreign-temporary")
            with patch.object(entrypoint.uuid, "uuid4", return_value=FixedUuid()):
                with self.assertRaisesRegex(RuntimeError, "cannot be published"):
                    entrypoint.prepare_operator_capability(root)
            self.assertEqual(collision.read_bytes(), b"foreign-temporary")

    @unittest.skipUnless(hasattr(os, "chown") and getattr(os, "geteuid", lambda: 1)() == 0,
                         "foreign-owner check requires a privileged Unix test process")
    def test_foreign_owner_is_rejected_before_rotation(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, self._environment(), clear=True):
            root = self._control_root(directory)
            entrypoint.prepare_operator_capability(root)
            path = entrypoint.operator_capability_path(root)
            original_uid = os.getuid()
            original_gid = os.getgid()
            os.chown(path, 1, -1)
            try:
                with self.assertRaisesRegex(RuntimeError, "private regular"):
                    entrypoint.prepare_operator_capability(root)
            finally:
                os.chown(path, original_uid, original_gid)


if __name__ == "__main__":
    unittest.main()
