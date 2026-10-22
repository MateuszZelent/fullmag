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
        body = source[start:].split('\n    ;;', 1)[0]
        with tempfile.TemporaryDirectory(prefix='fullmag-docker-dev-shell-') as directory:
            script_dir = Path(directory) / 'scripts'
            script_dir.mkdir()
            (script_dir / 'docker_dev.py').write_text(
                'import json,sys; print(json.dumps(sys.argv[1:]))\n', encoding='utf8')
            program = ('set -euo pipefail\nrecipe="$RECIPE_LITERAL"\n'
                       'python_cmd="$FIXED_PYTHON"\n'
                       'repo_root="/registered/checkout"\n'
                       f'script_dir="{script_dir}"\n' + body)
            bash = '/bin/bash' if os.name == 'posix' else (shutil.which('bash') or 'bash')
            return subprocess.run([bash, '--noprofile', '--norc', '-c', program],
                                  env={**os.environ, 'RECIPE_LITERAL': recipe,
                                       'FIXED_PYTHON': sys.executable},
                                  capture_output=True, text=True, timeout=15)

    def recipe(self, *, source_root=None, script=None, suffix=''):
        optional_source = '' if source_root is None else f" --source-root '{source_root}'"
        optional_script = '' if script is None else f" --script '{script}'"
        return (f'python "/ignored/checkout/scripts/docker_dev.py" '
                '--repo-root "/ignored/checkout" up --port \'3197\' --gpu-access \'auto\''
                f'{optional_source}{optional_script}{suffix}')

    def test_dispatches_docker_dev_without_legacy_storage_build_runner(self):
        cases = (
            (self.recipe(), ['--repo-root', '/registered/checkout', 'up', '--port', '3197',
                             '--gpu-access', 'auto']),
            (self.recipe(source_root='/selected/worktree', script='examples/run.py'),
             ['--repo-root', '/registered/checkout', 'up', '--port', '3197', '--gpu-access',
              'auto', '--source-root', '/selected/worktree', '--script', 'examples/run.py']),
        )
        for recipe, expected in cases:
            with self.subTest(recipe=recipe):
                result = self.dispatch(recipe)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout), expected)

    def test_dispatches_build_as_fixed_argv(self):
        recipe = ('python "/ignored/checkout/scripts/docker_dev.py" --repo-root "/ignored/checkout" '
                  "build --gpu-access 'disabled' --source-root '/selected/worktree'")
        result = self.dispatch(recipe)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), ['--repo-root', '/registered/checkout', 'build',
            '--gpu-access', 'disabled', '--source-root', '/selected/worktree'])

    def test_rejects_retired_host_receipt_recreate_recipe(self):
        recipe = ('python "/ignored/checkout/scripts/docker_dev.py" --repo-root "/ignored/checkout" '
                  "recreate --direct-development --run-receipt '/storage/runs/failed.json' "
                  f"--previous-config-sha256 '{'a' * 64}' --gpu-access 'required' "
                  "--source-root '/selected/worktree' --port '3198'")
        result = self.dispatch(recipe)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn('host-receipt DEV recreation is retired', result.stderr)
        self.assertFalse(result.stdout.strip())

    def test_volume_lifecycle_commands_dispatch_fixed_argv(self):
        for command, flag in [('resume-volume', '--restart-backend'),
                              ('recreate-volume', '--fresh-state'),
                              ('restart-idle-volume', '')]:
            source = '/selected/$(printf literal);worktree'
            recipe = ('python "/ignored/checkout/scripts/docker_dev.py" --repo-root "/ignored/checkout" '
                      f"{command} --attempt '{'b' * 32}' --config-sha256 '{'a' * 64}' "
                      f"--source-root '{source}' --port '3198'"
                      + ((('  ' if command == 'recreate-volume' else ' ') + flag) if flag else ''))
            result = self.dispatch(recipe)
            self.assertEqual(result.returncode, 0, result.stderr)
            expected = ['--repo-root', '/registered/checkout', command, '--attempt', 'b' * 32,
                        '--config-sha256', 'a' * 64, '--source-root', source, '--port', '3198']
            if flag: expected.append(flag)
            self.assertEqual(json.loads(result.stdout), expected)
            injected = self.dispatch(recipe + '; printf injected')
            self.assertEqual(injected.returncode, 2, injected.stderr)


    def test_fresh_state_accepts_spacing_from_an_empty_optional_recovery_argument(self):
        base = ('python "/ignored/checkout/scripts/docker_dev.py" --repo-root "/ignored/checkout" '
                f"recreate-volume --attempt '{'b' * 32}' --config-sha256 '{'a' * 64}' "
                "--source-root '/selected/worktree' --port '3202'")
        for spacing in (' ', '  ', '   '):
            with self.subTest(spacing=spacing):
                result = self.dispatch(base + spacing + '--fresh-state')
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout), [
                    '--repo-root', '/registered/checkout', 'recreate-volume',
                    '--attempt', 'b' * 32, '--config-sha256', 'a' * 64,
                    '--source-root', '/selected/worktree', '--port', '3202', '--fresh-state',
                ])

    def test_script_activation_dispatches_literal_argv_and_rejects_composite_commands(self):
        source = '/selected/$(printf literal);worktree'
        script = 'examples/$(printf literal);study.py'
        base = ('python "/ignored/checkout/scripts/docker_dev.py" --repo-root "/ignored/checkout" '
                f"activate-script --attempt '{'b' * 32}' --config-sha256 '{'a' * 64}' "
                f"--source-root '{source}' --script '{script}'")
        for request_id in (None, 'stable-request-1'):
            recipe = base + (f" --request-id '{request_id}'" if request_id else '')
            result = self.dispatch(recipe)
            self.assertEqual(result.returncode, 0, result.stderr)
            expected = ['--repo-root', '/registered/checkout', 'activate-script',
                        '--attempt', 'b' * 32, '--config-sha256', 'a' * 64,
                        '--source-root', source, '--script', script]
            if request_id:
                expected.extend(['--request-id', request_id])
            self.assertEqual(json.loads(result.stdout), expected)
            rejected = self.dispatch(recipe + '; printf injected')
            self.assertEqual(rejected.returncode, 2, rejected.stderr)
            self.assertNotIn('injected', rejected.stdout)

    def test_rejects_unbound_recreate_variants(self):
        for recipe in (
            self.recipe().replace("--gpu-access 'auto'", "--gpu-access 'unknown'"),
            self.recipe(suffix='; printf injected'),
        ):
            with self.subTest(recipe=recipe):
                result = self.dispatch(recipe)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertNotIn('injected', result.stdout)


    def test_saved_authoring_restart_dispatches_only_paired_checkpoint_pins(self):
        base = ('python "/ignored/checkout/scripts/docker_dev.py" --repo-root "/ignored/checkout" '
                f"restart-idle-volume --attempt '{'b' * 32}' --config-sha256 '{'a' * 64}' "
                "--source-root '/selected/worktree' --port '3202'")
        suffix = f" --saved-authoring-checkpoint 'verification/own/checkpoint.json' --saved-authoring-checkpoint-sha256 '{'c' * 64}'"
        result = self.dispatch(base + suffix)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)[-4:], ['--saved-authoring-checkpoint',
            'verification/own/checkpoint.json', '--saved-authoring-checkpoint-sha256', 'c' * 64])
        stopped = self.dispatch(base + suffix + ' --stop-only')
        self.assertEqual(stopped.returncode, 0, stopped.stderr)
        self.assertEqual(json.loads(stopped.stdout)[-1], '--stop-only')
        self.assertEqual(self.dispatch(base + ' --stop-only').returncode, 2)
        for changed in (suffix.split(' --saved-authoring-checkpoint-sha256')[0],
                        suffix + '; printf injected', suffix.replace('c' * 64, 'bad')):
            result = self.dispatch(base + changed)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertNotIn('injected', result.stdout)


    def test_frontend_refresh_has_only_fixed_literal_arguments(self):
        source = '/selected/$(printf literal);worktree'
        recipe = ('python "/ignored/checkout/scripts/docker_dev.py" --repo-root "/ignored/checkout" '
                  f"refresh-frontend-volume --attempt '{'b'*32}' --config-sha256 '{'a'*64}' "
                  f"--source-root '{source}' --port '3202'")
        result = self.dispatch(recipe)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), ['--repo-root','/registered/checkout',
            'refresh-frontend-volume','--attempt','b'*32,'--config-sha256','a'*64,
            '--source-root',source,'--port','3202'])
        for suffix in ('; printf injected', ' --fresh-state', ' --restart-backend'):
            rejected = self.dispatch(recipe + suffix)
            self.assertEqual(rejected.returncode, 2, rejected.stderr)


class DockerVolumeChecksShellBoundaryTests(unittest.TestCase):
    def dispatch(self, suffix):
        source = (Path(__file__).resolve().parent / 'just_storage_shell.sh').read_text(encoding='utf8')
        body = source.split('  *"scripts/docker_volume_checks.py"*)\n', 1)[1].split('\n    ;;', 1)[0]
        with tempfile.TemporaryDirectory(prefix='fullmag-checks-shell-') as directory:
            script = Path(directory) / 'docker_volume_checks.py'
            script.write_text('import json,sys; print(json.dumps(sys.argv[1:]))\n', encoding='utf8')
            program = ('set -euo pipefail\nrecipe="$RECIPE_LITERAL"\n'
                       'python_cmd="$FIXED_PYTHON"\nscript_dir="$FIXED_SCRIPTS"\n' + body)
            recipe = 'python "/ignored/scripts/docker_volume_checks.py" --source-root \'/registered/checkout\'' + suffix
            return subprocess.run(['/bin/bash', '--noprofile', '--norc', '-c', program],
                env={**os.environ, 'RECIPE_LITERAL': recipe, 'FIXED_PYTHON': sys.executable,
                     'FIXED_SCRIPTS': directory}, capture_output=True, text=True, timeout=15)

    def test_accepts_only_declared_scopes_as_fixed_arguments(self):
        for suffix, scope in [('', 'all'), (" --scope 'all'", 'all'),
                              (" --scope 'source-capture'", 'source-capture'),
                              (" --scope 'frontend-import'", 'frontend-import'),
                              (" --scope 'field-only'", 'field-only')]:
            result = self.dispatch(suffix)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), ['--source-root', '/registered/checkout', '--scope', scope])

    def test_rejects_unknown_scope_and_composite_commands(self):
        for suffix in [" --scope 'unknown'", " --scope 'all'; printf injected",
                       " --scope 'source-capture' --unknown"]:
            result = self.dispatch(suffix)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertNotIn('injected', result.stdout)


if __name__ == '__main__':
    unittest.main()
