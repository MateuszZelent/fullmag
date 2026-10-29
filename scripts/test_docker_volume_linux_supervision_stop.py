"""Filesystem regressions for retained Linux supervision failure evidence."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_volume_linux_supervision_stop as subject


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes((json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode())


def intent(store, run_id, manual=False):
    raw = b'{"fixture":"immutable definition and study"}'
    digest = hashlib.sha256(raw).hexdigest()
    path = store / 'objects/sha256' / digest
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)
    return {'run_id': run_id, 'specification': {
        'snapshot': {'definition_sha256': digest}, 'study': {'plan_sha256': digest},
        'study_catalog_sha256': digest, 'parameters': {'fullmag.accepted_run_start': {
            'schema_version': 'accepted_run_start_policy.v1', 'mode': 'manual'}} if manual else {}}}


class StoreProofTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = Path(self.tmp.name) / 'store'
        self.ledger = Path(self.tmp.name) / 'ledger'
        for p in [self.store / 'runs', self.store / 'temp', self.store / 'recovery', self.ledger / 'proofs']:
            p.mkdir(parents=True, exist_ok=True)
        self.store_id = 'sha256:' + 'a' * 64
        self.run = self.store / 'runs' / 'run-held'
        write(self.run / 'run_intent.json', intent(self.store, 'run-held', manual=True))
        write(self.run / 'run_catalog.json', {'run_id': 'run-held', 'tasks': [{'task_id': 'task-a', 'lifecycle': 'accepted'}]})
        write(self.ledger / 'HOST_RESOURCE_LEDGER.json', {'reservations': []})

    def observe(self):
        return subject.observe_store(self.store, self.ledger, self.store_id)

    def test_held_and_terminal_runs_are_pinned_and_byte_drift_changes_proof(self):
        terminal = self.store / 'runs' / 'run-done'
        write(terminal / 'run_intent.json', intent(self.store, 'run-done'))
        write(terminal / 'run_catalog.json', {'run_id': 'run-done', 'tasks': [{'task_id': 'b', 'lifecycle': 'cancelled'}]})
        before = self.observe()
        self.assertEqual(before['held_manual_runs'], ['run-held'])
        self.assertEqual(before['terminal_runs'], ['run-done'])
        (terminal / 'retained.txt').write_text('preserve results')
        self.assertNotEqual(before, self.observe())

    def test_released_manual_run_is_not_a_held_run(self):
        write(self.run / 'start_release.json', {'released': True})
        with self.assertRaisesRegex(ValueError, 'held manual'):
            self.observe()

    def test_claimed_task_and_active_lease_are_rejected(self):
        path = self.run / 'run_catalog.json'
        catalog = json.loads(path.read_bytes())
        catalog['tasks'][0]['attempt_id'] = 'attempt-a'
        write(path, catalog)
        with self.assertRaisesRegex(ValueError, 'claim'):
            self.observe()
        catalog['tasks'][0].pop('attempt_id')
        write(path, catalog)
        write(self.run / 'resource_leases/cpu/lease-a.json', {'state': 'active'})
        with self.assertRaisesRegex(ValueError, 'active lease'):
            self.observe()

    def test_pending_transactions_and_symlinks_are_rejected(self):
        (self.store / 'temp/pending').write_text('pending')
        with self.assertRaisesRegex(ValueError, 'pending'):
            self.observe()
        (self.store / 'temp/pending').unlink()
        (self.run / 'alias').symlink_to(self.run / 'run_intent.json')
        with self.assertRaises((ValueError, OSError)):
            self.observe()

    def test_immutable_definition_and_study_cas_drift_is_rejected(self):
        blob = next((self.store / 'objects/sha256').iterdir())
        blob.write_bytes(b'changed immutable definition')
        with self.assertRaisesRegex(ValueError, 'CAS object differs'):
            self.observe()

    def test_released_reservation_requires_immutable_release_proof(self):
        proof = {'schema_version': 'host_resource_release_proof.v2', 'host_id': 'host-a',
                 'store_id': self.store_id, 'request_sha256': 'b' * 64}
        raw = (json.dumps(proof, sort_keys=True, separators=(',', ':')) + '\n').encode()
        digest = hashlib.sha256(raw).hexdigest()
        write(self.ledger / 'HOST_RESOURCE_LEDGER.json', {'policy': {'host_id': 'host-a'}, 'reservations': [{
            'identity': {'store_id': self.store_id}, 'request_sha256': 'b' * 64,
            'state': 'released', 'release_proof_sha256': digest}]})
        with self.assertRaises(FileNotFoundError):
            self.observe()
        (self.ledger / 'proofs' / (digest + '.json')).write_bytes(raw)
        self.observe()
        (self.ledger / 'proofs' / (digest + '.json')).write_text('{}')
        with self.assertRaisesRegex(ValueError, 'release proof'):
            self.observe()


class RuntimeProofTests(StoreProofTests):
    def setUp(self):
        super().setUp()
        self.state = Path(self.tmp.name) / 'state'
        self.control = Path(self.tmp.name) / 'control'
        self.proc = Path(self.tmp.name) / 'proc'
        self.proc.mkdir()
        target = self.state / 'runs/docker-all/session-store'
        target.parent.mkdir(parents=True)
        self.store.rename(target)
        self.store = target
        self.run = self.store / 'runs' / 'run-held'
        self.image = 'sha256:' + '1' * 64
        self.binary = Path(self.tmp.name) / 'native-binary'
        self.binary.write_bytes(b'old installed native binary')
        owners = self.control / 'runtime-services'
        for p in [owners / 'STARTUP-GATE.lock', owners / 'LAUNCH.lock', owners / 'OWNER.lock',
                  self.ledger / 'WRITER.lock', self.store / 'WRITER.lock']:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(b'')
        self.owner = {
            'schema_version': 'runtime_service_owner.v1', 'protocol': 'stdin-v1', 'target_id': 'docker-all',
            'owner_token': '11111111-1111-4111-8111-111111111111', 'pid': 100,
            'state': 'failed', 'heartbeat_at': '2026-10-28T00:00:01Z',
            'children': [{'role': 'compute', 'pid': 101, 'status': 'exited_failure'},
                         {'role': 'preparation', 'pid': 102, 'status': 'exited_success'}]}
        self.ready = copy.deepcopy(self.owner)
        self.ready.update(state='ready', heartbeat_at='2026-10-28T00:00:00Z')
        for child in self.ready['children']:
            child['status'] = 'running'
        write(owners / 'OWNER.json', self.owner)
        write(owners / ('docker-client-' + self.ready['owner_token'] + '.json'), self.ready)
        self.fence = self.control / 'runtime-service' / ('api-failure-' + 'a' * 32 + '.json')
        write(self.fence, {'schema': 'fullmag.api-runtime-failure-fence.v1', 'stage': 'runtime_supervision',
                           'reason': subject.ERROR, 'api_pid': 103, 'api_instance_id': 'api-one'})
        (self.proc / '103').mkdir()
        (self.proc / '103/environ').write_bytes(('FULLMAG_API_RUNTIME_FAILURE_FENCE=' + str(self.fence)).encode() + b'\0')
        self.process = {'schema': 'fullmag.docker-process-tree.v1', 'state': 'failed_outcome_retained',
                        'error': subject.ERROR, 'api_pid': 103, 'api_diagnostic_only': True,
                        'api_failure_fence': str(self.fence), 'service_owner': self.ready,
                        'accepted_store': str(self.store)}
        write(self.control / 'runtime-service/process-tree.json', self.process)
        write(self.control / 'runtime-service/docker-all.json', {'store_root': str(self.store)})
        self.cert = {'schema': 'fullmag.linux-native-host.v1', 'storage_profile': 'linux-native-v1',
                     'role': 'session', 'owner_scope': 'docker-linux', 'restart_verified': True,
                     'image_id': self.image, 'engine_id': 'engine-one', 'owner_token': 'e' * 32,
                     'host_inode': self.state.stat().st_ino, 'host_device': self.state.stat().st_dev}
        sentinel = (self.cert['owner_token'] + ':' + self.image).encode()
        self.cert['restart_expected_sha256'] = subject.sha(sentinel)
        write(self.state / 'linux-native-host.json', self.cert)
        write(self.state / '.fullmag-linux-native-owner.json', self.cert)
        for name in ['.linux-native-sentinel', '.linux-native-restart']:
            (self.state / name).write_bytes(sentinel)

    def full(self, stopped=False):
        return subject.observe(self.state, self.control, self.ledger, self.image,
                               stopped=stopped, proc_root=self.proc, binary=self.binary)

    def test_real_running_and_stopped_observation_preserves_same_store(self):
        before = self.full()
        self.process.update(state='shutdown_unknown', api_exit_code=-15,
                            shutdown_error='runtime service owner is not ready')
        write(self.control / 'runtime-service/process-tree.json', self.process)
        (self.proc / '103/environ').unlink()
        (self.proc / '103').rmdir()
        after = self.full(stopped=True)
        subject._same_retained(before, after)
        self.assertNotEqual(before['process_receipt_sha256'], after['process_receipt_sha256'])
        self.assertNotEqual(after['config_raw_sha256'], after['config_sha256'])

    def test_live_native_or_unfenced_api_refuses_stop_proof(self):
        (self.proc / '101').mkdir()
        with self.assertRaisesRegex(ValueError, 'native consumer'):
            self.full()
        (self.proc / '101').rmdir()
        (self.proc / '103/environ').write_bytes(b'other-api\0')
        with self.assertRaisesRegex(ValueError, 'reference the diagnostic fence'):
            self.full()

    def test_owner_binary_certificate_and_lock_drift_are_rejected(self):
        before = self.full()
        self.binary.write_bytes(b'different installed binary')
        with self.assertRaisesRegex(ValueError, 'retained evidence'):
            subject._same_retained(before, self.full())
        self.cert['restart_verified'] = False
        write(self.state / 'linux-native-host.json', self.cert)
        with self.assertRaisesRegex(ValueError, 'storage admission'):
            self.full()

    def test_existing_native_owner_lock_is_respected(self):
        import fcntl
        with (self.control / 'runtime-services/OWNER.lock').open('rb') as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.full()

    def test_shared_binary_hardlink_is_allowed_but_operational_alias_is_not(self):
        import os
        os.link(self.binary, self.binary.with_name('shared-binary-link'))
        self.full()
        owner_path = self.control / 'runtime-services/OWNER.json'
        os.link(owner_path, owner_path.with_name('owner-alias'))
        with self.assertRaisesRegex(ValueError, 'unbounded/nonregular evidence'):
            self.full()


class MountTests(unittest.TestCase):
    def test_stopped_probe_uses_exact_backend_image_without_mutating_control(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        image = 'sha256:' + '9' * 64
        class Control:
            image = 'sha256:' + '1' * 64
            def helper_args(self, script):
                return ['docker', 'run', '--memory', '64m', '--read-only', '--entrypoint',
                        '/bin/bash', self.image, '-c', script]
        control = Control()
        original = control.image
        with patch('docker_build_control.bounded_capture', return_value=SimpleNamespace(
                returncode=0, stdout=b'{}', stderr=b'')) as capture, \
                patch.object(subject, 'readonly_mount', side_effect=lambda actual, target: 'readonly:' + target):
            self.assertEqual(subject._probe(control, {'Id': 'backend', 'Image': image}, image, stopped=True), {})
        argv = capture.call_args.args[0]
        self.assertIn(image, argv)
        self.assertNotIn(original, argv)
        self.assertEqual(control.image, original)
        self.assertIn('64m', argv)
        self.assertIn('--read-only', argv)

    def test_shared_package_subpath_is_preserved_and_traversal_is_rejected(self):
        actual = {'Mounts': [{'Type': 'volume', 'Name': 'shared-packages', 'Destination': '/package', 'RW': True}],
                  'HostConfig': {'Mounts': [{'Type': 'volume', 'Source': 'shared-packages', 'Target': '/package',
                                            'VolumeOptions': {'Subpath': 'groups/own/current'}}]}}
        self.assertIn('volume-subpath=groups/own/current', subject.readonly_mount(actual, '/package'))
        actual['HostConfig']['Mounts'][0]['VolumeOptions']['Subpath'] = '../foreign'
        with self.assertRaisesRegex(ValueError, 'subpath'):
            subject.readonly_mount(actual, '/package')




class CancellationProofTests(RuntimeProofTests):
    def cancellation_fixture(self):
        from types import SimpleNamespace
        initial = self.full()
        store_id = initial['store']['store_id']
        run_id, task_id = 'run-cancelled', 'task-cancelled'
        run = self.store / 'runs' / run_id
        write(run / 'run_intent.json', intent(self.store, run_id))
        write(run / 'run_catalog.json', {'run_id': run_id, 'tasks': [{'task_id': task_id, 'lifecycle': 'cancelled'}]})
        identity = {'store_id': store_id, 'run_id': run_id, 'task_id': task_id, 'resource_id': 'cpu',
                    'owner': {'kind': 'solver', 'attempt_id': 'attempt-a', 'ownership_epoch': 1}, 'lease_token': 'lease-a'}
        lease = {'state': 'released', 'run_id': run_id, 'task_id': task_id,
                 'attempt_id': 'attempt-a', 'ownership_epoch': 1, 'lease_token': 'lease-a'}
        write(run / 'resource_leases/cpu/lease-a.json', lease)
        proof = {'schema_version': 'host_resource_release_proof.v2', 'host_id': 'host-a',
                 'store_id': store_id, 'request_sha256': 'd' * 64}
        proof_raw = subject.canonical(proof) + b'\n'
        digest = subject.sha(proof_raw)
        (self.ledger / 'proofs' / (digest + '.json')).write_bytes(proof_raw)
        row = {'identity': identity, 'request_sha256': 'd' * 64, 'state': 'released',
               'worker_launch_gate': {'state': 'closed'}, 'release_proof_sha256': digest}
        write(self.ledger / 'HOST_RESOURCE_LEDGER.json', {'policy': {'host_id': 'host-a'}, 'reservations': [row]})
        observation = self.full()
        request_id = '22222222-2222-4222-8222-222222222222'
        root = 'cancel-failed-no-spawn/attempts/' + 'c' * 32
        scope = {'compose_project': 'own-project', 'control_volume': 'own-volume', 'source_root': '/source',
                 'backend_container_id': 'f' * 64, 'image_id': self.image}
        request = {'schema_version': 'runtime_service_failed_no_spawn_cancellation.v1',
                   'request_id': request_id, 'identity': identity}
        result = {'schema_version': request['schema_version'], 'request_id': request_id,
                  'status': 'cancelled_no_spawn', 'run_id': run_id, 'task_id': task_id,
                  'release_proof_sha256': digest}
        request_raw = subject.canonical(request) + b'\n'
        record = dict(scope, schema='fullmag.docker-no-spawn-cancellation.v1', state='cancelled-no-spawn',
                      control_namespace='', namespace_registry_sha256=None,
                      process_receipt_sha256=observation['process_receipt_sha256'],
                      owner_sha256=observation['owner_sha256'], config_sha256=observation['config_sha256'],
                      native_binary_sha256=observation['native_binary_sha256'], request=request, result=result,
                      operation_root=root, native_result_path=root + '/native-result.json', request_sha256=subject.sha(request_raw))
        path = 'verification/no-spawn-cancellation-' + request_id + '.json'
        documents = {root + '/request.json': request_raw,
                     root + '/native-result.json': subject.canonical(result) + b'\n'}
        def publish():
            raw = subject.canonical(record) + b'\n'
            documents[path] = raw
            documents['no-spawn-cancellation/current.json'] = subject.canonical({
                'schema': 'fullmag.docker-no-spawn-cancellation-reference.v1', 'path': path, 'sha256': subject.sha(raw)})
            terminal = {'state': 'succeeded', 'phase': 'cancel-failed-no-spawn', 'attempt': 'c' * 32,
                        'compose_project': scope['compose_project'], 'control_volume': scope['control_volume'],
                        'inputs': {k: scope[k] for k in ['source_root', 'backend_container_id', 'image_id']},
                        'result': {'path': path, 'sha256': subject.sha(raw)}}
            terminal['inputs']['request_sha256'] = subject.sha(request_raw)
            documents[root + '/terminal.json'] = subject.canonical(terminal) + b'\n'
            documents[root + '/receipt.json'] = documents[root + '/terminal.json']
        publish()
        control = SimpleNamespace(project='own-project', volume='own-volume', namespace='',
                                  namespace_registry_sha256=None, read_bytes=lambda name: documents[name])
        return control, scope, observation, record, publish, documents

    def test_exact_managed_cancellation_receipt_and_native_stdout_are_required(self):
        control, scope, observation, record, publish, documents = self.cancellation_fixture()
        proof = subject.cancellation(control, scope, observation)
        self.assertTrue(proof['path'].endswith('.json'))
        documents[record['native_result_path']] = b'{}'
        with self.assertRaisesRegex(ValueError, 'stdout archive'):
            subject.cancellation(control, scope, observation)

    def test_cancelled_local_lease_and_catalog_are_independently_checked(self):
        control, scope, observation, record, publish, documents = self.cancellation_fixture()
        altered = copy.deepcopy(observation)
        altered['store']['catalogs']['run-cancelled'][0]['lifecycle'] = 'failed'
        with self.assertRaisesRegex(ValueError, 'canonical Cancelled'):
            subject.cancellation(control, scope, altered)
        altered = copy.deepcopy(observation)
        altered['store']['leases'] = []
        with self.assertRaisesRegex(ValueError, 'local lease'):
            subject.cancellation(control, scope, altered)

    def test_scope_binary_and_operation_terminal_drift_are_rejected(self):
        control, scope, observation, record, publish, documents = self.cancellation_fixture()
        record['native_binary_sha256'] = 'a' * 64
        publish()
        with self.assertRaisesRegex(ValueError, 'binary differs'):
            subject.cancellation(control, scope, observation)
        record['native_binary_sha256'] = observation['native_binary_sha256']
        publish()
        documents[record['operation_root'] + '/receipt.json'] = b'{}'
        with self.assertRaisesRegex(ValueError, 'operation is not completed'):
            subject.cancellation(control, scope, observation)


class DispatchTests(unittest.TestCase):
    def test_linux_journal_uses_its_distinct_validator(self):
        from unittest.mock import patch
        import docker_volume_dev as dev
        raw = subject.canonical({'failure_kind': subject.KIND}) + b'\n'
        witness = subject.LinuxSupervisionContext(previous_config_sha256='a' * 64)
        with patch('docker_volume_stop_unadmitted._control_bytes', return_value=raw), \
             patch.object(subject, 'retained_context', return_value=witness) as validator:
            result = dev._native_failed_stop_recovery_context(object(), {}, backend_id='b' * 64, fresh_state=False)
        self.assertIs(result, witness)
        validator.assert_called_once()
        self.assertFalse(validator.call_args.args[5])

    def test_linux_context_never_accepts_fresh_state_or_missing_old_namespace(self):
        for fresh_state, removed in [(True, None), (False, {'removed': True})]:
            with self.subTest(fresh_state=fresh_state, removed=removed):
                with self.assertRaisesRegex(ValueError, 'exact stopped retained namespace'):
                    subject.retained_context(object(), {}, {}, b'{}', 'b' * 64, fresh_state,
                                             removed_container_proof=removed)


if __name__ == '__main__':
    unittest.main()
