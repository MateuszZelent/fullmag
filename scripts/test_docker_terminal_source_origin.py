"""Tests for an optional terminal probe source-origin witness."""

from __future__ import annotations

import hashlib
import io
import json
import os
import sys
import tempfile
import unittest
import urllib.request
from email.message import Message
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_terminal_source_origin as source_origin
import docker_volume_dev as dev


class TerminalSourceOriginTests(unittest.TestCase):
    @unittest.skipUnless(source_origin._supports_safe_openat(), "requires Linux no-follow openat")
    def test_user_file_capture_returns_closed_hash_and_size_witness(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            script = root / "examples" / "case.py"
            script.parent.mkdir()
            raw = b"study = fm.Study()\n"
            script.write_bytes(raw)

            witness = source_origin.capture_source_origin(
                {"origin": "user_file", "path": str(script)}, source_root=root
            )

            self.assertEqual(
                witness,
                {
                    "schema": "fullmag.selected-script-origin.v1",
                    "source_relative": "examples/case.py",
                    "source_sha256": hashlib.sha256(raw).hexdigest(),
                    "source_size_bytes": len(raw),
                },
            )

    @unittest.skipUnless(source_origin._supports_safe_openat(), "requires Linux no-follow openat")
    def test_missing_generated_and_outside_script_are_unsupported(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            path = root / "examples" / "case.py"
            path.parent.mkdir()
            path.write_text("pass\n", encoding="utf-8")
            self.assertIsNone(source_origin.capture_source_origin(None, source_root=root))
            self.assertIsNone(source_origin.capture_source_origin({}, source_root=root))
            self.assertIsNone(source_origin.capture_source_origin(
                {"origin": "generated", "path": str(path)}, source_root=root))
            self.assertIsNone(source_origin.capture_source_origin(
                {"origin": "user_file", "path": str(path)}, source_root=root / "selected"))

    def test_source_origin_dto_is_closed_and_uses_portable_repository_paths(self):
        valid = {
            "schema": "fullmag.selected-script-origin.v1",
            "source_relative": "examples/café model.py",
            "source_sha256": "a" * 64,
            "source_size_bytes": 1,
        }
        self.assertIsNone(source_origin.validate_source_origin(None))
        self.assertEqual(source_origin.validate_source_origin(valid), valid)
        invalid = [
            {**valid, "extra": 1},
            {**valid, "source_size_bytes": True},
            {**valid, "source_size_bytes": 0},
            {**valid, "source_size_bytes": 64 * 1024 * 1024 + 1},
            {**valid, "source_sha256": "A" * 64},
            {**valid, "source_relative": "../case.py"},
            {**valid, "source_relative": "examples//case.py"},
            {**valid, "source_relative": "examples/CON.txt"},
            {**valid, "source_relative": "examples/CON .txt"},
            {**valid, "source_relative": "examples/COM1.py"},
            {**valid, "source_relative": "examples/LPT³.py"},
            {**valid, "source_relative": "examples/trailing."},
            {**valid, "source_relative": "examples/trailing "},
            {**valid, "source_relative": "examples/bad?.py"},
            {**valid, "source_relative": "examples/bad\\path.py"},
            {**valid, "source_relative": "examples/bad\npath.py"},
            {**valid, "source_relative": "/absolute.py"},
            {**valid, "source_relative": "examples/"},
            {**valid, "source_relative": "/".join(["a" * 255] * 5)},
        ]
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                source_origin.validate_source_origin(value)

    @unittest.skipUnless(source_origin._supports_safe_openat(), "requires Linux no-follow openat")
    def test_symlink_components_and_nonregular_files_are_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            real = root / "real"
            real.mkdir()
            (real / "case.py").write_text("pass\n", encoding="utf-8")
            (root / "linked-dir").symlink_to(real, target_is_directory=True)
            (root / "linked.py").symlink_to(real / "case.py")
            for relative in ("linked-dir/case.py", "linked.py"):
                with self.subTest(relative=relative), self.assertRaises((OSError, ValueError)):
                    source_origin.capture_source_origin(
                        {"origin": "user_file", "path": str(root / relative)}, source_root=root)
            with self.assertRaises((OSError, ValueError)):
                source_origin.capture_source_origin(
                    {"origin": "user_file", "path": str(real)}, source_root=root)

    @unittest.skipUnless(source_origin._supports_safe_openat(), "requires Linux no-follow openat")
    def test_symlink_selected_root_is_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            real = base / "real"
            real.mkdir()
            (real / "case.py").write_text("pass\n", encoding="utf-8")
            selected = base / "selected"
            selected.symlink_to(real, target_is_directory=True)
            with self.assertRaises(OSError):
                source_origin.capture_source_origin(
                    {"origin": "user_file", "path": str(selected / "case.py")},
                    source_root=selected)

    @unittest.skipUnless(source_origin._supports_safe_openat(), "requires Linux no-follow openat")
    def test_hardlinked_file_and_oversized_file_are_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            first = root / "first.py"
            first.write_bytes(b"pass\n")
            second = root / "second.py"
            os.link(first, second)
            with self.assertRaises((OSError, ValueError)):
                source_origin.capture_source_origin(
                    {"origin": "user_file", "path": str(first)}, source_root=root)
            large = root / "large.py"
            with large.open("wb") as output:
                output.truncate(64 * 1024 * 1024 + 1)
            with self.assertRaises((OSError, ValueError)):
                source_origin.capture_source_origin(
                    {"origin": "user_file", "path": str(large)}, source_root=root)

    @unittest.skipUnless(source_origin._supports_safe_openat(), "requires Linux no-follow openat")
    def test_revalidation_detects_changed_bytes_even_if_size_and_mtime_are_restored(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            script = root / "case.py"
            script.write_bytes(b"first\n")
            summary = {"origin": "user_file", "path": str(script)}
            witness = source_origin.capture_source_origin(summary, source_root=root)
            before = script.stat()
            script.write_bytes(b"other\n")
            os.utime(script, ns=(before.st_atime_ns, before.st_mtime_ns))
            with self.assertRaises((OSError, ValueError)):
                source_origin.revalidate_source_origin(witness, summary, root=root)

    @unittest.skipUnless(source_origin._supports_safe_openat(), "requires Linux no-follow openat")
    def test_none_revalidation_refuses_if_a_user_file_appears(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            script = {"origin": "generated", "path": str(root / "generated.py")}
            self.assertIsNone(source_origin.revalidate_source_origin(None, script, root=root))
            user_file = {"origin": "user_file", "path": str(root / "new.py")}
            (root / "new.py").write_text("pass\n", encoding="utf-8")
            with self.assertRaises((OSError, ValueError)):
                source_origin.revalidate_source_origin(None, user_file, root=root)


class TerminalProbeSourceOriginTests(unittest.TestCase):
    API_INSTANCE = "01234567-89ab-4def-8123-0123456789ab"
    WITNESS = {
        "schema": "fullmag.selected-script-origin.v1",
        "source_relative": "examples/case.py",
        "source_sha256": "a" * 64,
        "source_size_bytes": 6,
    }

    def run_probe(self, capture, revalidate, *, after_script=None):
        script = {"origin": "user_file", "path": "/opt/fullmag/source/examples/case.py",
                  "writable": False}
        run = {"run_id": "run-a", "session_id": "session-a", "status": "completed", "revision": 3}
        status = {
            "session": {"session_id": "session-a", "session_epoch": "session-a@1",
                        "request_scope_epoch": f"{self.API_INSTANCE}:1", "script": script},
            "run": {"run_id": "run-a"}, "solver": {"state": "idle"},
            "resources": {"scene_revision": 7},
        }
        after_status = dict(status)
        after_status["session"] = dict(status["session"])
        if after_script is not None:
            after_status["session"]["script"] = after_script
        endpoints = [
            ("/v2/sessions/current/status", status),
            ("/v2/sessions/current/simulation/runs/current", run),
            ("/v2/platform/compute/queue", {
                "schema_version": "compute_queue.v1", "next_cursor": None, "items": []}),
            ("/v2/platform/runtime-service", {"configured": True, "state": "ready"}),
            ("/v2/sessions/current/status", after_status),
            ("/v2/sessions/current/simulation/runs/current", run),
        ]
        cursor = 0

        def open_response(request, *, timeout):
            nonlocal cursor
            expected_path, value = endpoints[cursor]
            cursor += 1
            self.assertEqual(request.full_url.removeprefix("http://127.0.0.1:8081"), expected_path)
            stream = io.BytesIO(json.dumps(value).encode())
            stream.headers = Message()
            stream.headers["x-fullmag-api-instance"] = self.API_INSTANCE
            stream.status = 200
            return stream

        fake_module = type(sys)("docker_terminal_source_origin")
        fake_module.capture_source_origin = capture
        fake_module.revalidate_source_origin = revalidate
        output = io.StringIO()
        with patch.dict(sys.modules, {"docker_terminal_source_origin": fake_module}), \
             patch.object(urllib.request, "urlopen", side_effect=open_response), \
             patch.object(dev, "docker_text", side_effect=lambda *args: self._execute_probe(args, output)):
            result = dev._terminal_session_restart_probe("e" * 64)
        self.assertEqual(cursor, len(endpoints))
        return result

    @staticmethod
    def _execute_probe(args, output):
        from contextlib import redirect_stdout
        with redirect_stdout(output):
            exec(compile(args[-1], "<terminal-source-origin-probe>", "exec"), {})
        return output.getvalue()

    def test_terminal_preflight_pins_same_scope_script_origin(self):
        capture_calls = []
        revalidate_calls = []

        def capture(script, *, source_root):
            capture_calls.append((script, str(source_root)))
            return dict(self.WITNESS)

        def revalidate(witness, script, *, root):
            revalidate_calls.append((witness, script, str(root)))
            return dict(self.WITNESS)

        result = self.run_probe(capture, revalidate)
        self.assertEqual(result["source_origin"], self.WITNESS)
        self.assertEqual(len(capture_calls), 1)
        self.assertEqual(len(revalidate_calls), 1)

    def test_unsupported_origin_keeps_legacy_preflight_shape(self):
        result = self.run_probe(lambda script, *, source_root: None,
                                lambda witness, script, *, root: None)
        self.assertNotIn("source_origin", result)

    def test_origin_change_during_probe_refuses_preflight(self):
        def capture(script, *, source_root):
            return dict(self.WITNESS)

        def revalidate(witness, script, *, root):
            raise ValueError("selected script changed")

        with self.assertRaisesRegex(RuntimeError, "source origin"):
            self.run_probe(capture, revalidate)

    def test_script_path_change_between_status_reads_refuses_preflight(self):
        changed = {"origin": "user_file", "path": "/opt/fullmag/source/examples/other.py",
                   "writable": False}
        with self.assertRaisesRegex(RuntimeError, "script path changed"):
            self.run_probe(lambda script, *, source_root: dict(self.WITNESS),
                           lambda witness, script, *, root: dict(self.WITNESS),
                           after_script=changed)


if __name__ == "__main__":
    unittest.main()
