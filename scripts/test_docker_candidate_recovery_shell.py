"""Exercise package recovery argv parsing without starting Docker."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class CandidateRecoveryShellTests(unittest.TestCase):
    def dispatch(self, suffix="", source="/registered/task"):
        text = (Path(__file__).resolve().parent / "just_storage_shell.sh").read_text()
        body = text.split('  *"scripts/docker_candidate_recovery.py"*)\n', 1)[1].split('\n    ;;', 1)[0]
        recipe = (f"""python "/ignored/scripts/docker_candidate_recovery.py" --source-root '{source}' """
                  f"--backend-container-id '{'a'*64}' --image-id 'sha256:{'b'*64}' "
                  f"--request 'verification/recovery.json' --request-sha256 '{'c'*64}'{suffix}")
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "docker_candidate_recovery.py").write_text(
                "import json,sys; print(json.dumps(sys.argv[1:]))\n")
            program = ('set -euo pipefail\nrecipe="$RECIPE"\npython_cmd="$PYTHON"\n'
                       'script_dir="$SCRIPTS"\n' + body)
            return subprocess.run(["bash", "--noprofile", "--norc", "-c", program],
                                  env={**os.environ, "RECIPE": recipe, "PYTHON": sys.executable,
                                       "SCRIPTS": directory}, capture_output=True, text=True, timeout=15)

    def test_dry_run_and_explicit_apply(self):
        for suffix in ("", " --apply"):
            result = self.dispatch(suffix)
            self.assertEqual(result.returncode, 0, result.stderr)
            args = json.loads(result.stdout)
            self.assertEqual(args[:2], ["--source-root", "/registered/task"])
            self.assertEqual("--apply" in args, bool(suffix))

    def test_shell_payload_remains_literal_data(self):
        source = "/task/$(printf injected);literal"
        result = self.dispatch(source=source)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)[1], source)

    def test_extra_commands_and_flags_are_rejected(self):
        for suffix in ("; printf injected", " --apply; printf injected", " --force", " --apply --apply"):
            result = self.dispatch(suffix)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertNotIn("injected", result.stdout)
