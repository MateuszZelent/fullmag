import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch
import unittest

import run_de_100nm_pilot as pilot


class ShiftedKspTypeTests(unittest.TestCase):
    def context(self):
        return SimpleNamespace(source_tree=Path('/capsule'), runtime_root=Path('/runtime'),
                               image_digest='sha256:test',
                               job={'job_id':'a'*32,'profile':'fem-cpu-slepc-runtime-v2'})

    def test_default_does_not_override_native_type(self):
        command = pilot.compose_command(self.context(), Path('/outputs'), pilot='de-smoke-k-25')
        self.assertNotIn('FULLMAG_FLOQUET_SHIFTED_KSP_TYPE', command[-1])

    def test_each_supported_type_is_explicit_in_managed_command(self):
        for method in ('gmres','fgmres'):
            with self.subTest(method=method):
                command = pilot.compose_command(self.context(), Path('/outputs'),
                                                pilot='de-smoke-k-25', shifted_ksp_type=method)
                self.assertIn('export FULLMAG_FLOQUET_SHIFTED_KSP_TYPE='+method, command[-1])
                self.assertIn('--backend fem --mode strict --precision double', command[-1])

    def test_invalid_type_and_de100_are_rejected_before_execution(self):
        for method in ('cg','fgmres;echo nope', '', True):
            with self.subTest(method=method), self.assertRaises(pilot.managed.BenchmarkError):
                pilot.compose_command(self.context(), Path('/outputs'), pilot='de-smoke-k2',
                                      shifted_ksp_type=method)
        with self.assertRaises(pilot.managed.BenchmarkError):
            pilot.compose_command(self.context(), Path('/outputs'), shifted_ksp_type='fgmres')

    def test_receipt_records_requested_type_even_when_solver_fails(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            context = SimpleNamespace(layout={'repo_root':str(root)}, image_digest='sha256:test')
            with patch.object(pilot.managed, '_run_request', return_value={'source':{},'job':{},'runtime':{}}), \
                 patch.object(pilot.managed, '_compose_environment', return_value={}), \
                 patch.object(pilot.subprocess, 'run', return_value=SimpleNamespace(returncode=7)), \
                 patch.object(pilot.managed, '_cleanup_benchmark_container', return_value={'status':'absent'}), \
                 patch('builtins.print'):
                code = pilot.execute(context, root, ['docker'], 'abc', pilot='de-smoke-k2',
                                     shifted_ksp_type='fgmres')
            request = json.loads((root/'run-request.json').read_text(encoding='utf-8'))
            result = json.loads((root/'run-result.json').read_text(encoding='utf-8'))
            self.assertEqual(request['shifted_ksp_type_diagnostic_requested'],'fgmres')
            self.assertEqual(result['shifted_ksp_type_diagnostic_requested'],'fgmres')
            self.assertEqual(code,1)
            self.assertEqual(result['status'],'failed')

    def test_cli_rejects_de100_override_before_storage_or_docker(self):
        with patch.object(pilot.managed.fullmag_storage, 'resolve_layout') as resolve, \
             patch.object(pilot.managed.fullmag_storage, 'initialize') as initialize, \
             patch.object(pilot.managed, '_inspect_image') as inspect_image, \
             patch.object(pilot.managed, '_new_output_dir') as output:
            code = pilot.main(['--job-id','a'*32,'--pilot','de100',
                               '--shifted-ksp-type','fgmres'])
        self.assertEqual(code,2)
        resolve.assert_not_called()
        initialize.assert_not_called()
        inspect_image.assert_not_called()
        output.assert_not_called()

    def test_unsupported_trial_scope_rejected_before_storage(self):
        cases = [
            ['--pilot','de-smoke-k0'],
            ['--pilot','de-smoke-k2','--spectral-target','nearest'],
            ['--pilot','de-smoke-nearest-k2'],
            ['--pilot','de-smoke-k2','--dense-oracle'],
        ]
        for options in cases:
            with self.subTest(options=options), \
                 patch.object(pilot.managed.fullmag_storage, 'resolve_layout') as resolve, \
                 patch.object(pilot.managed.fullmag_storage, 'initialize') as initialize:
                code = pilot.main(['--job-id','a'*32,'--shifted-ksp-type','fgmres',*options])
            self.assertEqual(code,2)
            resolve.assert_not_called()
            initialize.assert_not_called()

    def test_successful_process_cannot_bypass_trial_validation(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            context = SimpleNamespace(layout={'repo_root':str(root)}, image_digest='sha256:test')
            with patch.object(pilot.managed, '_run_request', return_value={'source':{},'job':{},'runtime':{}}), \
                 patch.object(pilot.managed, '_compose_environment', return_value={}), \
                 patch.object(pilot.subprocess, 'run', return_value=SimpleNamespace(returncode=0)), \
                 patch.object(pilot.managed, '_validate_case_artifacts', return_value={}), \
                 patch.object(pilot, 'validate_rows', return_value={'sample_count':1}), \
                 patch.object(pilot, 'validate_shifted_ksp_trial', side_effect=ValueError('old runtime has no true criterion')) as trial, \
                 patch.object(pilot.managed, '_cleanup_benchmark_container', return_value={'status':'absent'}), \
                 patch('builtins.print'):
                code = pilot.execute(context, root, ['docker'], 'abc', pilot='de-smoke-k2',
                                     shifted_ksp_type='fgmres', shifted_ksp_rtol='1e-9')
            result = json.loads((root/'run-result.json').read_text(encoding='utf-8'))
            trial.assert_called_once_with(root/'de-smoke-k2','k2','fgmres','1e-9')
            self.assertEqual(code,1)
            self.assertEqual(result['return_code'],0)
            self.assertEqual(result['status'],'failed')
            self.assertIn('no true criterion',result['error'])



if __name__ == '__main__':
    unittest.main()
