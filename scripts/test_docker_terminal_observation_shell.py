"""Exercise terminal observation recipe dispatch without starting Docker."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class TerminalObservationShellTests(unittest.TestCase):
    def dispatch(self, suffix):
        text = (Path(__file__).parent / "just_storage_shell.sh").read_text()
        body = text.split('  *"scripts/docker_dev.py"*)\n', 1)[1].split('\n    ;;', 1)[0]
        recipe = (f"python \"/ignored/scripts/docker_dev.py\" --repo-root \"/registered/repo\" "
                  f"recreate-volume --attempt '{'a'*32}' --config-sha256 '{'b'*64}' "
                  f"--source-root '/registered/task' --port '3203'{suffix}")
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "docker_dev.py").write_text(
                "import json,sys; print(json.dumps(sys.argv[1:]))\n")
            program = ('set -euo pipefail\nrecipe="$RECIPE"\npython_cmd="$PYTHON"\n'
                       'script_dir="$SCRIPTS"\nrepo_root="/registered/repo"\n' + body)
            return subprocess.run(["bash", "--noprofile", "--norc", "-c", program],
                                  env={**os.environ, "RECIPE": recipe, "PYTHON": sys.executable,
                                       "SCRIPTS": directory}, capture_output=True, text=True, timeout=15)

    def test_exact_pair_reaches_canonical_launcher(self):
        suffix = f" --terminal-observation-proof 'verification/proof.json' --terminal-observation-proof-sha256 '{'c'*64}'"
        result = self.dispatch(suffix)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)[-4:], ["--terminal-observation-proof",
                         "verification/proof.json", "--terminal-observation-proof-sha256", "c"*64])

    def test_unpaired_or_injected_arguments_are_rejected(self):
        for suffix in (" --terminal-observation-proof 'verification/proof.json'",
                       f" --terminal-observation-proof-sha256 '{'c'*64}'",
                       f" --terminal-observation-proof 'verification/proof.json' --terminal-observation-proof-sha256 '{'c'*64}'; printf injected",
                       " --force"):
            result = self.dispatch(suffix)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertNotIn("injected", result.stdout)


if __name__ == "__main__":
    unittest.main()
