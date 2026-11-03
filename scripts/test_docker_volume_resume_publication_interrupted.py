"""Closed publication-observation recovery contract; no Docker or native builds."""
import copy
import json
import io
import tarfile
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_volume_development_interrupted as recovery
from docker_build_control import BuildControlError, canonical
from docker_volume_reconcile import digest
import test_docker_volume_resume_interrupted as resume_tests


class PublicationInterruptedTests(unittest.TestCase):
    def test_evidence_paths_match_runtime_control_mount_contract(self):
        self.assertEqual(recovery.PUBLICATION_CONTROL_FILES, {
            'owner': 'runtime-control/runtime-services/OWNER.json',
            'process': 'runtime-control/runtime-service/process-tree.json',
            'config': 'runtime-control/runtime-service/docker-all.json',
            'request': 'runtime-control/worker-cgroup/request.json',
            'ready': 'runtime-control/worker-cgroup/ready.json',
        })

    def test_docker_nanosecond_timestamps_preserve_stop_event_boundary(self):
        self.assertEqual(recovery._docker_timestamp_ns('2026-10-29T20:55:45.491626483Z') -
                         recovery._docker_timestamp_ns('2026-10-29T20:55:45.491519456Z'), 107027)
        self.assertEqual(recovery._docker_timestamp_ns('2026-10-29T20:55:45Z'),
                         recovery._docker_timestamp_ns('2026-10-29T20:55:45.000000000Z'))
        times = self.r['observation_failure']['service_times']
        times['backend']['FinishedAt'] = '2026-10-29T20:55:45.491519456Z'
        times['frontend']['FinishedAt'] = '2026-10-29T20:55:45.491626483Z'
        recovery.validate_publication_pins(self.r)
        times['frontend']['FinishedAt'] = '2026-10-29T20:55:45.492519457Z'
        with self.assertRaises(BuildControlError):
            recovery.validate_publication_pins(self.r)

    # Reuse the executable transaction harness, not its old-schema assumptions.
    def setUp(self):
        resume_tests.InterruptedResumeTests.setUp(self)
        self.r['schema'] = recovery.PUBLICATION_SCHEMA
        self.actual['frontend']['State']['ExitCode'] = 255
        self.r['containers']['frontend']['state_sha256'] = digest(canonical(self.actual['frontend']['State']))
        owner = {'schema_version': 'runtime_service_owner.v1', 'state': 'drained', 'target_id': 'docker-all', 'pid': 10,
                 'children': [{'role': 'compute', 'pid': 11, 'status': 'exited_success'},
                              {'role': 'preparation', 'pid': 12, 'status': 'exited_success'}]}
        self.runtime = {key: canonical(value) for key, value in {
            'owner': owner, 'process': {'schema': 'fullmag.docker-process-tree.v1', 'state': 'drained',
                                      'terminal_service_owner': owner},
            'config': {'schema_version': 'runtime_service_config.v2', 'target_id': 'docker-all',
                       'store_root': '/state/runs/docker-all/session-store'},
            'request': {'schema': 'fullmag.worker-cgroup-request.v1', 'container_id': self.actual['backend']['Id'],
                        'compose_project': 'own', 'nonce': 'a' * 32, 'process_start_token': '123',
                        'pid': 7, 'boot_id': '3d9875b8-b499-468d-a9b1-8cc5c8625255'},
            'ready': {'schema': 'fullmag.worker-cgroup-ready.v1', 'container_id': self.actual['backend']['Id'],
                      'compose_project': 'own', 'image_id': self.actual['backend']['Image'],
                      'nonce': 'b' * 32, 'process_start_token': '100', 'state': 'ready',
                      'boot_id': '3d9875b8-b499-468d-a9b1-8cc5c8625255'}}.items()}
        self.r['observation_failure'] = {
            'source_commit': 'c' * 40, 'source_digest': 'd' * 64, 'source_snapshot_sha256': 'e' * 64,
            'binary_sha256': 'f' * 64,
            'runtime_documents': {key: digest(raw) for key, raw in self.runtime.items()},
            'storage_documents': {key: 'f' * 64 for key in recovery.STORAGE_FILES},
            'service_times': {key: {field: value['State'][field] for field in ('StartedAt', 'FinishedAt')}
                              for key, value in self.actual.items()}}
        self.original.update(error=recovery.PUBLICATION_ERROR, config_sha256=None,
                             inputs={'attempt': self.r['base_attempt'], 'config_sha256': digest(canonical(self.document))})
        self.original.pop('worker_cgroup')
        self.document['services']['backend']['environment']['FULLMAG_SESSION_STORAGE_PROFILE'] = 'linux-native-v1'
        self.original['inputs']['config_sha256'] = digest(canonical(self.document))

    def transaction_fixture(self, directory):
        root, _ = resume_tests.InterruptedResumeTests.transaction_fixture(self, directory)
        for key, relative in recovery.PUBLICATION_CONTROL_FILES.items():
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(self.runtime[key])
        # Parent harness computes the request CAS values against fixture payloads.
        r = copy.deepcopy(self.r)
        r.update(active_sha256=digest((self.r['attempt']+'\n').encode()), receipt_sha256=digest(b'original'),
                 compose_sha256=digest(canonical(self.document)), current_sha256=digest(b'current'), verified_sha256=digest(b'verified'))
        r['failure'].update(inputs_sha256=digest(b'inputs'), previous_receipt_sha256=digest(b'previous'), provenance_sha256=digest(b'provenance'))
        r['attempt_documents'] = {name: digest(name.encode()) for name in r['attempt_documents']}
        import types
        script = recovery.transaction_script(types.SimpleNamespace(path=lambda path: '/control/'+path), r,
            'request.json', digest(b'request'), 'result.json', digest(b'result')).replace('/control', str(root))
        return root, script

    def test_closed_publication_contract(self):
        recovery.validate_request(self.r)
        recovery.validate_original(self.original, self.document, self.r, self.control, self.source)
        recovery.validate_publication_runtime(self.runtime, self.r)
        self.assertEqual(recovery._phase(self.r), 'resume')
        self.assertIn(self.r['base_attempt'], recovery._compose_relative(self.r))
        for service, actual in self.actual.items():
            recovery.validate_container(actual, self.r['containers'][service], service, 'own')
            recovery.validate_publication_service(actual, service, self.original, self.r)

    def test_exact_timeout_and_pre_admission_boundary(self):
        for field, value in [('error', 'other timeout'), ('worker_cgroup', {'state': 'ready'}),
                             ('worker_cgroup_helper', {'state': 'starting'}), ('backend_started_at', 'other'),
                             ('config_sha256', digest(canonical(self.document)))]:
            original = copy.deepcopy(self.original); original[field] = value
            with self.subTest(field=field), self.assertRaises(BuildControlError):
                recovery.validate_original(original, self.document, self.r, self.control, self.source)

    def test_missing_and_extra_evidence_rejected(self):
        for field in self.r['observation_failure']:
            request = copy.deepcopy(self.r); request['observation_failure'].pop(field)
            with self.subTest(field=field), self.assertRaises(BuildControlError): recovery.validate_request(request)
        request = copy.deepcopy(self.r); request['observation_failure']['extra'] = True
        with self.assertRaises(BuildControlError): recovery.validate_request(request)
        request = copy.deepcopy(self.r)
        request['observation_failure']['service_times']['frontend']['FinishedAt'] = '2026-10-23T21:00:26Z'
        with self.assertRaises(BuildControlError): recovery.validate_request(request)

    def test_non_drained_and_current_incarnation_admission_rejected(self):
        cases = [('owner', 'state', 'ready'), ('process', 'runtime_pid', 20), ('process', 'children', [{}]),
                 ('config', 'store_root', '/foreign'), ('ready', 'nonce', 'a'*32),
                 ('ready', 'process_start_token', '123'), ('request', 'container_id', 'foreign')]
        for key, field, value in cases:
            changed = copy.deepcopy(self.runtime); document = json.loads(changed[key]); document[field] = value
            changed[key] = canonical(document)
            request = copy.deepcopy(self.r); request['observation_failure']['runtime_documents'][key] = digest(changed[key])
            with self.subTest(key=key, field=field), self.assertRaises(BuildControlError):
                recovery.validate_publication_runtime(changed, request)
        changed = copy.deepcopy(self.runtime); changed['owner'] += b' '
        with self.assertRaises(BuildControlError): recovery.validate_publication_runtime(changed, self.r)

    def test_failed_result_preserves_evidence_without_claiming_runtime_recovery(self):
        result = json.loads(recovery.failure_result(canonical(self.original), self.document, self.r, 'a'*64))
        self.assertEqual(result['state'], 'failed-confirmed')
        self.assertEqual(result['phase'], 'resume')
        self.assertEqual(result['reconciliation']['observation_failure'], self.r['observation_failure'])
        for key in ('native_state_changed', 'owner_changed', 'solve_replayed', 'services_started'):
            self.assertFalse(result['reconciliation'][key])
        self.assertTrue(result['reconciliation']['native_storage_readmission_required'])
        self.assertEqual(result['build_data_qualification'], 'NOT VERIFIED')
        self.assertNotIn('exit_code', result)

    def test_stopped_copy_stream_rejects_links_duplicates_and_oversized_files(self):
        def archive_payload(*, link=False, duplicate=False):
            stream = io.BytesIO()
            with tarfile.open(fileobj=stream, mode='w') as archive:
                for index in range(2 if duplicate else 1):
                    member = tarfile.TarInfo('evidence.json')
                    if link:
                        member.type = tarfile.SYMTYPE; member.linkname = 'outside'
                    else:
                        member.size = 7
                    archive.addfile(member, None if link else io.BytesIO(b'payload'))
            return stream.getvalue()
        def argv(payload):
            return [sys.executable, '-B', '-c', 'import sys;sys.stdout.buffer.write('+repr(payload)+')']
        with patch.object(recovery, 'docker_argv', return_value=argv(archive_payload())):
            self.assertEqual(recovery.stopped_file('backend', '/evidence'), b'payload')
            self.assertEqual(recovery.stopped_file('backend', '/evidence', hash_only=True), digest(b'payload'))
        for payload, maximum in ((archive_payload(link=True), 8), (archive_payload(duplicate=True), 8),
                                 (archive_payload(), 6)):
            with self.subTest(maximum=maximum), patch.object(recovery, 'docker_argv', return_value=argv(payload)):
                with self.assertRaises(BuildControlError): recovery.stopped_file('backend', '/evidence', maximum=maximum)


    def test_pinned_runtime_evidence_change_blocks_transaction(self):
        for relative in recovery.PUBLICATION_CONTROL_FILES.values():
            with self.subTest(relative=relative), tempfile.TemporaryDirectory() as directory:
                root, script = self.transaction_fixture(directory)
                (root/relative).write_bytes(b'foreign')
                result = self.run_transaction(script, b'APPLY\n')
                self.assertNotEqual(result.returncode, 0)
                self.assertTrue((root/'active').exists())
                self.assertEqual((root/'resume/verified.json').read_bytes(), b'verified')


class SharedPackageConsumerTests(unittest.TestCase):
    def setUp(self):
        import test_docker_backend_volume_cache as fixtures
        import docker_backend_volume_cache as cache
        self.cache, self.fixtures = cache, fixtures
        for label in ('own', 'foreign'):
            temporary = tempfile.TemporaryDirectory()
            self.addCleanup(temporary.cleanup)
            profile, *_ = fixtures._profile(temporary.name, shared_packages=True, worktree_id='worktree-'+label)
            profile['volume_documents'] = fixtures.DockerVolumeFixture(profile, roles=cache.VOLUME_ROLES).documents
            profile['state'] = 'ready'
            setattr(self, label, profile)
        self.actual = fixtures._container(self.foreign)
        self.actual['State'] = {'Running': True}
        self.actual['Config']['Labels'].update({'com.docker.compose.service': 'backend',
            'com.docker.compose.project': self.foreign['control_project']})
        self.retained = set(self.own['volume_names'].values()) | {'own-frontend'}

    def check(self, actual):
        recovery._publication_shared_consumer(actual, self.own, self.retained, '/own/state', state_alias='/wsl/own/state')

    def test_registered_different_package_unit_is_allowed(self):
        self.check(self.actual)

    def test_own_unit_unknown_labels_root_subpath_and_non_backend_are_rejected(self):
        cases = []
        own = self.fixtures._container(self.own); own['State'] = {'Running': True}
        own['Config']['Labels'].update({'com.docker.compose.service': 'backend', 'com.docker.compose.project': 'foreign'})
        cases.append(own)
        unknown = copy.deepcopy(self.actual); unknown['Config']['Labels'].pop(self.cache.LABEL_UNIT); cases.append(unknown)
        malformed = copy.deepcopy(self.actual)
        for mount in malformed['Mounts']:
            if mount['Destination'] == self.cache.PACKAGE_TARGET:
                mount['Source'] = '/unknown/package/root'; mount['Subpath'] = 'groups/wrong'
        cases.append(malformed)
        unknown_root = copy.deepcopy(self.actual)
        for mount in unknown_root['Mounts']:
            if mount['Destination'] == self.cache.SHARED_BACKEND_TARGET: mount['Source'] = '/unknown/root'
        cases.append(unknown_root)
        maintenance = copy.deepcopy(self.actual); maintenance['Config']['Labels']['com.docker.compose.service'] = 'maintenance'
        cases.append(maintenance)
        for actual in cases:
            with self.subTest(actual=actual['Config']['Labels']), self.assertRaises(BuildControlError): self.check(actual)

    def test_extra_private_mounts_and_aliases_are_rejected(self):
        mounts = [
            {'Type': 'volume', 'Name': self.own['volume_names']['control'], 'Destination': '/foreign-control', 'RW': True},
            {'Type': 'volume', 'Name': self.own['volume_names']['build'], 'Destination': '/foreign-build', 'RW': True},
            {'Type': 'volume', 'Name': 'own-frontend', 'Destination': '/foreign-frontend', 'RW': True},
            {'Type': 'bind', 'Source': '/own/state', 'Destination': '/foreign-state', 'RW': True},
            {'Type': 'bind', 'Source': '/wsl/own/state', 'Destination': '/foreign-state', 'RW': True},
            {'Type': 'bind', 'Source': self.own['volume_documents']['build']['Mountpoint'],
             'Destination': '/foreign-build-alias', 'RW': True}]
        for mount in mounts:
            actual = copy.deepcopy(self.actual); actual['Mounts'].append(mount)
            with self.subTest(mount=mount), self.assertRaises(BuildControlError): self.check(actual)

    def test_profile_fresh_volume_identity_and_own_backend_are_attested(self):
        import types
        backend = self.fixtures._container(self.own)
        control = types.SimpleNamespace(project=self.own['control_project'])
        original = {'backend_volumes': self.own['volume_names']}
        raw = canonical(self.own)
        request = {'base_attempt': 'a'*32, 'attempt_documents': {'backend-cache.json': digest(raw)}}
        def inspect(*args):
            self.assertEqual(args[:2], ('volume', 'inspect'))
            documents = [value for value in self.own['volume_documents'].values() if value['Name'] == args[2]]
            return types.SimpleNamespace(stdout=canonical(documents))
        with patch.object(recovery, 'read_raw', return_value=raw), patch.object(recovery, 'docker_capture', side_effect=inspect):
            self.assertEqual(recovery._publication_cache_profile(control, request, original, backend), self.own)
            changed = copy.deepcopy(backend); changed['Config']['User'] = '0'
            with self.assertRaises(BuildControlError): recovery._publication_cache_profile(control, request, original, changed)
        def changed_inspect(*args):
            document = json.loads(inspect(*args).stdout)
            document[0]['CreatedAt'] = 'replacement-volume'
            return types.SimpleNamespace(stdout=canonical(document))
        with patch.object(recovery, 'read_raw', return_value=raw), patch.object(recovery, 'docker_capture', side_effect=changed_inspect):
            with self.assertRaises(BuildControlError): recovery._publication_cache_profile(control, request, original, backend)


for name in (
    'run_transaction', 'test_transaction_preview_retains_active_and_all_receipts',
    'test_transaction_publishes_only_resume_failure_and_preserves_verified',
    'test_transaction_partial_publication_is_replayable',
    'test_transaction_changed_inputs_and_busy_lock_fail_closed'):
    setattr(PublicationInterruptedTests, name, getattr(resume_tests.InterruptedResumeTests, name))

if __name__ == '__main__':
    unittest.main()
