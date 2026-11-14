"""Exercise preserving continuation at the real retained-operation seam."""
import sys
from contextlib import ExitStack, contextmanager
from pathlib import Path
import tempfile

import docker_dev
import fullmag_docker_runtime as runtime
import docker_volume_cancelled_activation_guard as cancelled
from types import ModuleType, SimpleNamespace
import unittest
from unittest import mock

import docker_volume_dev as dev
from docker_build_control import BuildControlError
import test_docker_volume_pre_admission_integration as fixtures


class FailedRunResumeLifecycleTests(unittest.TestCase):
    def test_dispatch_selects_only_retained_recreation(self):
        args = SimpleNamespace()
        with mock.patch.object(dev, '_retained_operation', return_value='observed') as operation:
            self.assertEqual(dev.resume_failed_run(args), 'observed')
        operation.assert_called_once_with(args, recreate_services=True, failed_run_resume=True)

    def _run(self, *, preview=False, drift=None):
        harness = fixtures._Harness()
        self.last_harness = harness
        self.addCleanup(harness.close)
        harness.certificate['restart_verified'] = True
        harness.args.preview = preview
        harness.args.apply = not preview
        context = {'schema': 'fullmag.failed-run-resume-context.v1',
                   'plan_sha256': 'a' * 64, 'run_id': 'run-original',
                   'stop_pin': {'runtime_hashes': {'runtime_config_sha256': 'b' * 64}}}
        plan = {'plan_sha256': 'a' * 64, 'request_id': 'request-fixture'}
        helper = ModuleType('docker_volume_failed_run_resume')
        helper.prepare_resume_request = mock.Mock(return_value={'context': context, 'plan': plan})
        def revalidate(*_args, phase, **_kwargs):
            harness.events.append('resume:' + phase)
            if phase == drift:
                raise BuildControlError('pinned run changed before ' + phase)
        helper.revalidate_resume_request = mock.Mock(side_effect=revalidate)
        original = dev._retained_operation
        with mock.patch.dict(sys.modules, {'docker_volume_failed_run_resume': helper}), mock.patch.object(
            dev, '_retained_operation', side_effect=lambda args, **kw: original(args, **kw, failed_run_resume=True)
        ):
            result, started = fixtures.RetainedPreAdmissionIntegrationTests()._run(
                harness, helper=fixtures._helper_module(harness))
        return harness, helper, result, started

    def test_preview_has_no_recreate_lease_removal_or_start(self):
        harness, helper, result, started = self._run(preview=True)
        self.assertEqual(result['state'], 'preview-passed')
        self.assertEqual(result['plan_sha256'], 'a' * 64)
        self.assertNotIn('lease-enter', harness.events)
        self.assertNotIn('rm', harness.events)
        started.assert_not_called()
        helper.prepare_resume_request.assert_called_once()

    def test_apply_rechecks_under_lease_and_before_removal_then_carries_authority(self):
        harness, helper, result, started = self._run()
        self.assertEqual(result, {'started': True})
        self.assertLess(harness.events.index('lease-enter'), harness.events.index('resume:recreate-lease'))
        self.assertLess(harness.events.index('resume:before-remove'), harness.events.index('rm'))
        carried = started.call_args.kwargs['failed_run_resume_context']
        self.assertEqual(carried['context']['run_id'], 'run-original')
        self.assertEqual(carried['removal']['removed_containers'], [fixtures.BACKEND_ID, fixtures.FRONTEND_ID])
        self.assertEqual(started.call_args.args[0].script, None)
        self.assertFalse(started.call_args.args[0].fresh_state)
        self.assertNotIn('native_restart_metadata', started.call_args.kwargs)
        self.assertEqual(started.call_args.kwargs['previous_config_sha256'],'b'*64)

    def test_run_drift_before_removal_never_removes_or_starts(self):
        with self.assertRaisesRegex(BuildControlError, 'pinned run changed before before-remove'):
            self._run(drift='before-remove')
        self.assertNotIn('rm', self.last_harness.events)
        self.assertIn('lease-exit', self.last_harness.events)


    def test_lease_drift_never_reaches_removal(self):
        with self.assertRaisesRegex(BuildControlError, 'pinned run changed before recreate-lease'):
            self._run(drift='recreate-lease')
        self.assertNotIn('rm', self.last_harness.events)

    def test_incompatible_mode_is_refused_before_any_control_or_docker_call(self):
        for changes in ({'fresh_state': True}, {'script': 'replay.py'}):
            args = SimpleNamespace(fresh_state=False, script=None)
            for key, value in changes.items():
                setattr(args, key, value)
            with mock.patch.object(dev, 'BuildControl') as control, mock.patch.object(dev, 'docker_capture') as docker:
                with self.assertRaisesRegex(BuildControlError, 'requires retained recreation'):
                    dev.resume_failed_run(args)
                control.assert_not_called()
                docker.assert_not_called()

    def test_start_handoff_passes_exact_removal_proof_and_propagates_drift(self):
        helper = ModuleType('docker_volume_failed_run_resume')
        helper.revalidate_resume_request = mock.Mock(side_effect=BuildControlError('removal receipt changed'))
        handoff = {'context': {'request_id': 'original'}, 'previous': {}, 'document': {},
                   'actual': {}, 'state': '/tmp/retained', 'removal': {'attempt': 'exact-removal'}}
        with mock.patch.dict(sys.modules, {'docker_volume_failed_run_resume': helper}):
            with self.assertRaisesRegex(BuildControlError, 'removal receipt changed'):
                dev._revalidate_failed_run_handoff('control', 'args', handoff, phase='before-start')
        call = helper.revalidate_resume_request.call_args
        self.assertEqual(call.kwargs, {'phase': 'before-start', 'removal': handoff['removal']})
        self.assertEqual(call.args[2], handoff['context'])


    def test_actual_start_revalidates_under_its_new_lease_before_state_writes(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            reuse = {'state': source / 'state', 'operator_probe_environment_record': {}}
            args = SimpleNamespace(repo_root=source, source_root=source, port=3243,
                profile='dev', image=None, toolchain_image=None, source_manifest=None,
                include_untracked=None, gpu_access='auto', script=None, fresh_state=False)
            control = mock.Mock(project='fixture', image='image')
            control.read.return_value = None
            events = []
            @contextmanager
            def lease(*_args, **_kwargs):
                events.append('start-lease-enter')
                yield {'root': 'development/attempts/' + 'b' * 32,
                       'receipt': {'attempt': 'b' * 32}}
            control.operation.side_effect = lease
            def drift(*_args, **kwargs):
                self.assertEqual(events, ['start-lease-enter'])
                self.assertEqual(kwargs, {'phase': 'before-start'})
                raise BuildControlError('pinned run drift before start')
            compose = mock.Mock()
            patches = [
                mock.patch.object(dev, 'require_host'),
                mock.patch.object(docker_dev, '_select_source', return_value=(source,
                    {'storage_root': str(source), 'runtime_root': str(source)})),
                mock.patch.object(docker_dev, '_compose_identity', return_value={
                    'project_name': 'fixture', 'project_id': 'project',
                    'worktree_id': 'worktree', 'checkout_kind': 'worktree'}),
                mock.patch.object(dev, '_session_host'),
                mock.patch.object(dev, 'validate_host_path'),
                mock.patch.object(dev, 'local_volume'),
                mock.patch.object(docker_dev, '_assert_no_running_fullmag'),
                mock.patch.object(runtime, 'assert_loopback_port_available'),
                mock.patch.object(dev, '_operator_probe_record_from_fields', return_value={}),
                mock.patch.object(dev, 'build_volume_toolchain', return_value={
                    'inputs': {'build_args': {'FULLMAG_CUDA_BASE_IMAGE': 'image'}}}),
                mock.patch.object(dev, 'BuildControl', return_value=control),
                mock.patch.object(dev, 'build_volume_runtime_images', return_value={
                    'backend': {'image_id': 'image'}}),
                mock.patch.object(dev, '_probe_retained_device_access', return_value='gpu'),
                mock.patch.object(dev, '_revalidate_failed_run_handoff', side_effect=drift),
                mock.patch.object(dev, '_start_compose_services', compose),
                mock.patch.object(cancelled, '_read_control_bytes', return_value=None),
            ]
            with ExitStack() as stack:
                for item in patches:
                    stack.enter_context(item)
                with self.assertRaisesRegex(BuildControlError, 'pinned run drift before start'):
                    dev.start(args, reuse_state=reuse, retained_device_access='gpu',
                              previous_config_sha256='f'*64,
                              failed_run_resume_context={'context': {'request_id': 'exact',
                                  'stop_pin': {'runtime_hashes': {'runtime_config_sha256': 'f'*64}}}})
            compose.assert_not_called()
            control.write.assert_not_called()


    def test_start_rejects_missing_or_mismatched_runtime_config_pin_before_io(self):
        for context,pin in (({'context':{}},'b'*64),
                ({'context':{'stop_pin':{'runtime_hashes':{'runtime_config_sha256':'a'*64}}}},'b'*64)):
            with self.subTest(context=context),mock.patch.object(
                    dev,'require_host',side_effect=AssertionError('IO before config pin check')) as host:
                with self.assertRaisesRegex(BuildControlError,'config.*pin|pinned.*config'):
                    dev.start(SimpleNamespace(script=None),reuse_state={},
                        previous_config_sha256=pin,failed_run_resume_context=context)
                host.assert_not_called()


if __name__ == '__main__':
    unittest.main()
