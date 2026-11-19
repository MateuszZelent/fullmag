import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from docker_build_control import BuildControlError, canonical
from docker_volume_preowner_probe_stop import validate_origin, sha, require_apply_plan


class PreownerProbeStopTests(unittest.TestCase):
    def setUp(self):
        self.compose = {'name': 'fullmag-test', 'services': {
            'backend': {'environment': {'FULLMAG_STARTUP_ENABLED': '0'}},
            'frontend': {}}}
        self.scope = {'attempt': 'a' * 32, 'resume_attempt': 'b' * 32,
                      'source_root': 'source', 'project': 'fullmag-test',
                      'volume': 'private-test', 'config_sha256': sha(canonical(self.compose))}
        self.development = {'schema': 'fullmag.docker-build-operation.v1',
            'phase': 'development', 'state': 'failed-confirmed', 'attempt': 'a' * 32,
            'compose_project': 'fullmag-test', 'control_volume': 'private-test',
            'inputs': {'source_root': 'source', 'image_id': 'sha256:' + 'c' * 64}}
        self.resume = {**copy.deepcopy(self.development), 'phase': 'resume', 'attempt': 'b' * 32,
            'config_sha256': self.scope['config_sha256'],
            'backend_started_at': '2026-11-18T06:46:32Z',
            'frontend_started_at': '2026-11-18T06:46:36Z',
            'error': 'Runtime startup failed; diagnostic API retained: native Docker host profile initialization failed: native runtime service failed: parse GPU temperature from nvidia-smi: invalid digit found in string'}
        self.resume['inputs']['attempt'] = 'a' * 32
        self.resume['inputs']['config_sha256'] = self.scope['config_sha256']

    def validate(self):
        return validate_origin(self.development, self.resume, self.compose, self.scope)

    def test_accepts_failed_source_copy_then_failed_preowner_resume(self):
        self.validate()

    def test_rejects_other_failure_or_session_activation(self):
        for change in ({'error': 'native owner failed'}, {'state': 'succeeded'},
                       {'phase': 'iteration'}, {'backend_started_at': None}):
            original = copy.deepcopy(self.resume)
            self.resume.update(change)
            with self.subTest(change=change), self.assertRaises(BuildControlError): self.validate()
            self.resume = original
        self.development['inputs']['script'] = 'solve.py'
        with self.assertRaises(BuildControlError): self.validate()

    def test_rejects_changed_source_group_image_or_predecessor(self):
        for key, value in [('source_root', 'foreign'), ('image_id', 'sha256:' + 'd' * 64),
                           ('attempt', 'e' * 32), ('config_sha256', 'f' * 64)]:
            original = copy.deepcopy(self.resume)
            self.resume['inputs'][key] = value
            with self.subTest(key=key), self.assertRaises(BuildControlError): self.validate()
            self.resume = original
        self.resume['control_volume'] = 'foreign'
        with self.assertRaises(BuildControlError): self.validate()

    def test_rejects_compose_change_and_startup_script(self):
        self.compose['services']['backend']['environment']['FULLMAG_STARTUP_ENABLED'] = '1'
        self.scope['config_sha256'] = sha(canonical(self.compose))
        self.resume['config_sha256'] = self.resume['inputs']['config_sha256'] = self.scope['config_sha256']
        with self.assertRaises(BuildControlError): self.validate()

    def test_apply_requires_successful_exact_preview(self):
        inputs = {'scope': 'test'}
        preview = {'state': 'succeeded', 'inputs': inputs, 'result': {'plan_sha256': 'a' * 64}}
        require_apply_plan(preview, inputs, 'a' * 64, 'a' * 64)
        require_apply_plan({**preview, 'inputs': {**inputs, 'console_session_id': 'c' * 32}},
                           inputs, 'a' * 64, 'a' * 64)
        with self.assertRaises(BuildControlError):
            require_apply_plan({**preview, 'inputs': {**inputs, 'console_session_id': 'invalid'}},
                               inputs, 'a' * 64, 'a' * 64)
        for record, expected, current in [(None, 'a' * 64, 'a' * 64),
                ({**preview, 'state': 'failed-confirmed'}, 'a' * 64, 'a' * 64),
                ({**preview, 'inputs': {'scope': 'foreign'}}, 'a' * 64, 'a' * 64),
                (preview, 'b' * 64, 'a' * 64), (preview, 'a' * 64, 'b' * 64)]:
            with self.subTest(record=record), self.assertRaises(BuildControlError):
                require_apply_plan(record, inputs, expected, current)


@unittest.skipUnless(os.name == 'posix', 'POSIX executable shell fixture')
class PreownerProbeShellTests(unittest.TestCase):
    def dispatch(self, suffix='', source='/registered/task'):
        shell = (Path(__file__).parent / 'just_storage_shell.sh').read_text(encoding='utf-8')
        body = shell.split('  *"scripts/docker_dev.py"*)\n', 1)[1].split('\n    ;;', 1)[0]
        recipe = ('python "/ignored/scripts/docker_dev.py" --repo-root "/ignored" '
                  f"stop-preowner-probe-volume --attempt '{'a'*32}' --resume-attempt '{'b'*32}' "
                  f"--config-sha256 '{'c'*64}' --source-root '{source}' "
                  f"--image-id 'sha256:{'d'*64}' --port '3207'{suffix}")
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / 'docker_dev.py').write_text('import json,sys; print(json.dumps(sys.argv[1:]))\n')
            program = ('set -euo pipefail\nrecipe="$RECIPE"\npython_cmd="$PYTHON"\n'
                       'script_dir="$SCRIPTS"\nrepo_root="/registered/main"\n' + body)
            return subprocess.run(['bash', '--noprofile', '--norc', '-c', program],
                env={**os.environ, 'RECIPE': recipe, 'PYTHON': sys.executable, 'SCRIPTS': directory},
                capture_output=True, text=True, timeout=15)

    def test_preview_and_exact_apply_are_forwarded(self):
        for suffix in ('', " --apply --expected-plan-sha256 '" + 'e'*64 + "'"):
            result = self.dispatch(suffix)
            self.assertEqual(result.returncode, 0, result.stderr)
            args = json.loads(result.stdout)
            self.assertIn('stop-preowner-probe-volume', args)
            self.assertEqual('--apply' in args, bool(suffix))

    def test_literal_source_cannot_execute_shell_payload(self):
        source = '/task/$(printf injected);literal'
        result = self.dispatch(source=source)
        self.assertEqual(result.returncode, 0, result.stderr)
        args = json.loads(result.stdout)
        self.assertEqual(args[args.index('--source-root')+1], source)

    def test_partial_apply_and_trailing_commands_are_rejected(self):
        for suffix in (' --apply', ' --force', '; printf injected',
                       " --apply --expected-plan-sha256 '" + 'e'*64 + "'; printf injected"):
            result = self.dispatch(suffix)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertEqual(result.stdout, '')


if __name__ == '__main__':
    unittest.main()