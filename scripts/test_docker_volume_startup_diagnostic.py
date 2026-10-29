"""Validate the non-mutating startup diagnostic inspection boundary."""
from pathlib import Path
from types import SimpleNamespace
import sys
import subprocess
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_volume_startup_diagnostic as diagnostic


class StartupDiagnosticOptionsTests(unittest.TestCase):
    def options(self, **changes):
        values = {"backend_container_id": "a" * 64, "image_id": "sha256:" + "b" * 64,
                  "report": "verification/startup-diagnostic/inspection.json"}
        return SimpleNamespace(**dict(values, **changes))

    def test_complete_immutable_pins_and_control_path_are_accepted(self):
        diagnostic.validate_options(self.options())

    def test_abbreviated_or_malformed_identity_is_rejected(self):
        for changes in ({"backend_container_id": "a" * 12}, {"image_id": "latest"},
                        {"backend_container_id": "A" * 64}, {"image_id": "sha256:" + "z" * 64}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                diagnostic.validate_options(self.options(**changes))

    def test_report_cannot_escape_or_alias_control_verification(self):
        for report in ("/tmp/report.json", "verification/../active", "verification//x.json",
                       "verification/./x.json", "active", "verification/x.txt"):
            with self.subTest(report=report), self.assertRaises(ValueError):
                diagnostic.validate_options(self.options(report=report))


class StartupDiagnosticShellTests(unittest.TestCase):
    def test_composite_command_cannot_use_the_read_only_route(self):
        root = Path(__file__).resolve().parent.parent
        body = (f'python3 "{root}/scripts/docker_volume_startup_diagnostic.py" '
                "--source-root '/checkout' --backend-container-id '" + "a" * 64
                + "' --image-id 'sha256:" + "b" * 64
                + "' --report 'verification/x.json'; echo SHOULD_NOT_EXECUTE")
        result = subprocess.run(["bash", str(root / "scripts/just_storage_shell.sh"), body],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertNotIn("SHOULD_NOT_EXECUTE", result.stdout)
        self.assertIn("invalid read-only startup diagnostic inspection recipe", result.stderr)


if __name__ == "__main__":
    unittest.main()
