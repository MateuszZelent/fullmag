"""Retained device pins cross the real DEV lifecycle caller boundaries."""
from contextlib import ExitStack, nullcontext
from copy import deepcopy
import hashlib
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import docker_dev_network
import docker_dev
import docker_volume_dev as dev
import docker_volume_cancelled_activation_guard as cancelled
import docker_volume_linux_supervision_stop as supervision_stop
import fullmag_docker_runtime as runtime
import test_docker_native_failed_recreate as completed_fixtures
import test_docker_volume_pending_resume as resume_fixtures
import test_docker_volume_pre_admission_integration as recreate_fixtures


class RetainedDeviceLifecycleTests(unittest.TestCase):
    def _run_retained_subnet_entry(self, *, document, route, subnet_override=None):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            before = deepcopy(document)
            previous = {
                "state": "succeeded",
                "compose_project": "fixture",
                "inputs": {
                    "image_id": "sha256:" + "a" * 64,
                    "source_root": str(source),
                    "gpu_access_requested": "auto",
                },
            }
            identity = {"project_name": "fixture", "worktree_id": "worktree", "checkout_kind": "worktree"}
            layout = {"storage_root": str(source), "runtime_root": str(source)}
            control = mock.Mock(project="fixture")
            control.read.side_effect = [previous, document]
            args = SimpleNamespace(
                capture_terminal_observation=False, quiesce_api=False, helper_source_root=None,
                helper_source_commit=None, recovery_authorization=None, headless=False,
                repo_root=source, source_root=source, attempt="b" * 32,
                config_sha256=hashlib.sha256(dev.canonical(document)).hexdigest(),
                network_subnet=subnet_override, fresh_state=route == "fresh", script=None,
                native_contract=None, build_for_recovery=None, build_for_recovery_sha256=None,
                saved_authoring_checkpoint=None, saved_authoring_checkpoint_sha256=None,
                restart_backend=False, include_untracked=None, restart_idle_service=False,
                stop_after_drain=False, refresh_frontend_service=False,
                resume_recreation="c" * 32 if route == "resume" else None,
                completed_recreation_attempt="d" * 32 if route == "fresh" else None,
                completed_recreation_sha256="e" * 64 if route == "fresh" else None,
                drained_successor_proof=None, drained_successor_proof_sha256=None,
                terminal_observation_proof=None, terminal_observation_proof_sha256=None,
                terminal_observation_stop=None,
            )
            with ExitStack() as stack:
                stack.enter_context(mock.patch.object(dev, "require_host"))
                stack.enter_context(mock.patch.object(
                    docker_dev, "_select_source", return_value=(source, layout)))
                stack.enter_context(mock.patch.object(docker_dev, "_compose_identity", return_value=identity))
                stack.enter_context(mock.patch(
                    "docker_build_control.toolchain_configuration",
                    return_value={"services": {"fem-gpu-toolchain": {"build": {"args": {
                        "FULLMAG_CUDA_BASE_IMAGE": "cuda-base",
                    }}}}},
                ))
                stack.enter_context(mock.patch.object(dev, "BuildControl", return_value=control))
                stack.enter_context(mock.patch(
                    "docker_volume_prelaunch_failure_stop.validate_options", return_value=(False, None)))
                stack.enter_context(mock.patch(
                    "docker_volume_native_terminal_stop.validate_options", return_value=(False, None)))
                stack.enter_context(mock.patch(
                    "docker_volume_empty_api_abort.fresh_pin", return_value=None))
                fresh_recreation = stack.enter_context(mock.patch(
                    "docker_volume_cancelled_activation_guard.require_fresh_recreation"))
                fresh_archive = stack.enter_context(mock.patch(
                    "docker_volume_preparation_abort.require_fresh_archive", return_value=None))
                stack.enter_context(mock.patch(
                    "docker_volume_linux_supervision_stop.require_prepared_fresh_archive", return_value=None))
                stack.enter_context(mock.patch.object(dev, "_retained_prepared_fresh_contracts", return_value=[]))
                stack.enter_context(mock.patch.object(dev, "_operator_probe_record_from_retained", return_value={}))
                stack.enter_context(mock.patch.object(dev, "_retained_device_access", return_value="cpu"))
                stack.enter_context(mock.patch.object(dev, "include_untracked_from_compose", return_value=[]))
                start = stack.enter_context(mock.patch.object(dev, "start", return_value="started"))
                if route == "fresh":
                    stack.enter_context(mock.patch.object(dev, "_completed_recreation_start_context", return_value={}))
                    try:
                        result = dev._retained_operation(args, recreate_services=True)
                    except dev.BuildControlError as error:
                        result = error
                else:
                    stack.enter_context(mock.patch.object(
                        dev, "_resume_recreated_operation",
                        side_effect=lambda call_args, *_pos, **_kw: dev.start(call_args),
                    ))
                    try:
                        result = dev._retained_operation(args, recreate_services=False,
                                                        resume_recreation_id="c" * 32)
                    except dev.BuildControlError as error:
                        result = error
                return result, args, start, fresh_recreation, fresh_archive, before

    def test_retained_entry_passes_authenticated_subnet_to_fresh_and_resume_start(self):
        for route in ("fresh", "resume"):
            with self.subTest(route=route):
                document = {
                    "name": "fixture",
                    "services": {"backend": {"environment": {}}, "frontend": {}},
                    "networks": {"fullmag": {"name": "fixture-net", "driver": "bridge",
                                                "ipam": {"driver": "default", "config": [
                                                    {"subnet": "172.16.2.0/24"}]}}},
                }
                result, args, start, _fresh_recreation, _fresh_archive, before = (
                    self._run_retained_subnet_entry(document=document, route=route))
                self.assertEqual(result, "started")
                self.assertEqual(args.network_subnet, "172.16.2.0/24")
                self.assertEqual(start.call_args.args[0].network_subnet, "172.16.2.0/24")
                self.assertEqual(document, before)

    def test_retained_subnet_mismatch_fails_before_recreation_admission(self):
        cases = (
            ([{"subnet": "172.16.2.0/24"}], "172.16.3.0/24", "does not match"),
            ([{"subnet": "172.16.2.0/24"}, {"subnet": "172.17.2.0/24"}], None, "exactly one"),
            ([{"subnet": "172.16.2.1/24"}], None, "strict IPv4"),
        )
        for config, override, message in cases:
            with self.subTest(config=config, override=override):
                document = {
                    "name": "fixture",
                    "services": {"backend": {"environment": {}}, "frontend": {}},
                    "networks": {"fullmag": {"name": "fixture-net", "driver": "bridge",
                                                "ipam": {"driver": "default", "config": config}}},
                }
                result, _args, start, fresh_recreation, fresh_archive, _before = (
                    self._run_retained_subnet_entry(
                        document=document, route="fresh", subnet_override=override))
                self.assertIsInstance(result, dev.BuildControlError)
                self.assertIn(message, str(result))
                fresh_recreation.assert_not_called()
                fresh_archive.assert_not_called()
                start.assert_not_called()

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
                self.assertIn((supervision_stop.PREPARED_QUARANTINE, True),
                              harness.control.read_bytes_calls)
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
                    args.network_subnet = "172.16.2.0/24"
                    result = dev._resume_recreated_operation(
                        args, resume_fixtures._Control(), Path('/src/fullmag'),
                        {'runtime_root': '/runtime'},
                        {'project_id': 'p', 'worktree_id': 'w', 'checkout_kind': 'worktree'})
                start = handles[10]
                self.assertEqual(result, 'started')
                self.assertEqual(start.call_args.kwargs['retained_device_access'], access)
                self.assertEqual(start.call_args.kwargs['recreation_resume_proof'], records['proof'])
                self.assertEqual(start.call_args.args[0].network_subnet, "172.16.2.0/24")
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
                control.read.return_value = None
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
                control.read.assert_called_once_with(supervision_stop.PREPARED_QUARANTINE,
                                                     optional=True)
                self.assertEqual(handles[16].call_args_list, [
                    mock.call(control, cancelled.replay_index_path('state', str(reuse['state'])),
                              optional=True),
                    mock.call(control, cancelled.RECORD, optional=True),
                ])
                control.write.assert_not_called()
                self.assertEqual(args.gpu_access, 'auto')


if __name__ == '__main__':
    unittest.main()
