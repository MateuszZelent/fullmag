"""Check fixed-argv toolchain recovery dispatch without Docker or temporary files."""
from pathlib import Path
import os
import subprocess
import unittest


class ToolchainRecoveryShellTests(unittest.TestCase):
    def dispatch(self, recipe):
        source = (Path(__file__).resolve().parent / 'just_storage_shell.sh').read_text()
        marker = '  *"scripts/docker_volume_toolchain_reconcile.py"*)\n'
        body = source.split(marker, 1)[1].split('\n    ;;', 1)[0]
        program = ('set -euo pipefail\nrecipe="$RECIPE_LITERAL"\n'
                   'python_cmd="/recorded/python"\nscript_dir="/registered/checkout/scripts"\n'
                   'exec() { printf \'%s\\0\' "$@"; }\n' + body)
        return subprocess.run(['/bin/bash', '--noprofile', '--norc', '-c', program],
            env={**os.environ, 'RECIPE_LITERAL': recipe}, capture_output=True, timeout=15)

    def recipe(self, *, source='/selected/worktree', digest='a' * 64,
               request='verification/own/request.json', preview=True):
        return ('python "/ignored/scripts/docker_volume_toolchain_reconcile.py" '
                f"--request '{request}' --request-sha256 '{digest}' --source-root '{source}'"
                + (' --preview' if preview else ''))

    def test_preview_dispatches_literal_arguments_to_the_canonical_script(self):
        source = '/selected/$(printf injected);worktree'
        result = self.dispatch(self.recipe(source=source))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.split(b'\0')[:-1], [
            b'/recorded/python', b'-B',
            b'/registered/checkout/scripts/docker_volume_toolchain_reconcile.py',
            b'--request', b'verification/own/request.json', b'--request-sha256', b'a' * 64,
            b'--source-root', source.encode(), b'--preview'])

    def test_publication_has_the_same_fixed_arguments_without_preview(self):
        result = self.dispatch(self.recipe(preview=False))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.split(b'\0')[-3:-1], [b'--source-root', b'/selected/worktree'])
        self.assertNotIn(b'--preview', result.stdout)

    def test_invalid_pins_and_composite_commands_are_rejected(self):
        for recipe in (self.recipe(digest='short'), self.recipe(digest='A' * 64),
                       self.recipe(request='verification/$(printf injected).json'),
                       self.recipe() + '; printf injected', self.recipe() + ' && printf injected',
                       self.recipe() + '\nprintf injected',
                       self.recipe().replace(" --request-sha256 '" + 'a' * 64 + "'", ''),
                       self.recipe() + ' --port 3203',
                       self.recipe() + ' --preview',
                       self.recipe(source="/selected/unsafe'quote")):
            with self.subTest(recipe=recipe):
                result = self.dispatch(recipe)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse(result.stdout)


if __name__ == '__main__':
    unittest.main()
