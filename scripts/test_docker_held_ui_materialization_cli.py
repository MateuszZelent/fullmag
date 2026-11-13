"""Closed CLI contract for same-intent held UI continuation; no Docker calls."""
from contextlib import redirect_stderr
from io import StringIO
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_dev


class HeldUiMaterializationCliTests(unittest.TestCase):
    def arguments(self):
        return ["--repo-root", "/registered/repo", "continue-held-ui-volume",
                "--attempt", "a" * 32, "--config-sha256", "b" * 64,
                "--source-root", "/registered/task", "--run-id", "run-live-" + "c" * 64,
                "--request-id", "11111111-1111-4111-8111-111111111111", "--port", "3243"]

    def dispatch(self, suffix):
        text = (Path(__file__).parent / "just_storage_shell.sh").read_text()
        body = text.split('  *"scripts/docker_dev.py"*)\n', 1)[1].split('\n    ;;', 1)[0]
        recipe = (f'python "/ignored/scripts/docker_dev.py" --repo-root "/registered/repo" '
                  f"continue-held-ui-volume --attempt '{'a'*32}' --config-sha256 '{'b'*64}' "
                  f"--source-root '/registered/task' --run-id 'run-live-{'c'*64}' "
                  "--request-id '11111111-1111-4111-8111-111111111111' --port '3243'" + suffix)
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "docker_dev.py").write_text("import json,sys; print(json.dumps(sys.argv[1:]))\n")
            program = ('set -euo pipefail\nrecipe="$RECIPE"\npython_cmd="$PYTHON"\n'
                       'script_dir="$SCRIPTS"\nrepo_root="/registered/repo"\n' + body)
            return subprocess.run(["bash", "--noprofile", "--norc", "-c", program],
                env={**os.environ, "RECIPE": recipe, "PYTHON": sys.executable, "SCRIPTS": directory},
                capture_output=True, text=True, timeout=15)

    def test_preview_and_apply_are_explicit_and_keep_same_request(self):
        for mode in (["--preview"], ["--apply", "--expected-plan-sha256", "d" * 64]):
            args = docker_dev._parser().parse_args(self.arguments() + mode)
            self.assertEqual(args.action, "continue-held-ui-volume")
            self.assertEqual(args.request_id, "11111111-1111-4111-8111-111111111111")
            self.assertFalse(args.fresh_state)

    def test_missing_or_conflicting_mode_is_rejected(self):
        for mode in ([], ["--preview", "--apply"]):
            with self.subTest(mode=mode), redirect_stderr(StringIO()), self.assertRaises(SystemExit):
                docker_dev._parser().parse_args(self.arguments() + mode)

    def test_closed_shell_dispatch_preserves_reviewed_plan(self):
        for suffix, expected in ((" --preview", ["--preview"]),
                (f" --apply --expected-plan-sha256 '{'d'*64}'", ["--apply", "--expected-plan-sha256", "d"*64])):
            result = self.dispatch(suffix)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)[-len(expected):], expected)

    def test_shell_refuses_unreviewed_or_injected_apply(self):
        for suffix in (" --apply", " --preview --apply", " --force",
                       f" --apply --expected-plan-sha256 '{'d'*64}'; printf injected"):
            result = self.dispatch(suffix)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertNotIn("injected", result.stdout)


if __name__ == "__main__":
    unittest.main()
