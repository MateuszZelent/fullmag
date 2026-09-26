import os
import subprocess
import sys
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("audit_refactor_p3a.py")


class AuditRefactorP3aOutputTests(unittest.TestCase):
    def test_cli_writes_unicode_inventory_with_legacy_windows_encoding(self):
        environment = os.environ.copy()
        environment["PYTHONIOENCODING"] = "cp1250"

        result = subprocess.run(
            [sys.executable, str(SCRIPT)],
            capture_output=True,
            env=environment,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr.decode("cp1250", errors="replace"))
        output = result.stdout.decode("utf-8")
        self.assertIn("→", output)
        self.assertIn("Operacje:", output)


if __name__ == "__main__":
    unittest.main()
