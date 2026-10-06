from pathlib import Path
import os
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

import verify_antenna_field_reader as reader


class AntennaReaderFingerprintTests(unittest.TestCase):
    def test_closed_recipe_rejects_extra_commands_and_arguments(self):
        root = Path(__file__).resolve().parents[1]
        bash = (str(Path(os.environ.get("PROGRAMFILES", "C:/Program Files")) / "Git/bin/bash.exe")
                if os.name == "nt" else shutil.which("bash"))
        if not bash or not Path(bash).is_file():
            self.skipTest("repository Bash shell unavailable")
        recipe = (f'python "{root.as_posix()}/scripts/verify_antenna_field_reader.py" '
                  f'--repo-root "{root.as_posix()}"')
        for extra in ("; echo unexpected", " && echo unexpected", " --extra-argument", "\necho unexpected"):
            with self.subTest(extra=extra):
                result = subprocess.run(
                    [bash, "scripts/just_storage_shell.sh", recipe + extra], cwd=root,
                    env={**os.environ, "FULLMAG_STORAGE_PYTHON": sys.executable},
                    capture_output=True, text=True, timeout=15)
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                self.assertIn("invalid antenna field-reader recipe", result.stderr)
                self.assertNotIn("ANTENNA_FIELD_READER_RECEIPT=", result.stdout)

    def test_imported_direct_decoder_changes_reader_fingerprint(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            decoder = "tests/antenna/direct_quadrature_evidence.py"
            for name in (*reader.SOURCES, decoder):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(("fixture:" + name).encode("utf-8"))
            before = reader.fingerprint(root)
            (root / decoder).write_bytes(b"changed independent decoder")
            self.assertNotEqual(before, reader.fingerprint(root))


if __name__ == "__main__":
    unittest.main()
