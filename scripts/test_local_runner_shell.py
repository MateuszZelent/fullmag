"""Regression: a discoverable Windows Store alias is not a usable Python."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class StorageShellTests(unittest.TestCase):
    def test_broken_python3_alias_falls_back_to_python(self):
        bash = Path('C:/Program Files/Git/bin/bash.exe') if os.name == 'nt' else Path(shutil.which('bash') or '/missing')
        if not bash.exists():
            self.skipTest('Bash unavailable')
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name, code in [('python3', 49), ('python', 0)]:
                path = root / name
                path.write_text(f'#!/bin/sh\nexit {code}\n', encoding='utf-8')
                path.chmod(0o755)
            # Use the wrapper read-only branch so the test never initializes
            # real storage or runs a recipe. Only selected interpreter leaks.
            recipe = 'printf "%s" "$FULLMAG_STORAGE_PYTHON" # fullmag_storage.py resolve '
            script = Path(__file__).resolve().parent / 'just_storage_shell.sh'
            result = subprocess.run([str(bash), '-c',
                'PATH="$(cygpath -u "$1" 2>/dev/null || printf "%s" "$1"):/usr/bin:/bin"; export PATH; exec bash "$2" "$3"',
                'test', str(root), str(script), recipe], capture_output=True, text=True)
            self.assertEqual(0, result.returncode, result.stderr)
            self.assertTrue(result.stdout.endswith('/python'), result.stdout)

    @unittest.skipUnless(os.name == 'nt', 'Windows shell selection regression')
    def test_native_resolver_receives_absolute_git_bash(self):
        bash = Path('C:/Program Files/Git/bin/bash.exe')
        if not bash.exists():
            self.skipTest('Git Bash unavailable')
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            script = root / 'python3'
            script.write_text('#!/bin/sh\nif [ "$2" = "run" ]; then printf "%s\\n" "$@"; fi\nexit 0\n', encoding='utf-8')
            script.chmod(0o755)
            wrapper = Path(__file__).resolve().parent / 'just_storage_shell.sh'
            result = subprocess.run([str(bash), '-c',
                'PATH="$(cygpath -u "$1"):/usr/bin:/bin"; export PATH; exec bash "$2" "printf diagnostic"',
                'test', str(root), str(wrapper)], capture_output=True, text=True)
            self.assertEqual(0, result.returncode, result.stderr)
            arguments = result.stdout.splitlines()
            shell = arguments[arguments.index('--') + 1]
            self.assertTrue(Path(shell).is_absolute(), shell)
            self.assertIn('Git', shell)
            self.assertEqual('bash.exe', Path(shell).name.lower())


if __name__ == '__main__':
    unittest.main()
