"""Retained device pins cross the real DEV lifecycle caller boundaries."""
from contextlib import ExitStack, nullcontext
from copy import deepcopy
import hashlib
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import docker_dev
import docker_volume_dev as dev
import docker_volume_cancelled_activation_guard as cancelled
import fullmag_docker_runtime as runtime
import test_docker_native_failed_recreate as completed_fixtures
import test_docker_volume_pending_resume as resume_fixtures
import test_docker_volume_pre_admission_integration as recreate_fixtures


class RetainedDeviceLifecycleTests(unittest.TestCase):
    def test_actual_recreate_gpu_failure_precedes_stop_and_removal(self):
        for failure in (docker_dev.DirectDockerError('GPU unavailable'),
                        docker_dev.DirectDockerOutcomeUnknown('probe ownership unknown')):
            with self.subTest(failure=type(failure).__name__):
                harness = recreate_fixtures._Harness()
                self.addCleanup(harness.close)
                backend = harness.document['services']['backend']
                backend['environment']['FULLMAG_DOCKER_DEVICE_ACCESS'] = 'gpu'
                backend['gpus'] = [{'count': 'all'}]
                harness.previous['inputs']['gpu_preflight'] = 'PASS'
                harness.config_sha256 = hashlib.sha256(dev.canonical(harness.document)).hexdigest()
                harness.args.config_sha256 = harness.config_sha256
                harness.actual['frontend']['State']['Running'] = True
                helper = recreate_fixtures._helper_module(harness)
                caller = recreate_fixtures.RetainedPreAdmissionIntegrationTests()
                mutations = []
                capture = harness.docker_capture

                def observe_capture(*args, **kwargs):
                    if args[0] in ('stop', 'rm'):
                        mutations.append(args)
                    return capture(*args, **kwargs)

                def reject_gpu(*_args, **_kwargs):
                    harness.events.append('gpu-probe')
                    raise failure

                with mock.patch.object(harness, 'docker_capture', side_effect=observe_capture), \
                     mock.patch.object(docker_dev, '_resolve_gpu_access', return_value='gpu') as host, \
                     mock.patch.object(docker_dev, '_verify_docker_gpu_access', side_effect=reject_gpu) as probe:
                    with self.assertRaises(type(failure)):
                        caller._run(harness, helper=helper, device_probe=dev._probe_retained_device_access)
                self.assertEqual(mutations, [])
                self.assertNotIn('rm', harness.events)
                self.assertLess(harness.events.index('lease-enter'), harness.events.index('gpu-probe'))
                self.assertLess(harness.events.index('gpu-probe'), harness.events.index('lease-exit'))
                self.assertFalse(any(path.endswith('/retained-containers.json')
                                     for path, _value in harness.control.writes))
                host.assert_called_once_with('required')
                probe.assert_called_once_with('gpu', 'required', recreate_fixtures.IMAGE,
                                              recreate_fixtures.PROJECT)

    def test_successor_witness_drift_under_lease_refuses_stop_and_removal(self):
        from docker_volume_native_init_successor import NativeInitSuccessorContext
        harness = recreate_fixtures._Harness()
        self.addCleanup(harness.close)
        helper = recreate_fixtures._helper_module(harness)
        caller = recreate_fixtures.RetainedPreAdmissionIntegrationTests()
        first = NativeInitSuccessorContext({'previous_config_sha256': 'e' * 64}, {'pin': 'first'})
        second = NativeInitSuccessorContext(dict(first), {'pin': 'changed'})
        contexts = iter([first, second])
        def observe(*_args, **_kwargs):
            return next(contexts)
        with self.assertRaisesRegex(dev.BuildControlError, 'witness changed under recreate lease'):
            caller._run(harness, helper=helper, recovery_context=observe)
        self.assertNotIn('rm', harness.events)
        self.assertFalse(any(path.endswith('/retained-containers.json')
                             for path, _value in harness.control.writes))
        self.assertNotIn('write:recreate-services/attempts/' + '1' * 32 + '/compose.json', harness.events)

    def test_resume_passes_resolved_pin_to_actual_start_call(self):
        caller = resume_fixtures.RecreatedOperationCallerTests()
        for access in ('gpu', 'cpu'):
            with self.subTest(access=access):
                metadata = {'recreate_operation': {'operation_id': caller.old_attempt}}
                records, certificate = caller._records(
                    metadata=metadata, preproof={'config_sha256': 'e' * 64}, native_context={},
                    certificate={'image_id': caller.image, 'restart_verified': False})
                records['previous']['inputs'].update(
                    device_access=access, gpu_preflight='PASS' if access == 'gpu' else 'NOT_REQUIRED')
                backend = records['document']['services']['backend']
                backend['environment']['FULLMAG_DOCKER_DEVICE_ACCESS'] = access
                if access == 'gpu':
                    backend['gpus'] = [{'count': 'all'}]
                else:
                    backend.pop('gpus', None)
                patches = caller._common_patches(records, certificate)
                with ExitStack() as stack:
                    handles = [stack.enter_context(patch) for patch in patches]
                    args = caller._args()
                    result = dev._resume_recreated_operation(
                        args, resume_fixtures._Control(), Path('/src/fullmag'),
                        {'runtime_root': '/runtime'},
                        {'project_id': 'p', 'worktree_id': 'w', 'checkout_kind': 'worktree'})
                start = handles[10]
                self.assertEqual(result, 'started')
                self.assertEqual(start.call_args.kwargs['retained_device_access'], access)
                self.assertEqual(start.call_args.kwargs['recreation_resume_proof'], records['proof'])
                self.assertEqual(args.gpu_access, 'auto')
                self.assertEqual(records['previous']['inputs']['gpu_access_requested'], 'auto')

    def test_completed_context_preserves_verified_pin_and_refuses_receipt_drift(self):
        fixture = completed_fixtures.CompletedRecreationContinuationTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        backend = fixture.document['services']['backend']
        backend['environment']['FULLMAG_DOCKER_DEVICE_ACCESS'] = 'gpu'
        backend['gpus'] = [{'count': 'all'}]
        fixture.previous['inputs'].update(device_access='gpu', gpu_preflight='PASS')
        fixture.args.config_sha256 = hashlib.sha256(dev.canonical(fixture.document)).hexdigest()
        fixture.previous['config_sha256'] = fixture.args.config_sha256
        fixture.completed['inputs']['config_sha256'] = fixture.args.config_sha256
        context = fixture.invoke()
        self.assertEqual(context['retained_device_access'], 'gpu')
        self.assertEqual(context['reuse_state']['state'], fixture.state)
        fixture.previous['inputs'].update(device_access='cpu', gpu_preflight='NOT_REQUIRED')
        with self.assertRaisesRegex(dev.BuildControlError, 'Retained resolved device access'):
            fixture.invoke()

    def test_start_revalidates_completed_device_pin_under_new_lease(self):
        class AfterHandoff(RuntimeError):
            pass

        for observed in ('gpu', 'cpu'):
            with self.subTest(observed=observed), tempfile.TemporaryDirectory() as temporary:
                source = Path(temporary)
                reuse = {'state': source / 'state', 'operator_probe_environment_record': {}}
                args = SimpleNamespace(
                    repo_root=source, source_root=source, port=3203, profile='dev', image=None,
                    toolchain_image=None, source_manifest=None, include_untracked=None,
                    gpu_access='auto', script=None, fresh_state=False,
                    completed_recreation_attempt='a' * 32, completed_recreation_sha256='c' * 64)
                control = mock.Mock(project='fixture', image='image')
                operation = {'root': 'development/attempts/' + 'b' * 32,
                             'receipt': {'attempt': 'b' * 32}}
                control.operation.return_value = nullcontext(operation)
                current = {'reuse_state': deepcopy(reuse), 'previous_config_sha256': None,
                           'native_restart_metadata': None, 'retained_device_access': observed}
                patches = [
                    mock.patch.object(dev, 'require_host'),
                    mock.patch.object(docker_dev, '_select_source', return_value=(source, {
                        'storage_root': str(source), 'runtime_root': str(source)})),
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
                    mock.patch.object(dev, '_completed_recreation_start_context', return_value=current),
                    mock.patch.object(dev.storage, 'validate_path', side_effect=AfterHandoff),
                    mock.patch.object(dev, '_start_compose_services'),
                    mock.patch.object(cancelled, '_read_control_bytes', return_value=None),
                ]
                with ExitStack() as stack:
                    handles = [stack.enter_context(patch) for patch in patches]
                    if observed == 'gpu':
                        with self.assertRaises(AfterHandoff):
                            dev.start(args, reuse_state=reuse, retained_device_access='gpu')
                        handles[14].assert_called_once()
                    else:
                        with self.assertRaisesRegex(dev.BuildControlError, 'handoff changed'):
                            dev.start(args, reuse_state=reuse, retained_device_access='gpu')
                        handles[14].assert_not_called()
                handles[15].assert_not_called()
                handles[16].assert_called_once_with(control, cancelled.RECORD, optional=True)
                control.write.assert_not_called()
                self.assertEqual(args.gpu_access, 'auto')


if __name__ == '__main__':
    unittest.main()
