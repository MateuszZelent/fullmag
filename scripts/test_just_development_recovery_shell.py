"""Check fixed-argv development recovery dispatch without Docker or temporary files."""
from pathlib import Path
import os
import subprocess
import unittest


class DevelopmentRecoveryShellTests(unittest.TestCase):
    def dispatch(self, recipe, marker='  *"scripts/docker_volume_development_interrupted.py"*)\n'):
        source = globals().get('WRAPPER') or (Path(__file__).resolve().parent / 'just_storage_shell.sh').read_text()
        body = source.split(marker, 1)[1].split('\n    ;;', 1)[0]
        program = ('set -euo pipefail\nrecipe="$RECIPE_LITERAL"\n'
                   'python_cmd="/recorded/python"\nrepo_root="/registered/checkout"\nscript_dir="/registered/checkout/scripts"\n'
                   'exec() { printf \'%s\\0\' "$@"; }\n' + body)
        return subprocess.run(['/bin/bash', '--noprofile', '--norc', '-c', program],
            env={**os.environ, 'RECIPE_LITERAL': recipe}, capture_output=True, timeout=15)

    def recipe(self, *, source='/selected/worktree', digest='a' * 64,
               request='verification/own/request.json', apply=False):
        return ('python "/ignored/scripts/docker_volume_development_interrupted.py" '
                f"--request '{request}' --request-sha256 '{digest}' --source-root '{source}'"
                + (' --apply' if apply else ''))

    def test_preview_dispatches_fixed_arguments_without_apply(self):
        source = '/selected/$(printf injected);worktree'
        result = self.dispatch(self.recipe(source=source, apply=False))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.split(b'\0')[:-1], [
            b'/recorded/python', b'-B',
            b'/registered/checkout/scripts/docker_volume_development_interrupted.py',
            b'--request', b'verification/own/request.json', b'--request-sha256', b'a' * 64,
            b'--source-root', source.encode()])

    def test_publication_requires_explicit_apply(self):
        result = self.dispatch(self.recipe(apply=True))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.split(b'\0')[-4:-1], [b'--source-root', b'/selected/worktree', b'--apply'])
        self.assertIn(b'--apply', result.stdout)

    def test_invalid_pins_and_composite_commands_are_rejected(self):
        for recipe in (self.recipe(digest='short'), self.recipe(digest='A' * 64),
                       self.recipe(request='verification/$(printf injected).json'),
                       self.recipe() + '; printf injected', self.recipe() + ' && printf injected',
                       self.recipe() + '\nprintf injected',
                       self.recipe().replace(" --request-sha256 '" + 'a' * 64 + "'", ''),
                       self.recipe() + ' --port 3203',
                       self.recipe(apply=True) + ' --apply',
                       self.recipe(source="/selected/unsafe'quote")):
            with self.subTest(recipe=recipe):
                result = self.dispatch(recipe)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse(result.stdout)


    def test_idle_restart_preserves_explicit_prepared_session_flag(self):
        recipe = ('python "/ignored/scripts/docker_dev.py" --repo-root "/ignored" '
                  "restart-idle-volume --attempt '" + 'a' * 32 + "' --config-sha256 '" + 'b' * 64
                  + "' --source-root '/selected/$(printf injected);worktree' --port '3203'")
        marker = '  *"scripts/docker_dev.py"*)\n'
        expected = [b'/recorded/python', b'/registered/checkout/scripts/docker_dev.py',
                    b'--repo-root', b'/registered/checkout', b'restart-idle-volume',
                    b'--attempt', b'a' * 32, b'--config-sha256', b'b' * 64,
                    b'--source-root', b'/selected/$(printf injected);worktree', b'--port', b'3203']
        for suffix in ('', ' --allow-prepared-session', ' --stop-only --allow-prepared-session'):
            with self.subTest(suffix=suffix):
                result = self.dispatch(recipe + suffix, marker=marker)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.split(b'\0')[:-1],
                                 expected + [word.encode() for word in suffix.split()])
        for suffix in (' --allow-prepared-session --allow-prepared-session',
                       ' --allow-prepared-session true', ' --allow-prepared-session; printf injected',
                       ' --allow-prepared-session && printf injected',
                       ' --allow-prepared-session\nprintf injected'):
            with self.subTest(suffix=suffix):
                result = self.dispatch(recipe + suffix, marker=marker)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse(result.stdout)




    def test_frontend_frozen_refresh_uses_exact_structured_arguments(self):
        source = "/selected/$(printf injected);worktree"
        recipe = ('python "/ignored/scripts/docker_dev.py" --repo-root "/ignored" '
                  "refresh-frontend-volume --attempt '" + "a" * 32 + "' --config-sha256 '" + "b" * 64
                  + "' --source-root '" + source + "' --port '3203'")
        suffix = (" --frontend-frozen-resume '" + "c" * 32
                  + "' --frontend-frozen-resume-sha256 '" + "d" * 64 + "'")
        for tail in ("", suffix):
            with self.subTest(tail=tail):
                result = self.dispatch(recipe + tail, marker='  *"scripts/docker_dev.py"*)\n')
                self.assertEqual(result.returncode, 0, result.stderr)
                expected = [b'/recorded/python', b'/registered/checkout/scripts/docker_dev.py',
                            b'--repo-root', b'/registered/checkout', b'refresh-frontend-volume',
                            b'--attempt', b'a' * 32, b'--config-sha256', b'b' * 64,
                            b'--source-root', source.encode(), b'--port', b'3203']
                if tail:
                    expected += [b'--frontend-frozen-resume', b'c' * 32,
                                 b'--frontend-frozen-resume-sha256', b'd' * 64]
                self.assertEqual(result.stdout.split(b'\0')[:-1], expected)
        for tail in (" --frontend-frozen-resume '" + "c" * 32 + "'",
                     " --frontend-frozen-resume-sha256 '" + "d" * 64 + "'",
                     suffix + " --unexpected value", suffix + "; printf injected",
                     suffix + " && printf injected", suffix + "\nprintf injected",
                     suffix.replace("c" * 32, "$(printf injected)")):
            with self.subTest(tail=tail):
                result = self.dispatch(recipe + tail, marker='  *"scripts/docker_dev.py"*)\n')
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse(result.stdout)


if __name__ == '__main__':
    unittest.main()
