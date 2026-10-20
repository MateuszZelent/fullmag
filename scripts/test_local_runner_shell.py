"""Regression: a discoverable Windows Store alias is not a usable Python."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class StorageShellTests(unittest.TestCase):
    def antenna_http_shell(self, recipe=None, just_args=None):
        bash = Path('C:/Program Files/Git/bin/bash.exe') if os.name == 'nt' else Path(shutil.which('bash') or '/missing')
        if not bash.exists():
            self.skipTest('Bash unavailable')
        with tempfile.TemporaryDirectory(prefix='antenna-http-shell-') as temp:
            root = Path(temp)
            fake_python = root / 'fake-python'
            fake_python.write_text('#!/bin/sh\nif [ "$1" = "-c" ]; then exit 0; fi\nprintf "%s\\n" "$@"\n', encoding='utf-8')
            fake_python.chmod(0o755)
            repo = Path(__file__).resolve().parents[1]
            env = {**os.environ, 'FULLMAG_STORAGE_PYTHON': str(fake_python),
                   'PYTHONDONTWRITEBYTECODE': '1'}
            if just_args is None:
                command = [str(bash), str(repo / 'scripts/just_storage_shell.sh'), recipe]
            else:
                just = shutil.which('just')
                if just is None:
                    self.skipTest('just unavailable')
                command = [just, '--set', 'storage_python', 'python', *just_args]
            return subprocess.run(command, cwd=repo, env=env, capture_output=True,
                                  text=True, timeout=20)

    def test_full_just_antenna_http_start_dispatches_exact_ids(self):
        ids = ['a' * 32, 'b' * 40, 'c' * 64, 'd' * 64]
        result = self.antenna_http_shell(just_args=['run-managed-antenna-http-ram', *ids])
        self.assertEqual(0, result.returncode, result.stderr)
        arguments = result.stdout.splitlines()
        self.assertTrue(arguments[0].replace('\\', '/').endswith('/scripts/run_managed_antenna_http_ram.py'))
        self.assertEqual(['start', '--job-id', ids[0], '--commit', ids[1],
                          '--source-digest', ids[2], '--native-snapshot-sha256', ids[3]], arguments[3:])
        self.assertNotIn('fullmag_storage.py', result.stdout)

    def test_full_just_antenna_http_observe_dispatches_literal_root(self):
        run_root = 'D:/git/fullmag/storage/runs/own gate'
        result = self.antenna_http_shell(just_args=['observe-managed-antenna-http-ram', run_root])
        self.assertEqual(0, result.returncode, result.stderr)
        arguments = result.stdout.splitlines()
        self.assertTrue(arguments[0].replace('\\', '/').endswith('/scripts/run_managed_antenna_http_ram.py'))
        self.assertEqual(['observe', '--run-root', run_root], arguments[3:])

    def test_full_just_antenna_cold_gate_dispatches_explicit_mode(self):
        ids = ['a' * 32, 'b' * 40, 'c' * 64, 'd' * 64]
        result = self.antenna_http_shell(just_args=['run-managed-antenna-cold-http-ram', *ids])
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(['start', '--job-id', ids[0], '--commit', ids[1],
                          '--source-digest', ids[2], '--native-snapshot-sha256', ids[3],
                          '--verify-cold-import'], result.stdout.splitlines()[3:])

    def test_full_just_standalone_gates_dispatch_explicit_variant(self):
        ids = ['a' * 32, 'b' * 40, 'c' * 64, 'd' * 64]
        for recipe, helper, flags in (
            ('run-managed-antenna-standalone-ram', 'run_managed_antenna_ram.py', ['--standalone']),
            ('run-managed-antenna-standalone-cold-http-ram', 'run_managed_antenna_http_ram.py',
             ['--verify-cold-import', '--standalone']),
        ):
            with self.subTest(recipe=recipe):
                result = self.antenna_http_shell(just_args=[recipe, *ids])
                self.assertEqual(0, result.returncode, result.stderr)
                arguments = result.stdout.splitlines()
                self.assertTrue(arguments[0].replace('\\', '/').endswith('/scripts/' + helper))
                self.assertEqual(['start', '--job-id', ids[0], '--commit', ids[1],
                                  '--source-digest', ids[2], '--native-snapshot-sha256', ids[3],
                                  *flags], arguments[3:])

    def test_standalone_dispatch_rejects_composite_and_duplicate_flags(self):
        for helper in ('run_managed_antenna_ram.py', 'run_managed_antenna_http_ram.py'):
            start = f'python "D:/ignored/scripts/{helper}" --repo-root "D:/ignored" ' + (
                "start --job-id '" + 'a' * 32 + "' --commit '" + 'b' * 40
                + "' --source-digest '" + 'c' * 64 + "' --native-snapshot-sha256 '" + 'd' * 64 + "'"
            )
            for suffix in (' --standalone; true', ' --standalone && true',
                           ' --standalone\ntrue', ' --standalone --extra',
                           ' --standalone --standalone', ' --standalone --verify-cold-import'):
                with self.subTest(helper=helper, suffix=suffix):
                    result = self.antenna_http_shell(recipe=start + suffix)
                    self.assertEqual(2, result.returncode, result.stderr)
                    self.assertIn('invalid managed antenna', result.stderr)
                    self.assertEqual('', result.stdout)

    def test_full_just_port_diagnostics_dispatches_fixed_browser_fixture(self):
        result = self.antenna_http_shell(just_args=['verify-antenna-port-diagnostics-browser'])
        self.assertEqual(0, result.returncode, result.stderr)
        arguments = result.stdout.splitlines()
        self.assertTrue(arguments[0].replace('\\', '/').endswith('/scripts/verify_pinned_dataset_browser.py'))
        self.assertEqual(['--port', '3263', '--scenario', 'antenna-port-diagnostics'], arguments[3:])

    def test_full_just_port_editor_dispatches_fixed_browser_fixture(self):
        result = self.antenna_http_shell(just_args=['verify-antenna-port-editor-browser'])
        self.assertEqual(0, result.returncode, result.stderr)
        arguments = result.stdout.splitlines()
        self.assertTrue(arguments[0].replace('\\', '/').endswith('/scripts/verify_pinned_dataset_browser.py'))
        self.assertEqual(['--port', '3264', '--scenario', 'antenna-port-editor'], arguments[3:])

    def test_antenna_http_dispatch_rejects_composite_and_internal_commands(self):
        base = 'python "D:/ignored/scripts/run_managed_antenna_http_ram.py" --repo-root "D:/ignored" '
        start = base + "start --job-id '" + 'a' * 32 + "' --commit '" + 'b' * 40 + "' --source-digest '" + 'c' * 64 + "' --native-snapshot-sha256 '" + 'd' * 64 + "'"
        observe = base + "observe --run-root 'D:/git/fullmag/storage/runs/own'"
        for recipe in (start + '; true', observe + ' && true', observe + '\ntrue',
                       base + 'execute', start.replace('a' * 32, 'bad-id'),
                       observe + ' --extra', 'true; ' + start,
                       start + ' --verify-cold-import; true',
                       start + ' --verify-cold-import --extra',
                       start + ' --verify-cold-import --verify-cold-import'):
            with self.subTest(recipe=recipe):
                result = self.antenna_http_shell(recipe=recipe)
                self.assertEqual(2, result.returncode, result.stderr)
                self.assertIn('invalid managed antenna HTTP RAM recipe', result.stderr)
                self.assertEqual('', result.stdout)

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

    def test_frozen_coordinator_dispatch_is_closed_before_diagnostic_markers(self):
        bash = Path('C:/Program Files/Git/bin/bash.exe') if os.name == 'nt' else Path(shutil.which('bash') or '/missing')
        if not bash.exists():
            self.skipTest('Bash unavailable')
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            interpreter = root / 'python'
            interpreter.write_text('#!/bin/sh\nif [ "$1" = "-c" ]; then exit 0; fi\nprintf "%s\\n" "$@"\n', encoding='utf-8')
            interpreter.chmod(0o755)
            wrapper = Path(__file__).resolve().parent / 'just_storage_shell.sh'
            prefix = 'python "D:/review/scripts/local_runner/coordinator_image.py" '
            capture = prefix + "prepare-image-context --repo-root 'D:/review' --source commit --ref '" + 'a' * 40 + "'"
            build = prefix + "build-image --repo-root 'D:/review' --context 'D:/owned/context' --context-sha256 '" + 'b' * 64 + "' --tag 'fullmag/build-runner:review-v1'"
            env = dict(os.environ, FULLMAG_STORAGE_PYTHON=str(interpreter))
            provision = prefix + "provision-base --repo-root 'D:/review'"
            for recipe in (capture, build, provision):
                result = subprocess.run([str(bash), str(wrapper), recipe], env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                arguments = result.stdout.splitlines()
                self.assertTrue(arguments[0].endswith('/local_runner/coordinator_image.py'))
                self.assertEqual(arguments[2], '--repo-root')
                self.assertNotEqual(arguments[3], 'D:/review')  # Dispatch binds this checkout.
            for recipe in (capture.replace('a' * 40, 'a' * 7),
                           build.replace('b' * 64, 'b' * 7),
                           build.replace('fullmag/build-runner:review-v1', 'foreign/image:latest'),
                           capture + '; printf bypass # fullmag_storage.py resolve ',
                           build + ' && echo bypass # just --list',
                           provision + ' --base-image foreign/image:latest',
                           provision + '; echo bypass # fullmag_storage.py resolve '):
                with self.subTest(recipe=recipe):
                    result = subprocess.run([str(bash), str(wrapper), recipe], env=env, capture_output=True, text=True)
                    self.assertEqual(result.returncode, 2, result.stderr)
                    self.assertEqual(result.stdout, '')
                    self.assertIn('invalid frozen coordinator image recipe', result.stderr)

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
