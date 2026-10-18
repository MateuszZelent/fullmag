"""Check the actual fixed-argv just shell boundary without starting Docker."""
from pathlib import Path
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest


class OrphanRecoveryShellBoundaryTests(unittest.TestCase):
    def dispatch(self, recipe):
        shell = Path(__file__).resolve().parents[1] / 'scripts/just_storage_shell.sh'
        source = shell.read_text(encoding='utf8')
        body = source.split('  *"scripts/recover_docker_orphan.py"*)\n', 1)[1].split('\n    ;;', 1)[0]
        with tempfile.TemporaryDirectory(prefix='fullmag-orphan-shell-') as directory:
            resolver = Path(directory) / 'resolver.py'
            resolver.write_text('import json,sys; print(json.dumps(sys.argv[1:]))\n', encoding='utf8')
            environment = dict(os.environ, RECIPE_LITERAL=recipe, FIXED_PYTHON=sys.executable,
                               FIXED_RESOLVER=str(resolver))
            program = ('set -euo pipefail\nrecipe="$RECIPE_LITERAL"\n'
                       'python_cmd="$FIXED_PYTHON"\nresolver="$FIXED_RESOLVER"\n'
                       'repo_root="/registered/checkout"\nscript_dir="/registered/checkout/scripts"\n' + body)
            bash = '/bin/bash' if os.name == 'posix' else (shutil.which('bash') or 'bash')
            return subprocess.run([bash, '--noprofile', '--norc', '-c', program],
                                  env=environment, capture_output=True, text=True, timeout=15)

    def recipe(self, pins='/storage/recovery/pins.json', container='a' * 64,
               project='fullmag-worktree-task-123'):
        return (f'python "/ignored/checkout/scripts/recover_docker_orphan.py" '
                f"--pins '{pins}' --target-container '{container}' --project '{project}' "
                "--diagnostics-root '/storage/run/state/diagnostics/orphan'")

    def test_dispatches_fixed_helper_under_storage_preflight(self):
        result = self.dispatch(self.recipe())
        self.assertEqual(result.returncode, 0, result.stderr)
        arguments = json.loads(result.stdout)
        self.assertEqual(arguments[:6], ['run', '--repo-root', '/registered/checkout',
                                         '--profile', 'docker-all-gpu', '--'])
        self.assertEqual(arguments[7], '/registered/checkout/scripts/recover_docker_orphan.py')
        self.assertEqual(arguments[8:], ['--pins', '/storage/recovery/pins.json',
                         '--target-container', 'a' * 64, '--project',
                         'fullmag-worktree-task-123', '--diagnostics-root',
                         '/storage/run/state/diagnostics/orphan'])

    def test_dispatches_explicit_pre_stop_resume_as_one_fixed_flag(self):
        result = self.dispatch(self.recipe() + " --resume-before-stop")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)[-1], "--resume-before-stop")
        result = self.dispatch(self.recipe() + " --resume-before-stop; printf injected")
        self.assertEqual(result.returncode, 2, result.stderr)

    def test_literal_shell_syntax_is_data_not_a_second_command(self):
        pins = '/storage/$(printf injected);literal/pins.json'
        result = self.dispatch(self.recipe(pins=pins))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)[9], pins)

    def test_composite_command_and_changed_target_are_rejected(self):
        for recipe in [self.recipe() + '; printf injected',
                       self.recipe(container='short'),
                       self.recipe(project='another-project'),
                       self.recipe(pins="unsafe'quote")]:
            with self.subTest(recipe=recipe):
                result = self.dispatch(recipe)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertNotIn('injected', result.stdout)


class DockerDevelopmentShellBoundaryTests(unittest.TestCase):
    def dispatch(self, recipe):
        shell = Path(__file__).resolve().parents[1] / 'scripts/just_storage_shell.sh'
        source = shell.read_text(encoding='utf8')
        marker = '  *"scripts/docker_dev.py"*)\n'
        start = source.index(marker) + len(marker)
        body = source[start:source.index('\n  *"scripts/run_managed_boris_nf_v2.py"*)', start)]
        with tempfile.TemporaryDirectory(prefix='fullmag-docker-dev-shell-') as directory:
            resolver = Path(directory) / 'resolver.py'
            resolver.write_text('import json,sys; print(json.dumps(sys.argv[1:]))\n', encoding='utf8')
            program = ('set -euo pipefail\nrecipe="$RECIPE_LITERAL"\n'
                       'python_cmd="$FIXED_PYTHON"\nresolver="$FIXED_RESOLVER"\n'
                       'repo_root="/registered/checkout"\n'
                       'script_dir="/registered/checkout/scripts"\n'
                       'bash_executable="/bin/bash"\n' + body)
            bash = '/bin/bash' if os.name == 'posix' else (shutil.which('bash') or 'bash')
            return subprocess.run([bash, '--noprofile', '--norc', '-c', program],
                                  env={**os.environ, 'RECIPE_LITERAL': recipe,
                                       'FIXED_PYTHON': sys.executable,
                                       'FIXED_RESOLVER': str(resolver)},
                                  capture_output=True, text=True, timeout=15)

    def recipe(self, *, source_root=None, suffix=''):
        optional_source = ' ' if source_root is None else f" --source-root '{source_root}'"
        return (f'python "/ignored/checkout/scripts/docker_dev.py" '
                '--repo-root "/ignored/checkout" recreate --direct-development '
                "--run-receipt '/storage/runs/failed.json' "
                f"--previous-config-sha256 '{'a' * 64}'{optional_source} --port '3197'"
                f'{suffix}')

    def test_dispatches_controlled_recreate_recipe(self):
        for recipe in (self.recipe(), self.recipe(source_root='/selected/worktree')):
            with self.subTest(recipe=recipe):
                result = self.dispatch(recipe)
                self.assertEqual(result.returncode, 0, result.stderr)
                arguments = json.loads(result.stdout)
                self.assertEqual(arguments[:10], [
                    'run', '--repo-root', '/registered/checkout', '--profile',
                    'docker-all-gpu', '--', '/bin/bash', '-euo', 'pipefail', '-c',
                ])
                self.assertEqual(arguments[10], recipe)

    def test_rejects_unbound_recreate_variants(self):
        for recipe in (
            self.recipe().replace('--direct-development ', ''),
            self.recipe().replace("'" + 'a' * 64 + "'", "'short'"),
            self.recipe(suffix='; printf injected'),
        ):
            with self.subTest(recipe=recipe):
                result = self.dispatch(recipe)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertNotIn('injected', result.stdout)


if __name__ == '__main__':
    unittest.main()
