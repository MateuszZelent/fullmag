import unittest
from pathlib import Path
import run_nonzero_k_validation_controller as controller


class ControllerTests(unittest.TestCase):
    def test_python_children_disable_bytecode(self):
        command = controller.python_command(Path("capsule/script.py"), "--job-id", "123")
        self.assertEqual(command[1], "-B")
        self.assertEqual(controller.child_environment()["PYTHONDONTWRITEBYTECODE"], "1")

    def test_import_does_not_mutate_immutable_source_tree(self):
        import tempfile
        import subprocess
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "dependency.py").write_text("value = 42", encoding="utf-8")
            entry = root / "entry.py"
            entry.write_text("import dependency; assert dependency.value == 42", encoding="utf-8")
            before = {str(p.relative_to(root)): p.read_bytes() for p in root.rglob("*") if p.is_file()}
            result = subprocess.run(controller.python_command(entry), env=controller.child_environment(), capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            after = {str(p.relative_to(root)): p.read_bytes() for p in root.rglob("*") if p.is_file()}
            self.assertEqual(before, after)
            self.assertFalse((root / "__pycache__").exists())

    def test_blocked_is_terminal_and_source_identity_must_match(self):
        config = {"job_id": "one", "source_digest": "pinned"}
        data = {**config, "state": "blocked"}
        self.assertIn(controller.build_state(data, config), controller.TERMINAL_FAILURES)
        for key in ("job_id", "source_digest"):
            with self.subTest(key=key), self.assertRaises(ValueError):
                controller.build_state({**data, key: "different"}, config)

    def test_success_requires_exit_zero(self):
        config = {"job_id": "one", "source_digest": "pinned"}
        for code in (None, 1):
            with self.subTest(code=code), self.assertRaises(ValueError):
                controller.build_state({**config, "state": "succeeded", "exit_code": code}, config)
        self.assertEqual(controller.build_state({**config, "state": "succeeded", "exit_code": 0}, config), "succeeded")


if __name__ == "__main__": unittest.main()
