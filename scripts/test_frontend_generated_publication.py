import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
import verify_control_room_sources as checks
import fullmag_storage as storage

class PublicationTests(unittest.TestCase):
    def test_publish_only_expected_outputs_and_preserve_json(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory).resolve() / "repo"
            staged = Path(directory).resolve() / "staged"
            target = repo / "apps/control-room/src/kernel/api/generated"
            target.mkdir(parents=True)
            source = staged / "src/kernel/api/generated"
            source.mkdir(parents=True)
            for name in checks.GENERATED_OUTPUTS:
                (target/name).write_bytes(b"old")
                (source/name).write_bytes(b"new")
            (target/"openapi-v2.json").write_bytes(b"preserve")
            before = checks.generated_output_state(repo)
            checks.publish_generated_outputs(repo, staged, before)
            self.assertTrue(all((target/name).read_bytes() == b"new" for name in checks.GENERATED_OUTPUTS))
            self.assertEqual((target/"openapi-v2.json").read_bytes(), b"preserve")

    def test_concurrent_edit_prevents_all_publication(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory).resolve() / "repo"
            staged = Path(directory).resolve() / "staged"
            target = repo / "apps/control-room/src/kernel/api/generated"
            target.mkdir(parents=True)
            source = staged / "src/kernel/api/generated"
            source.mkdir(parents=True)
            for name in checks.GENERATED_OUTPUTS:
                (target/name).write_bytes(b"old")
                (source/name).write_bytes(b"new")
            before = checks.generated_output_state(repo)
            (target/checks.GENERATED_OUTPUTS[-1]).write_bytes(b"user edit")
            with self.assertRaises(storage.StorageError):
                checks.publish_generated_outputs(repo, staged, before)
            self.assertEqual((target/checks.GENERATED_OUTPUTS[0]).read_bytes(), b"old")
            self.assertEqual((target/checks.GENERATED_OUTPUTS[-1]).read_bytes(), b"user edit")

    def test_incomplete_generator_outputs_do_not_replace_any_file(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory).resolve() / "repo"
            staged = Path(directory).resolve() / "staged"
            target = repo / "apps/control-room/src/kernel/api/generated"
            target.mkdir(parents=True)
            source = staged / "src/kernel/api/generated"
            source.mkdir(parents=True)
            for name in checks.GENERATED_OUTPUTS:
                (target/name).write_bytes(b"old")
            (source/checks.GENERATED_OUTPUTS[0]).write_bytes(b"new")
            before = checks.generated_output_state(repo)
            with self.assertRaises(storage.StorageError):
                checks.publish_generated_outputs(repo, staged, before)
            self.assertTrue(all((target/name).read_bytes() == b"old" for name in checks.GENERATED_OUTPUTS))

    def test_edit_while_reading_staged_outputs_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory).resolve() / "repo"
            staged = Path(directory).resolve() / "staged"
            target = repo / "apps/control-room/src/kernel/api/generated"
            target.mkdir(parents=True)
            source = staged / "src/kernel/api/generated"
            source.mkdir(parents=True)
            for name in checks.GENERATED_OUTPUTS:
                (target/name).write_bytes(b"old")
                (source/name).write_bytes(b"new")
            before = checks.generated_output_state(repo)
            real_read = Path.read_bytes
            edited = False
            def read_with_concurrent_edit(path):
                nonlocal edited
                value = real_read(path)
                if path == source/checks.GENERATED_OUTPUTS[0] and not edited:
                    edited = True
                    (target/checks.GENERATED_OUTPUTS[-1]).write_bytes(b"concurrent user edit")
                return value
            with patch.object(Path, "read_bytes", read_with_concurrent_edit):
                with self.assertRaises(storage.StorageError):
                    checks.publish_generated_outputs(repo, staged, before)
            self.assertTrue(edited)
            self.assertEqual((target/checks.GENERATED_OUTPUTS[0]).read_bytes(), b"old")
            self.assertEqual((target/checks.GENERATED_OUTPUTS[-1]).read_bytes(), b"concurrent user edit")
            self.assertEqual(list(target.glob(".*.tmp")), [])
