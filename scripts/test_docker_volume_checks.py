"""Fail-closed certificates for interpreted checks in an offline group helper."""
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_volume_checks as checks


def valid_result():
    return {
        'exit_code': 0, 'source_inputs_stable': True,
        'source_mount_readonly': True, 'control_mount_writable': True,
        'tmpdir': '/control/verification/offline-check-tmp', 'stdout': '', 'stderr': '',
        'source_files': {'/opt/fullmag/source/scripts/' + name + '.py': 'a' * 64
                         for name in ('test_fixture', 'docker_build_control', 'docker_volume_dev', 'docker_volume_activate',
                                      'docker_volume_stop_failed',
                                      'docker_volume_checks', 'docker_shared_build_storage',
                                      'docker_backend_volume_cache', 'docker_volume_cache_maintenance',
                                      'docker_cache_retirement', 'docker_worktree_finish')},
    }


class OfflineCertificateTests(unittest.TestCase):
    def test_accepts_complete_certificate_and_preserves_failed_test_exit(self):
        result = valid_result()
        self.assertIs(checks._validate_offline_result(result, ['test_fixture']), result)
        result['exit_code'] = 1
        self.assertEqual(checks._validate_offline_result(result, ['test_fixture'])['exit_code'], 1)

    def test_selected_optional_implementation_cannot_be_omitted(self):
        for optional in checks.OPTIONAL_IMPLEMENTATIONS:
            result = valid_result()
            required = (*checks.BASE_IMPLEMENTATIONS, optional)
            with self.subTest(implementation=optional):
                with self.assertRaises(checks.BuildControlError):
                    checks._validate_offline_result(result, ['test_fixture'], implementations=required)
                result['source_files']['/opt/fullmag/source/scripts/' + optional + '.py'] = 'b' * 64
                self.assertIs(checks._validate_offline_result(result, ['test_fixture'], implementations=required), result)

    def test_partial_malformed_or_false_certificate_cannot_pass(self):
        variants = [None, [], {'exit_code': 0}]
        for key in valid_result():
            missing = valid_result()
            missing.pop(key)
            variants.append(missing)
        for flag in ('source_inputs_stable', 'source_mount_readonly', 'control_mount_writable'):
            for value in (False, None, 1, 'true'):
                bad = valid_result()
                bad[flag] = value
                variants.append(bad)
        for code in (False, '0', None, 256):
            bad = valid_result()
            bad['exit_code'] = code
            variants.append(bad)
        for value in variants:
            with self.subTest(value=value):
                with self.assertRaises(checks.BuildControlError):
                    checks._validate_offline_result(value, ['test_fixture'])

    def test_unbound_or_malformed_source_map_cannot_pass(self):
        bad_maps = [{}, {'/tmp/test_fixture.py': 'a' * 64},
                    {'/opt/fullmag/source/scripts/../test_fixture.py': 'a' * 64},
                    {'/opt/fullmag/source/scripts/test_fixture.py': 'not-a-digest'}]
        for files in bad_maps:
            bad = valid_result()
            bad['source_files'] = files
            with self.subTest(files=files), self.assertRaises(checks.BuildControlError):
                checks._validate_offline_result(bad, ['test_fixture'])
        for name in valid_result()['source_files']:
            bad = valid_result()
            bad['source_files'].pop(name)
            with self.subTest(missing_source=name), self.assertRaises(checks.BuildControlError):
                checks._validate_offline_result(bad, ['test_fixture'])
        bad = valid_result()
        bad['compose_project'] = 'foreign'
        with self.assertRaises(checks.BuildControlError):
            checks._validate_offline_result(bad, ['test_fixture'])


import copy
import json
import os
import shutil
import subprocess
import tempfile
from unittest import mock
import docker_dev_codegen as codegen


class OfflineHostTests(unittest.TestCase):
    def test_offline_linux_uses_the_host_adapter_before_inspecting_the_group(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory).resolve()
            with mock.patch.object(checks.sys, 'platform', 'linux'), \
                 mock.patch.object(checks.sys, 'argv', ['checks', '--source-root', str(source),
                     '--offline', '--modules', 'test_docker_volume_receipts']), \
                 mock.patch.object(checks, 'require_host') as host, \
                 mock.patch.object(checks.storage, 'resolve_layout', side_effect=RuntimeError('selected group')):
                with self.assertRaisesRegex(RuntimeError, 'selected group'):
                    checks.main()
            host.assert_called_once_with()

    def test_unsupported_host_is_rejected_before_storage_or_docker(self):
        with mock.patch.object(checks.sys, 'argv', ['checks', '--source-root', '/selected',
                 '--offline', '--modules', 'test_docker_volume_receipts']), \
             mock.patch.object(checks, 'require_host', side_effect=ValueError('unsupported host')), \
             mock.patch.object(checks.storage, 'resolve_layout') as resolve, \
             mock.patch.object(checks, 'docker_capture') as docker:
            with self.assertRaisesRegex(ValueError, 'unsupported host'):
                checks.main()
        resolve.assert_not_called()
        docker.assert_not_called()


class FrontendImportCheckTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        paths = (*checks.IMPORT_FILES, *checks.ANTENNA_FILES, *checks.VISUALIZATION_FILES, 'scripts/typecheck-control-room.mjs', 'tsconfig.typecheck.json',
                 'tsconfig.json', 'next.config.ts', 'next.config.test.ts', 'vitest.config.ts', 'eslint.config.mjs', 'package.json',
                 'src/kernel/api/generated/openapi-v2.json', 'src/kernel/api/generated/openapi-v2-types.ts',
                 'src/kernel/api/generated/openapi-v2-client.ts', 'src/kernel/api/generated/openapi-v2-paths.ts')
        for path in paths:
            target = self.root / 'apps/control-room' / path
            target.parent.mkdir(parents=True, exist_ok=True); target.write_text('fixture')
        self.control = mock.Mock(project='fullmag-selected')
        self.documents = {name: {'Id': name+'-exact-id', 'Image': 'sha256:image',
            'Config': {'Image': 'immutable-image', 'Env':['FULLMAG_FRONTEND_HOST_PORT=3202']}, 'State': {'Running': True, 'StartedAt': 'exact-start',
            'Health': {'Status': 'healthy'}}} for name in ('backend', 'frontend')}
        self.running = mock.patch.object(codegen, '_running_service', side_effect=lambda project,name,*args: (name,self.documents[name])).start()
        self.volumes = mock.patch.object(codegen, '_inspect_technical_volumes', return_value={'volume': 'same'}).start()
        self.execute = mock.patch.object(codegen, '_run_frontend', return_value=(b'pass', b'')).start()
        self.head = mock.patch.object(checks.storage, 'git', return_value='a'*40).start()
        import docker_development_inputs as frontend_inputs
        self.metadata = mock.patch.object(frontend_inputs, 'describe', return_value={'files': []}).start()
        self.view = mock.patch.object(frontend_inputs, 'frontend_view', return_value={'files': []}).start()
        self.addCleanup(mock.patch.stopall)

    def run_checks(self, scope='frontend-import'):
        result = checks.frontend_import_checks(self.control, self.root, {'worktree_id': 'selected'}, scope=scope)
        return result, self.control.write.call_args.args[1]

    def test_fixed_commands_use_only_existing_frontend_and_volume_paths(self):
        result, receipt = self.run_checks()
        self.assertEqual(result, 0); self.assertEqual(receipt['state'], 'succeeded')
        self.assertEqual(self.execute.call_count, 4)
        for call in self.execute.call_args_list:
            self.assertEqual(call.args[0], 'frontend-exact-id')
            command = call.args[1]
            self.assertEqual(command[:3], ('/usr/bin/flock', '-n', '/state/development/cache/.fullmag-frontend-import-checks.lock'))
            self.assertIn('FULLMAG_FRONTEND_ROOT=/state/development/cache', command)
            self.assertIn('TMPDIR=/state/development/tmp', command)
            self.assertNotIn('install', command)
        self.assertEqual([entry['name'] for entry in receipt['commands']], ['prepare','typecheck','vitest','eslint'])
        self.assertEqual(self.execute.call_args_list[2].args[1][-2:], ('--pool=threads','--maxWorkers=1'))
        self.assertIn(checks.IMPORT_FILES[1], self.execute.call_args_list[2].args[1])
        self.assertIn(checks.IMPORT_FILES[3], self.execute.call_args_list[2].args[1])
        for path in ('src/modules/start/model/pythonImport.test.ts', 'src/modules/start/model/importFormats.test.ts',
                     'src/modules/start/sections/ImportSection.test.tsx', 'src/modules/start/ui/CreateProjectAction.test.tsx','src/kernel/layout/shellCommands.test.ts',
                     'next.config.test.ts'):
            self.assertIn(path, self.execute.call_args_list[2].args[1])

    def test_known_typecheck_failure_preserves_failure_and_runs_other_independent_gates(self):
        self.execute.side_effect = [(b'',b''),codegen.CodegenError('type mismatch', stdout=b'compiler diagnostic', stderr=b'wrapper failure', exit_code=7),(b'vitest pass',b''),(b'lint pass',b'')]
        result, receipt = self.run_checks()
        self.assertEqual(result, 1); self.assertEqual(receipt['state'], 'failed')
        self.assertEqual(self.execute.call_count, 4)
        self.assertEqual(receipt['commands'][1]['state'], 'failed')
        self.assertEqual(receipt['commands'][1]['exit_code'], 7)
        logs = dict(call.args for call in self.control.write_bytes.call_args_list)
        self.assertEqual(logs['verification/frontend-import-checks/typecheck.stdout.log'], b'compiler diagnostic')
        self.assertEqual(logs['verification/frontend-import-checks/typecheck.stderr.log'], b'wrapper failure')

    def test_unknown_exec_stops_followups_and_is_not_downgraded_by_later_probe_failure(self):
        self.execute.side_effect = [(b'',b''),codegen.CodegenError('observation timeout',reconciliation_required=True)]
        self.volumes.side_effect = [{'volume':'same'},codegen.CodegenError('inspection unavailable')]
        result, receipt = self.run_checks()
        self.assertEqual(result, 2); self.assertEqual(receipt['state'], 'outcome-unknown')
        self.assertTrue(receipt['reconciliation_required']); self.assertEqual(self.execute.call_count, 2)

    def test_service_restart_during_checks_refuses_success(self):
        def change(*args,**kwargs):
            self.documents['frontend']['State']['StartedAt'] = 'restarted'
            return b'pass',b''
        self.execute.side_effect = change
        result, receipt = self.run_checks()
        self.assertEqual(result, 1); self.assertEqual(receipt['state'], 'failed')
        self.assertIn('changed during checks', receipt['error'])

    def test_input_edit_during_checks_refuses_success(self):
        def change(*args,**kwargs):
            (self.root / 'apps/control-room' / checks.IMPORT_FILES[0]).write_text('edited')
            return b'pass',b''
        self.execute.side_effect = change
        result, receipt = self.run_checks()
        self.assertEqual(result, 1); self.assertIn('changed during checks', receipt['error'])



    def test_stale_shadow_refuses_before_any_command(self):
        self.view.side_effect = ValueError('frontend frozen metadata is stale')
        result, receipt = self.run_checks()
        self.assertEqual(result, 1); self.execute.assert_not_called()
        self.assertEqual(receipt['state'], 'failed')

    def test_shadow_changed_after_commands_refuses_qualification(self):
        self.view.side_effect = [{'files': []}, ValueError('shadow changed')]
        result, receipt = self.run_checks()
        self.assertEqual(result, 1); self.assertEqual(self.execute.call_count, 4)
        self.assertEqual(receipt['state'], 'failed')


    def test_visualization_scope_runs_lint_in_separate_bounded_processes_without_vitest(self):
        result, receipt = self.run_checks('frontend-visualization')
        self.assertEqual(result, 0)
        commands = receipt['commands']
        lint = [command for command in commands if command['name'].startswith('eslint-')]
        self.assertEqual(len(lint), len(checks.VISUALIZATION_FILES))
        for command, path in zip(lint, checks.VISUALIZATION_FILES):
            self.assertEqual(command['arguments'][-2:], [path, '--max-warnings=0'])
            self.assertIn('NODE_OPTIONS=--max-old-space-size=4096', command['arguments'])
        self.assertNotIn('vitest', str([command['arguments'] for command in commands]))
        self.assertEqual(commands[-2]['name'], 'architecture')
        self.assertEqual(commands[-1]['name'], 'api-hygiene')

    def test_antenna_scope_uses_exact_geometry_tests_lint_and_separate_receipt(self):
        result, receipt = self.run_checks('frontend-antenna')
        self.assertEqual(result, 0)
        self.assertEqual(receipt['scope'], 'frontend-antenna')
        self.assertEqual(receipt['schema'], 'fullmag.volume-dev-frontend-antenna-checks.v1')
        self.assertEqual(self.control.write.call_args.args[0], 'verification/frontend-antenna-checks/receipt.json')
        self.assertTrue(set(checks.ANTENNA_FILES) <= set(receipt['selected_frontend_input_hashes']))
        commands = [call.args[1] for call in self.execute.call_args_list]
        self.assertEqual(commands[1][-len(checks.FRONTEND_COMMANDS[1][1]):], checks.FRONTEND_COMMANDS[1][1])
        self.assertEqual(commands[2][-len(checks.ANTENNA_COMMANDS[2][1]):], checks.ANTENNA_COMMANDS[2][1])
        self.assertEqual(commands[3][-len(checks.ANTENNA_COMMANDS[3][1]):], checks.ANTENNA_COMMANDS[3][1])
        self.assertEqual(checks.ANTENNA_TESTS, (
            'src/modules/inspector/panels/antenna/MicrostripGeometryEditorModel.test.ts',
            'src/kernel/authoring/geometryLifecycleCommandContributions.test.ts'))
        self.assertEqual(self.view.call_count, 2)
        for command in commands:
            self.assertEqual(command[:3], ('/usr/bin/flock', '-n', '/state/development/cache/.fullmag-frontend-import-checks.lock'))
            self.assertNotIn('install', command)
        for entry in receipt['commands']:
            for stream in ('stdout', 'stderr'):
                self.assertTrue(entry[stream]['path'].startswith('verification/frontend-antenna-checks/'))

    def test_each_antenna_source_edit_during_checks_refuses_qualification(self):
        for path in checks.ANTENNA_FILES:
            with self.subTest(path=path):
                target = self.root / 'apps/control-room' / path
                def change(*args, **kwargs):
                    target.write_text('edited')
                    return b'pass', b''
                self.execute.side_effect = change
                try:
                    result, receipt = self.run_checks('frontend-antenna')
                    self.assertEqual(result, 1)
                    self.assertIn('changed during checks', receipt['error'])
                finally:
                    target.write_text('fixture')

    def test_antenna_scope_retains_stale_metadata_and_unknown_exec_guards(self):
        self.view.side_effect = ValueError('stale antenna frozen metadata')
        result, receipt = self.run_checks('frontend-antenna')
        self.assertEqual(result, 1)
        self.execute.assert_not_called()
        self.view.side_effect = None
        self.execute.side_effect = [(b'', b''), codegen.CodegenError('timeout', reconciliation_required=True)]
        result, receipt = self.run_checks('frontend-antenna')
        self.assertEqual(result, 2)
        self.assertEqual(receipt['state'], 'outcome-unknown')
        self.assertEqual(self.execute.call_count, 2)

    def test_frontend_scope_is_closed_before_any_service_or_command(self):
        for scope in ('all', 'frontend-antenna-extra', '--files arbitrary.ts', '../antenna'):
            with self.subTest(scope=scope), self.assertRaises(checks.BuildControlError):
                self.run_checks(scope)
        self.running.assert_not_called()
        self.execute.assert_not_called()

    def test_cli_routes_only_the_closed_antenna_profile_to_existing_frontend(self):
        identity = {'worktree_id': 'selected'}
        configuration = {'services': {'fem-gpu-toolchain': {'build': {'args': {'FULLMAG_CUDA_BASE_IMAGE': 'fixed-helper'}}}}}
        with mock.patch.object(checks.sys, 'argv', ['checks', '--source-root', str(self.root), '--scope', 'frontend-antenna']), \
             mock.patch.object(checks.storage, 'resolve_layout', return_value='layout'), \
             mock.patch.object(checks, 'compose_project_identity', return_value=identity), \
             mock.patch('docker_build_control.toolchain_configuration', return_value=configuration), \
             mock.patch.object(checks, 'BuildControl', return_value=self.control), \
             mock.patch.object(checks, 'frontend_import_checks', return_value=0) as frontend, \
             mock.patch.object(checks, 'docker_capture') as backend:
            self.assertEqual(checks.main(), 0)
        frontend.assert_called_once_with(self.control, self.root.resolve(), identity, scope='frontend-antenna')
        backend.assert_not_called()
        with mock.patch.object(checks.sys, 'argv', ['checks', '--source-root', str(self.root), '--scope', 'frontend-antenna-extra']), \
             mock.patch.object(checks.sys, 'stderr'), mock.patch.object(checks.storage, 'resolve_layout') as resolve:
            with self.assertRaises(SystemExit) as error:
                checks.main()
        self.assertEqual(error.exception.code, 2)
        resolve.assert_not_called()


class FrontendAntennaShellBoundaryTests(unittest.TestCase):
    def dispatch(self, recipe):
        source = (Path(__file__).resolve().parent / 'just_storage_shell.sh').read_text(encoding='utf8')
        body = source.split('  *"scripts/docker_volume_checks.py"*)\n', 1)[1].split('\n    ;;', 1)[0]
        with tempfile.TemporaryDirectory(prefix='fullmag-antenna-checks-shell-') as directory:
            script_dir = Path(directory)
            (script_dir / 'docker_volume_checks.py').write_text(
                'import json,sys; print(json.dumps(sys.argv[1:]))\n', encoding='utf8')
            environment = dict(os.environ, RECIPE_LITERAL=recipe, FIXED_PYTHON=sys.executable,
                               FIXED_SCRIPT_DIR=str(script_dir))
            program = ('set -euo pipefail\nrecipe="$RECIPE_LITERAL"\n'
                       'python_cmd="$FIXED_PYTHON"\nscript_dir="$FIXED_SCRIPT_DIR"\n' + body)
            bash = '/bin/bash' if os.name == 'posix' else (shutil.which('bash') or 'bash')
            return subprocess.run([bash, '--noprofile', '--norc', '-c', program],
                                  env=environment, capture_output=True, text=True, timeout=15)

    def test_dispatches_literal_antenna_scope_as_fixed_argv(self):
        source_root = '/selected/$(printf literal);worktree'
        recipe = ('python "/ignored/scripts/docker_volume_checks.py" '
                  f"--source-root '{source_root}' --scope 'frontend-antenna'")
        result = self.dispatch(recipe)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), ['--source-root', source_root, '--scope', 'frontend-antenna'])

    def test_rejects_scope_suffix_extra_files_and_composite_commands(self):
        recipe = 'python "/ignored/scripts/docker_volume_checks.py" --source-root \'/selected\' --scope \'frontend-antenna\''
        for candidate in (recipe + '; printf injected', recipe + " --files 'arbitrary.ts'",
                          recipe.replace('frontend-antenna', 'frontend-antenna-extra'),
                          recipe.replace('frontend-antenna', 'frontend-antenna; printf injected')):
            with self.subTest(candidate=candidate):
                result = self.dispatch(candidate)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse(result.stdout.strip())

    def test_dispatches_pinned_oracle_as_one_literal_argument(self):
        source = "/selected/$(printf literal);worktree"
        wheel = "/opt/fullmag/control/verification/task/mpmath-1.3.0-py3-none-any.whl"
        recipe = ('python "/ignored/scripts/docker_volume_checks.py" '
                  f"--source-root '{source}' --scope 'all' --oracle-wheel '{wheel}'")
        result = self.dispatch(recipe)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [
            '--source-root', source, '--scope', 'all', '--oracle-wheel', wheel,
        ])
        for suffix in ("; printf injected", " --oracle-wheel '/other.whl'"):
            rejected = self.dispatch(recipe + suffix)
            self.assertEqual(rejected.returncode, 2, rejected.stderr)
            self.assertFalse(rejected.stdout.strip())


@unittest.skipIf(os.name == 'nt', 'Container wheel filesystem is POSIX')
class OracleWheelBindingTests(unittest.TestCase):
    def setUp(self):
        import hashlib
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / 'source'
        self.pin = self.source / 'scripts/antenna_triangle_surface_oracle.py'
        self.pin.parent.mkdir(parents=True)
        self.directory = self.root / 'verification'
        self.wheel = self.directory / 'task/mpmath-1.3.0-py3-none-any.whl'
        self.wheel.parent.mkdir(parents=True)
        self.wheel.write_bytes(b'registered fixture wheel')
        self.digest = hashlib.sha256(self.wheel.read_bytes()).hexdigest()
        self.pin.write_text('WHEEL_SHA = ' + repr(self.digest) + '\n')
        patcher = mock.patch.object(checks, '_ORACLE_WHEEL_ROOT', self.directory)
        patcher.start()
        self.addCleanup(patcher.stop)

    def binding(self):
        return checks._oracle_wheel_binding(self.source, str(self.wheel))

    def test_accepts_pinned_file_and_records_its_identity(self):
        binding = self.binding()
        self.assertEqual(binding['sha256'], self.digest)
        verified = checks._verify_oracle_wheel(binding, self.source)
        self.assertEqual(verified['path'], str(self.wheel))
        self.assertEqual(verified['sha256'], self.digest)
        self.assertEqual(checks._verify_oracle_wheel(binding, self.source), verified)
        self.assertIsNone(checks._oracle_wheel_binding(self.source, None))

    def test_rejects_unbound_or_noncanonical_references(self):
        for reference in (
            str(self.root / self.wheel.name),
            str(self.directory / '../task' / self.wheel.name),
            str(self.directory / 'task' / 'other.whl'),
            str(self.directory / 'task:extra' / self.wheel.name),
            str(self.directory) + '//task/' + self.wheel.name,
        ):
            with self.subTest(reference=reference), self.assertRaises(checks.BuildControlError):
                checks._oracle_wheel_binding(self.source, reference)

    def test_rejects_wrong_bytes_changed_pin_symlink_and_oversize(self):
        binding = self.binding()
        self.wheel.write_bytes(b'changed')
        with self.assertRaisesRegex(checks.BuildControlError, 'digest'):
            checks._verify_oracle_wheel(binding, self.source)
        self.wheel.write_bytes(b'registered fixture wheel')
        self.pin.write_text('WHEEL_SHA = ' + repr('f' * 64) + '\n')
        with self.assertRaisesRegex(checks.BuildControlError, 'binding'):
            checks._verify_oracle_wheel(binding, self.source)
        self.pin.write_text('WHEEL_SHA = ' + repr(self.digest) + '\n')
        target = self.directory / 'wheel-copy'
        self.wheel.rename(target)
        self.wheel.symlink_to(target)
        with self.assertRaisesRegex(checks.BuildControlError, 'canonical'):
            checks._verify_oracle_wheel(binding, self.source)
        self.wheel.unlink()
        self.wheel.write_bytes(b'x' * (2 * 1024 * 1024 + 1))
        with self.assertRaisesRegex(checks.BuildControlError, 'bounded'):
            checks._verify_oracle_wheel(binding, self.source)

    def test_rejects_a_mutated_reference_without_reading_another_file(self):
        binding = self.binding()
        for update in ({'sha256': 'f' * 64}, {'extra': True}, {'source_sha256': 'f' * 64}):
            with self.subTest(update=update), self.assertRaises(checks.BuildControlError):
                checks._verify_oracle_wheel({**binding, **update}, self.source)

    def test_rejects_oracle_for_other_scopes_before_storage(self):
        for suffix in (['--scope', 'frontend-tools'], ['--offline', '--modules', 'test_fixture']):
            with self.subTest(suffix=suffix), \
                 mock.patch.object(checks.sys, 'argv', ['checks', '--source-root', str(self.source),
                     '--oracle-wheel', str(self.wheel), *suffix]), \
                 mock.patch.object(checks.storage, 'resolve_layout') as resolve:
                with self.assertRaisesRegex(checks.BuildControlError, 'only.*all'):
                    checks.main()
            resolve.assert_not_called()





class InitialOfflineImageTests(unittest.TestCase):
    def test_image_is_bound_to_selected_attempt_source_and_compose(self):
        identity = {'project_name': 'fullmag-worktree-test', 'source_root': '/source',
                    'worktree_id': 'test', 'project_id': 'project'}
        image = 'sha256:' + 'a' * 64
        receipt = {'phase': 'development', 'attempt': 'b' * 32,
                   'compose_project': identity['project_name'],
                   'inputs': {'source_root': '/source', 'source_worktree_id': 'test',
                              'source_project_id': 'project', 'image_id': image}}
        document = {'name': identity['project_name'], 'services': {'backend': {'image': image}}}
        self.assertEqual(checks._initial_offline_image(receipt, document, identity, 'b' * 32), image)
        for field, value in [('source_root', '/foreign'), ('source_worktree_id', 'foreign'),
                             ('source_project_id', 'foreign'), ('image_id', 'mutable:tag')]:
            bad = copy.deepcopy(receipt)
            bad['inputs'][field] = value
            with self.subTest(field=field), self.assertRaises(checks.BuildControlError):
                checks._initial_offline_image(bad, document, identity, 'b' * 32)
        with self.assertRaises(checks.BuildControlError):
            checks._initial_offline_image(receipt, document, identity, 'c' * 32)
        bad_document = copy.deepcopy(document)
        bad_document['services']['backend']['image'] = 'sha256:' + 'd' * 64
        with self.assertRaises(checks.BuildControlError):
            checks._initial_offline_image(receipt, bad_document, identity, 'b' * 32)


if __name__ == '__main__':
    unittest.main()
