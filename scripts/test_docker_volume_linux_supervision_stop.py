"""Filesystem regressions for retained Linux supervision failure evidence."""
import ast
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_volume_linux_supervision_stop as subject
from docker_build_control import BuildControl as RealBuildControl, BuildControlError


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

    def test_terminal_observation_pins_leases_without_reading_large_result_payloads(self):
        with self.assertRaisesRegex(ValueError, 'nonterminal run'):
            subject.observe_store(self.store, self.ledger, self.store_id, terminal_only=True)
        write(self.run / 'run_catalog.json', {'run_id': 'run-held', 'tasks': [
            {'task_id': 'task-a', 'lifecycle': 'interrupted'}]})
        artifact = self.run / 'worker-attempts/partial-results'
        artifact.parent.mkdir()
        with artifact.open('wb') as stream:
            stream.truncate(subject.MAX_BYTES + 1)
        proof = subject.observe_store(self.store, self.ledger, self.store_id, terminal_only=True)
        self.assertEqual(proof['terminal_runs'], ['run-held'])
        write(self.run / 'resource_leases/cpu/lease-a.json', {'state': 'active'})
        with self.assertRaisesRegex(ValueError, 'active lease'):
            subject.observe_store(self.store, self.ledger, self.store_id, terminal_only=True)

    def test_explicit_terminal_mode_is_carried_into_both_guest_probes(self):
        for stopped in (False,True):
            script=subject._script('sha256:'+'a'*64,stopped,terminal_only=True)
            compile(script,'<actual terminal-only observer>','exec')
            self.assertIn('terminal_only=True',script.splitlines()[-1])
        self.assertIn('terminal_only=False',subject._script('sha256:'+'a'*64,False).splitlines()[-1])

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
        # PreparedStoreProofTests also adds a separate bundle object. Directory
        # enumeration order must not choose that unreferenced object instead.
        accepted = json.loads((self.run / 'run_intent.json').read_bytes())
        digest = accepted['specification']['snapshot']['definition_sha256']
        blob = self.store / 'objects/sha256' / digest
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


class PreparedStoreProofTests(StoreProofTests):
    def setUp(self):
        super().setUp()
        self.target = dict(run_id='run-held', task_id='task-a', request_id='request-a',
                           source_sha256='b' * 64, api_instance_id='api-a',
                           session_id='session-a', session_epoch=2)
        value = intent(self.store, 'run-held', manual=True)
        value['specification']['parameters']['live_workspace'] = {
            'api_instance_id': 'api-a', 'session_id': 'session-a', 'session_epoch': 2,
            'command_id': 'request-a', 'request_idempotency_key': 'request-a',
            'startup_source_sha256': 'b' * 64,
            'command': {'kind': 'startup_script', 'request_id': 'request-a', 'source_sha256': 'b' * 64}}
        write(self.run / 'run_intent.json', value)
        common = dict(run_id='run-held', task_id='task-a', resource_id='cpu-prep',
                      preparation_attempt_id='prep-a', lease_token='lease-a')
        lease = dict(common, schema_version='preparation_resource_lease.v1', state='released',
                     heartbeat_sequence=37)
        exit_receipt = dict(common, schema_version='preparation_process_exit_receipt.v1',
                            receipt_id='prep-exit-launch-a', process_id=233, process_start_token='linux-starttime-5',
                            lease_heartbeat_sequence=37, status_success=True, exit_code=0, timed_out=False)
        launch = dict(common, schema_version='preparation_process_launch.v1', launch_id='launch-a',
                      lease_heartbeat_sequence=0, supervisor_process_id=102, supervisor_start_token='linux-starttime-2')
        write(self.run / 'preparation_resource_leases/cpu-prep/lease-a.json', lease)
        write(self.run / 'preparation_process_exit_receipts/prep-exit-launch-a.json', exit_receipt)
        write(self.run / 'preparation_process_launches/launch-a.json', launch)
        receipt = dict(run_id='run-held', task_id='task-a', step_id='step-a', preparation_id='prepared-a',
                       plan_fingerprint='sha256:' + 'd' * 64, input_fingerprint='e' * 64,
                       schema_version='task_preparation_receipt.v1',
                       payload={'plan': {'requested_backend': 'fem', 'resolved_backend': 'fem'}})
        write(self.run / 'task_preparation_receipts/task-a.json', receipt)
        bundle = b'prepared bundle outside the run tree'
        bundle_sha = subject.sha(bundle)
        (self.store / 'objects/sha256' / bundle_sha).write_bytes(bundle)
        write(self.run / 'task_prepared_observations/task-a.json', dict(
            schema_version='task_prepared_observation.v1', run_id='run-held', task_id='task-a',
            step_id='step-a', preparation_id='prepared-a', plan_fingerprint=receipt['plan_fingerprint'],
            requested_lane='fem_cpu', evaluation_lane='fem_cpu',
            outcome={'state': 'published', 'object_refs': [], 'bundle_object_ref': bundle_sha}))
        launch_owner = dict(schema_version='host_preparation_launch_owner.v1', launch_id='launch-a',
                            launch_sha256=subject.sha(subject.canonical(launch)),
                            supervisor_process_id=102, supervisor_start_token='linux-starttime-2')
        proof = dict(schema_version='host_resource_release_proof.v1', kind='preparation', host_id='host-a',
                     store_id=self.store_id, request_sha256='f' * 64, preparation_receipt=exit_receipt,
                     released_preparation_lease=lease, preparation_launch_owner=launch_owner)
        raw = subject.canonical(proof)
        digest = subject.sha(raw)
        (self.ledger / 'proofs' / (digest + '.json')).write_bytes(raw)
        self.row = dict(state='released', request_sha256='f' * 64, release_proof_sha256=digest,
                        preparation_launch_gate={'state': 'consumed', 'token': 'token-a'},
                        preparation_launch_owner=launch_owner, identity=dict(
                            store_id=self.store_id, **{k: common[k] for k in ('run_id', 'task_id', 'resource_id', 'lease_token')},
                            owner={'kind': 'preparation', 'preparation_attempt_id': 'prep-a'}))
        self.publish_ledger()

    def publish_ledger(self):
        write(self.ledger / 'HOST_RESOURCE_LEDGER.json', {'policy': {'host_id': 'host-a'}, 'reservations': [self.row]})

    def prepared(self):
        return subject.observe_store(self.store, self.ledger, self.store_id, prepared_target=self.target)

    def test_exact_startup_script_policy_is_pinned_without_relabelling_it(self):
        proof = self.prepared()
        self.assertEqual(proof['prepared_unclaimed']['target'], self.target)
        self.assertEqual(proof['prepared_unclaimed']['start_policy']['mode'], 'manual')
        self.assertEqual(proof['prepared_unclaimed']['command_kind'], 'startup_script')
        self.assertEqual(proof['held_manual_runs'], [])

    def test_prepared_proof_rejects_any_solver_start_or_unknown_run_entry(self):
        for path in ['start_release.json', 'resource_leases/cpu/solver.json',
                     'worker-attempts/attempt-a.json', 'unknown-actor.json']:
            with self.subTest(path=path):
                entry = self.run / path
                write(entry, {})
                with self.assertRaises(ValueError):
                    self.prepared()
                entry.unlink()

    def test_host_reservation_must_be_released_and_exactly_match_exit_and_lease(self):
        for state in ['committed', 'consumed', 'unknown', 'reserved']:
            self.row['state'] = state
            self.publish_ledger()
            with self.subTest(state=state), self.assertRaises(ValueError):
                self.prepared()
        self.row['state'] = 'released'
        self.publish_ledger()
        lease_path = self.run / 'preparation_resource_leases/cpu-prep/lease-a.json'
        lease = json.loads(lease_path.read_bytes())
        lease['heartbeat_sequence'] = 38
        write(lease_path, lease)
        with self.assertRaises(ValueError):
            self.prepared()

    def test_identity_claim_or_failed_preparation_is_rejected(self):
        for key in ['request_id', 'api_instance_id', 'source_sha256', 'session_id', 'session_epoch']:
            original = self.target[key]
            self.target[key] = 'other'
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.prepared()
            self.target[key] = original
        catalog = json.loads((self.run / 'run_catalog.json').read_bytes())
        catalog['tasks'][0]['attempt_id'] = 'claim-a'
        write(self.run / 'run_catalog.json', catalog)
        with self.assertRaises(ValueError):
            self.prepared()


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


class PreparedRuntimeBoundaryTests(unittest.TestCase):
    def setUp(self):
        import shutil
        runtime = RuntimeProofTests('test_real_running_and_stopped_observation_preserves_same_store')
        runtime.setUp()
        self.addCleanup(runtime.doCleanups)
        prepared = PreparedStoreProofTests('test_exact_startup_script_policy_is_pinned_without_relabelling_it')
        prepared.setUp()
        self.addCleanup(prepared.doCleanups)
        store_id = runtime.full()['store']['store_id']
        shutil.copytree(prepared.store, runtime.store, dirs_exist_ok=True)
        target = dict(prepared.target, api_instance_id='api-one')
        path = runtime.run / 'run_intent.json'
        value = json.loads(path.read_bytes())
        value['specification']['parameters']['live_workspace']['api_instance_id'] = target['api_instance_id']
        write(path, value)
        row = copy.deepcopy(prepared.row)
        proof = json.loads((prepared.ledger / 'proofs' / (row['release_proof_sha256'] + '.json')).read_bytes())
        proof['store_id'] = row['identity']['store_id'] = store_id
        raw = subject.canonical(proof)
        row['release_proof_sha256'] = subject.sha(raw)
        (runtime.ledger / 'proofs' / (subject.sha(raw) + '.json')).write_bytes(raw)
        write(runtime.ledger / 'HOST_RESOURCE_LEDGER.json', {'policy': {'host_id': 'host-a'}, 'reservations': [row]})
        self.runtime, self.target, self.row = runtime, target, row

    def observe(self, stopped=False):
        r = self.runtime
        return subject.observe(r.state, r.control, r.ledger, r.image,
                               stopped=stopped, proc_root=r.proc, binary=r.binary, prepared_target=self.target)

    def test_real_startup_prepared_no_start_boundary_is_distinct_and_stays_truthfully_unknown(self):
        r = self.runtime
        before = self.observe()
        self.assertEqual(before['schema'], subject.PREPARED_SCHEMA)
        self.assertEqual(before['store']['held_manual_runs'], [])
        r.process.update(state='shutdown_unknown', api_exit_code=-15, shutdown_error='runtime service owner is not ready')
        write(r.control / 'runtime-service/process-tree.json', r.process)
        (r.proc / '103/environ').unlink()
        (r.proc / '103').rmdir()
        after = self.observe(stopped=True)
        subject._same_retained(before, after)
        self.assertEqual(json.loads((r.control / 'runtime-services/OWNER.json').read_bytes())['state'], 'failed')
        self.assertEqual(json.loads((r.run / 'run_catalog.json').read_bytes())['tasks'][0]['lifecycle'], 'accepted')

    def test_live_preparation_and_wrong_api_incarnation_fail_closed(self):
        (self.runtime.proc / '233').mkdir()
        with self.assertRaisesRegex(ValueError, 'preparation process'):
            self.observe()
        (self.runtime.proc / '233').rmdir()
        self.target['api_instance_id'] = 'different-api'
        with self.assertRaisesRegex(ValueError, 'API fence'):
            self.observe()

    def test_any_active_or_foreign_host_reservation_prevents_prepared_stop(self):
        for change in ({'state': 'committed'}, {'state': 'consumed'}, {'state': 'unknown'},
                       {'identity': dict(self.row['identity'], store_id='foreign-store')}):
            row = dict(self.row, **change)
            write(self.runtime.ledger / 'HOST_RESOURCE_LEDGER.json', {
                'policy': {'host_id': 'host-a'}, 'reservations': [self.row, row]})
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.observe()


class PreparedProtocolTests(unittest.TestCase):
    def plan(self):
        from unittest.mock import patch
        scope = {'backend_container_id': 'b' * 64, 'frontend_container_id': 'f' * 64}
        with patch.object(subject, '_prepared_sources', return_value={'source': 'a' * 64}):
            return subject._prepared_plan(scope, {'schema': subject.PREPARED_SCHEMA}, b'original', 'h' * 64, {})

    def journal(self):
        initial = {'schema': subject.PREPARED_JOURNAL_SCHEMA, 'failure_kind': subject.PREPARED_KIND,
                   'state': 'prepared', 'plan': self.plan()}
        return dict(initial, intent_sha256=subject.sha(subject.canonical(initial)))

    def test_failed_final_barrier_publishes_no_signal_intent_and_sends_no_signal(self):
        from unittest.mock import patch
        def barrier():
            raise ValueError('changed API/session/StartedAt pin')
        with patch('docker_volume_cancelled_activation._publish_cas') as publish, \
             patch('docker_build_control.docker_capture') as signal:
            with self.assertRaisesRegex(ValueError, 'changed API'):
                subject._prepared_signal_once(object(), 'journal', self.journal(), b'prepared', barrier)
            publish.assert_not_called()
            signal.assert_not_called()

    def test_lost_signal_ack_preserves_durable_intent_and_resume_never_resignals(self):
        from unittest.mock import patch
        from docker_build_control import ControlOutcomeUnknown
        saved = []
        def publish(control, path, value, *, expected_raw):
            self.assertEqual(expected_raw, b'prepared')
            saved.append(copy.deepcopy(value))
            return subject.canonical(value)
        def lost(*args, **kwargs):
            self.assertEqual(saved[0]['state'], 'signal-intent')
            raise ControlOutcomeUnknown('ACK lost')
        with patch('docker_volume_cancelled_activation._publish_cas', side_effect=publish), \
             patch('docker_build_control.docker_capture', side_effect=lost) as signal:
            with self.assertRaises(ControlOutcomeUnknown):
                subject._prepared_signal_once(object(), 'journal', self.journal(), b'prepared', lambda: None)
            self.assertEqual(signal.call_count, 1)
            with self.assertRaisesRegex(ValueError, 'resume only observes'):
                subject._prepared_signal_once(object(), 'journal', saved[0], b'issued', lambda: None)
            self.assertEqual(signal.call_count, 1)

    def test_plan_and_durable_intent_have_independent_cas_checks(self):
        journal = self.journal()
        subject._validate_prepared_journal(journal)
        journal['plan']['scope']['backend_container_id'] = 'other'
        with self.assertRaisesRegex(ValueError, 'plan CAS'):
            subject._validate_prepared_journal(journal)
        journal = self.journal()
        journal['intent_sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'intent CAS'):
            subject._validate_prepared_journal(journal)

    def test_old_proof_schema_cannot_be_a_prepared_plan(self):
        with self.assertRaisesRegex(ValueError, 'legacy observation'):
            subject._prepared_plan({}, {'schema': subject.SCHEMA}, b'original', 'h', {})

    def test_uncancelled_quarantine_never_grants_start_or_fresh_archive(self):
        from types import SimpleNamespace
        record = {'schema': subject.PREPARED_QUARANTINE_SCHEMA, 'state': 'cancellation-required'}
        control = SimpleNamespace(read=lambda *args, **kwargs: record,
                                  read_bytes=lambda *args, **kwargs: subject.canonical(record))
        with self.assertRaisesRegex(ValueError, 'genuine cancellation'):
            subject.assert_prepared_start_allowed(control)
        args = SimpleNamespace(prepared_quarantine_sha256=subject.sha(subject.canonical(record)), fresh_state=False)
        with self.assertRaisesRegex(ValueError, 'explicit fresh archive'):
            subject.require_prepared_fresh_archive(control, args, {}, {}, recreate_services=True)

    def test_frozen_4c28_helper_releases_own_lease_on_new_technical_terminal(self):
        import subprocess
        import fcntl
        from types import SimpleNamespace
        from docker_build_control import BuildControl
        token = '1' * 32
        # Frozen output of BuildControl.operation_script('activation', '1'*32)
        # from 4c28ca4766be28c6b300fa6051c8764152940500, including its exact
        # MAX_ATTEMPTS=64 / MAX_LOG_BYTES=33554432. Independent of Git history
        # so this executable compatibility witness also runs in shallow CI.
        script = (
            "umask 027; exec 9>/control/operation.lock; flock -n 9; "
            "test ! -e /control/cache-retirement/closing.json; test ! -L /control/cache-retirement/closing.json; "
            "test ! -e /control/active; mkdir -p /control/activation/attempts; "
            "test \"$(readlink -f /control/activation/attempts)\" = '/control/activation/attempts'; "
            "test $(find /control/activation/attempts -mindepth 1 -maxdepth 1 -type d | wc -l) -lt 64; "
            "mkdir '/control/activation/attempts/11111111111111111111111111111111'; "
            "printf '%s\\n' '11111111111111111111111111111111' > /control/active; sync /control; printf 'READY\\n'; "
            "{ head -c 33554432; cat > /dev/null; } > '/control/activation/attempts/11111111111111111111111111111111/build.log'; "
            "sync '/control/activation/attempts/11111111111111111111111111111111/build.log'; printf 'LOGGED\\n'; "
            "until test -f '/control/activation/attempts/11111111111111111111111111111111/terminal.json'; "
            "do sleep 1; done; rm /control/active; sync /control")
        self.assertEqual(subject.sha(script.encode()), '40c8bc0874eeed2e137a7ff05737e47fbc089f4014e61ae98b19f662acdda97c')
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script = script.replace('/control', tmp)
            process = subprocess.Popen(['/bin/bash', '-euo', 'pipefail', '-c', script], stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                self.assertEqual(process.stdout.readline(), b'READY\n')
                process.stdin.close()
                self.assertEqual(process.stdout.readline(), b'LOGGED\n')
                with (root / 'operation.lock').open('rb') as lock:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.assertEqual((root / 'active').read_text().strip(), token)
                write(root / 'activation/attempts' / token / 'terminal.json', {
                    'schema': 'fullmag.docker-build-operation.v1', 'state': 'failed-confirmed',
                    'activation_state': 'failed-unclaimed-prepared-quarantined',
                    'restart_policy': 'cancellation-required', 'healthy_drain': False})
                self.assertEqual(process.wait(timeout=5), 0)
                self.assertFalse((root / 'active').exists())
                with (root / 'operation.lock').open('rb') as lock:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=5)
                process.stdout.close()
                process.stderr.close()


class PreparedOrchestrationTests(PreparedRuntimeBoundaryTests):
    def setUp(self):
        super().setUp()
        from types import SimpleNamespace
        from contextlib import contextmanager
        from unittest.mock import patch
        from docker_volume_reconcile import fingerprint
        import docker_volume_activation_reconcile as reconcile
        r = self.runtime
        self.backend, self.frontend, self.helper = 'b' * 64, 'f' * 64, 'e' * 64
        self.activation, self.development = 'a' * 32, 'd' * 32
        self.root = Path(__file__).resolve().parents[1]
        target = Path(r.tmp.name) / 'target.json'
        write(target, self.target)
        document = {'name': 'own-project', 'services': {name: {'image': r.image, 'environment': {}, 'command': []}
                    for name in ('backend', 'frontend')}}
        config_sha = subject.sha(subject.canonical(document))
        self.previous = dict(state='succeeded', attempt=self.development, compose_project='own-project',
                             backend_container=self.backend, frontend_container=self.frontend,
                             state_root=str(r.state), config_sha256=config_sha,
                             inputs={'source_root': str(self.root), 'image_id': r.image})
        receipt = dict(schema='fullmag.docker-build-operation.v1', phase='activation',
                       state='outcome-unknown-resources-retained', attempt=self.activation,
                       compose_project='own-project', control_volume='own-volume',
                       helper_container='fullmag-control-' + self.activation, helper_sha256='1' * 64,
                       started_at=1, finished_at=2, error='finalized outcome unknown', inputs={
                           'source_root': str(self.root), 'image_id': r.image, 'backend_container': self.backend,
                           'development_attempt': self.development, 'config_sha256': config_sha,
                           'source_relative': 'examples/owned.py', 'source_sha256': self.target['source_sha256'],
                           'request_id': self.target['request_id'], 'provenance_sha256': '2' * 64,
                           'activation_receipt_key': '3' * 64,
                           'activation_receipt_path': reconcile._activation_marker_path('3' * 64)})
        self.docs = {}
        def put(path, value):
            self.docs[path] = subject.canonical(value) + b'\n'
        for path in ['development/current.json', 'development/verified.json',
                     'development/attempts/' + self.development + '/terminal.json']:
            put(path, self.previous)
        put('development/attempts/' + self.development + '/compose.json', document)
        put('activation/attempts/' + self.activation + '/receipt.json', receipt)
        self.docs['active'] = self.activation.encode() + b'\n'
        def read_bytes(path, optional=False, **kwargs):
            if path.startswith('runtime-control/'):
                return subject.read(r.control / path.removeprefix('runtime-control/'))
            if optional:
                return self.docs.get(path)
            return self.docs[path]
        def read(path, optional=False):
            raw = read_bytes(path, optional=optional)
            return subject.decode(raw) if raw else None
        self.control = SimpleNamespace(project='own-project', volume='own-volume', namespace='',
                                       namespace_registry_sha256=None, read=read, read_bytes=read_bytes)
        self.rows = {name: {'Id': identifier, 'Image': r.image, 'Mounts': [], 'Config': {}, 'HostConfig': {},
                           'State': dict(Running=True, Pid=1000, OOMKilled=False, ExitCode=0, StartedAt='same-incarnation')}
                     for name, identifier in [('backend', self.backend), ('frontend', self.frontend)]}
        self.signals = []
        self.lost_ack = False
        def docker(*args, **kwargs):
            if args[0] == 'logs':
                return SimpleNamespace(returncode=0, stdout=b'READY\nLOGGED\n', stderr=b'')
            if args[0] == 'inspect':
                row = next(v for v in self.rows.values() if v['Id'] == args[1])
                return SimpleNamespace(returncode=0, stdout=subject.canonical([row]))
            if args[:2] == ('image', 'inspect'):
                return SimpleNamespace(returncode=0, stdout=subject.canonical([{'Config': {}}]))
            if args[:2] == ('kill', '--signal=TERM'):
                identifier = args[2]
                self.signals.append(identifier)
                row = next(v for v in self.rows.values() if v['Id'] == identifier)
                row['State'].update(Running=False, Pid=0)
                if identifier == self.backend:
                    r.process.update(state='shutdown_unknown', api_exit_code=-15, shutdown_error='runtime service owner is not ready')
                    write(r.control / 'runtime-service/process-tree.json', r.process)
                    (r.proc / '103/environ').unlink()
                    (r.proc / '103').rmdir()
                if identifier == self.frontend and self.lost_ack:
                    from docker_build_control import ControlOutcomeUnknown
                    raise ControlOutcomeUnknown('lost signal acknowledgement')
                return SimpleNamespace(returncode=0)
            raise AssertionError(args)
        self.publications = []
        self.fail_before_terminal = False
        def publish(control, path, document, *, expected_raw):
            if path == 'activation/attempts/' + self.activation + '/terminal.json' and self.fail_before_terminal:
                self.fail_before_terminal = False
                from docker_build_control import ControlOutcomeUnknown
                raise ControlOutcomeUnknown('crash after current before terminal')
            new = subject.canonical(document) + b'\n'
            current = self.docs.get(path)
            self.assertTrue(current == expected_raw or current == new, path)
            self.docs[path] = new
            self.publications.append(path)
            if path == 'activation/attempts/' + self.activation + '/terminal.json':
                self.docs.pop('active')  # Original shell behavior is tested separately with frozen 4c28 code.
            return new
        @contextmanager
        def observer(control, attempt, raw):
            self.assertEqual(attempt, self.activation)
            self.assertEqual(control.read_bytes('active').strip(), attempt.encode())
            yield control, self.helper, lambda: None
        patches = [patch('docker_build_control.BuildControl', return_value=self.control),
                   patch('docker_build_control.toolchain_configuration', return_value={
                       'services': {'fem-gpu-toolchain': {'build': {'args': {'FULLMAG_CUDA_BASE_IMAGE': r.image}}}}}),
                   patch('docker_build_control.docker_capture', side_effect=docker),
                   patch('docker_volume_activation_reconcile.docker_capture', side_effect=docker),
                   patch('docker_volume_dev._validate_retained_service'), patch('docker_volume_dev._assert_private_restart_network'),
                   patch('docker_volume_dev._retained_certificate'),
                   patch('docker_volume_activation_reconcile._validate_helper', return_value=({}, self.helper)),
                   patch('docker_volume_activation_reconcile.retained_activation_observer', side_effect=observer),
                   patch('docker_volume_cancelled_activation._publish_cas', side_effect=publish),
                   patch('docker_volume_activate._wait_retirement_lease_release', side_effect=lambda *a, **k: 'active' not in self.docs),
                   patch('docker_volume_unclaimed_cancellation._project_container_ids', return_value={self.backend, self.frontend, self.helper}),
                   patch('docker_volume_unclaimed_cancellation._volume_consumer_ids', return_value={self.backend, self.frontend, self.helper}),
                   patch.object(subject, '_probe', side_effect=lambda *a, stopped=False, **k: self.observe(stopped))]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)
        self.args = SimpleNamespace(activation_attempt=self.activation, prepared_target=target,
                                    prepared_target_sha256=subject.sha(target.read_bytes()),
                                    container_id=self.backend, image_id=r.image,
                                    process_receipt_sha256=self.observe()['process_receipt_sha256'],
                                    apply=False, expected_plan_sha256=None, continue_intent_sha256=None)

    def run_stop(self):
        return subject.stop_prepared(self.args, self.root, {}, copy.deepcopy(self.rows['backend']))

    def test_preview_apply_has_no_new_operation_and_publishes_truthful_terminal_last(self):
        plan = self.run_stop()
        self.assertEqual(self.signals, [])
        self.assertEqual(self.publications, [])
        self.args.apply = True
        self.args.expected_plan_sha256 = plan['plan_sha256']
        result = self.run_stop()
        self.assertEqual(self.signals, [self.backend, self.frontend])
        self.assertFalse(result['healthy_drain'])
        self.assertFalse(result['native_task_cancelled'])
        self.assertEqual(self.publications[-1], 'activation/attempts/' + self.activation + '/terminal.json')
        self.assertEqual(subject.decode(self.docs[subject.PREPARED_QUARANTINE])['state'], 'cancellation-required')
        self.assertEqual(self.control.read('activation/attempts/' + self.activation + '/receipt.json')['state'],
                         'outcome-unknown-resources-retained')

    def test_lost_ack_continues_from_same_intent_without_another_signal(self):
        from docker_build_control import ControlOutcomeUnknown
        plan = self.run_stop()
        self.args.apply = self.lost_ack = True
        self.args.expected_plan_sha256 = plan['plan_sha256']
        with self.assertRaises(ControlOutcomeUnknown):
            self.run_stop()
        journal = self.control.read('verification/stop-failed-' + self.backend + '.json')
        self.assertEqual(journal['state'], 'signal-intent')
        self.args.continue_intent_sha256 = journal['intent_sha256']
        result = self.run_stop()
        self.assertTrue(result['activation_lease_released'])
        self.assertEqual(self.signals, [self.backend, self.frontend])

    def test_changed_backend_started_at_rejects_reviewed_plan_without_signal(self):
        plan = self.run_stop()
        self.args.apply = True
        self.args.expected_plan_sha256 = plan['plan_sha256']
        self.rows['backend']['State']['StartedAt'] = 'foreign-incarnation'
        with self.assertRaisesRegex(ValueError, 'reviewed prepared stop plan changed'):
            self.run_stop()
        self.assertEqual(self.signals, [])

    def test_prepared_bundle_drift_between_preview_and_apply_sends_no_signal(self):
        plan = self.run_stop()
        self.args.apply = True
        self.args.expected_plan_sha256 = plan['plan_sha256']
        published = json.loads((self.runtime.run / 'task_prepared_observations/task-a.json').read_bytes())
        bundle = published['outcome']['bundle_object_ref']
        (self.runtime.store / 'objects/sha256' / bundle).write_bytes(b'corrupted after preview')
        with self.assertRaisesRegex(ValueError, 'prepared CAS object differs'):
            self.run_stop()
        self.assertEqual(self.signals, [])

    def test_crash_after_current_before_terminal_resumes_exact_generation_without_signal(self):
        from docker_build_control import ControlOutcomeUnknown
        plan = self.run_stop()
        self.args.apply = self.fail_before_terminal = True
        self.args.expected_plan_sha256 = plan['plan_sha256']
        with self.assertRaisesRegex(ControlOutcomeUnknown, 'after current'):
            self.run_stop()
        self.assertEqual(self.control.read('activation/current.json')['activation_state'],
                         'failed-unclaimed-prepared-quarantined')
        journal = self.control.read('verification/stop-failed-' + self.backend + '.json')
        self.args.continue_intent_sha256 = journal['intent_sha256']
        result = self.run_stop()
        self.assertTrue(result['activation_lease_released'])
        self.assertEqual(self.signals, [self.backend, self.frontend])

    def test_foreign_current_after_partial_publication_is_never_accepted(self):
        from docker_build_control import ControlOutcomeUnknown
        plan = self.run_stop()
        self.args.apply = self.fail_before_terminal = True
        self.args.expected_plan_sha256 = plan['plan_sha256']
        with self.assertRaises(ControlOutcomeUnknown):
            self.run_stop()
        journal = self.control.read('verification/stop-failed-' + self.backend + '.json')
        self.args.continue_intent_sha256 = journal['intent_sha256']
        self.docs['activation/current.json'] = subject.canonical({'phase': 'foreign', 'attempt': 'x'})
        with self.assertRaisesRegex(ValueError, 'predecessor'):
            self.run_stop()
        self.assertEqual(self.signals, [self.backend, self.frontend])

    def test_old_request_and_old_state_are_permanently_blocked_after_archive(self):
        import docker_volume_cancelled_activation_guard as guard
        record = {'schema': subject.PREPARED_QUARANTINE_SCHEMA, 'state': 'archived',
                  'target': self.target, 'scope': {'state_root': str(self.runtime.state)}}
        self.docs[subject.PREPARED_QUARANTINE] = subject.canonical(record)
        with self.assertRaisesRegex(ValueError, 'permanently retired'):
            guard.assert_start_allowed(self.control, self.target['request_id'])
        with self.assertRaisesRegex(ValueError, 'permanently retired'):
            guard.assert_start_allowed(self.control, 'new-request', reuse_state={'state': self.runtime.state / '..' / 'state'})


class PreparedConsumerTests(unittest.TestCase):
    def setUp(self):
        fixture = PreparedOrchestrationTests('test_preview_apply_has_no_new_operation_and_publishes_truthful_terminal_last')
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        plan = fixture.run_stop()
        fixture.args.apply = True
        fixture.args.expected_plan_sha256 = plan['plan_sha256']
        fixture.run_stop()
        self.fixture = fixture
        self.quarantine_raw = fixture.control.read_bytes(subject.PREPARED_QUARANTINE)
        self.quarantine_sha = subject.sha(self.quarantine_raw)
        self.compose = fixture.control.read('development/attempts/' + fixture.development + '/compose.json')

    def test_only_exact_stop_quarantine_enters_existing_cancellation_maintenance(self):
        f = self.fixture
        witness = subject.prepared_quarantine_context(
            f.control, f.previous, self.compose, f.rows, expected_sha256=self.quarantine_sha)
        self.assertEqual(witness['target'], f.target)
        with self.assertRaisesRegex(ValueError, 'explicitly selected'):
            subject.prepared_quarantine_context(f.control, f.previous, self.compose, f.rows, expected_sha256=None)
        f.docs['active'] = b'foreign-operation\n'
        with self.assertRaisesRegex(ValueError, 'another operation'):
            subject.prepared_quarantine_context(
                f.control, f.previous, self.compose, f.rows, expected_sha256=self.quarantine_sha)

    def _maintenance_request(self):
        from docker_volume_unclaimed_cancellation import REQUEST_ROOT, _request_path
        request_id = '3c815b4b-2e89-4b4c-9696-31af150bb21e'
        request = {'request_id': request_id, 'run_id': self.fixture.target['run_id'],
                   'task_id': self.fixture.target['task_id']}
        raw = subject.canonical(request)
        relative = REQUEST_ROOT + '/' + request_id + '.json'
        self.fixture.docs[relative] = raw
        operation = {'receipt': {'inputs': {'prepared_unclaimed_quarantine': {
            'quarantine_sha256': self.quarantine_sha, 'target': self.fixture.target}}}}
        maintenance = {'request_id': request_id, 'request_sha256': subject.sha(raw),
                       'request_path': _request_path(request_id)}
        return operation, maintenance, relative

    def test_prepared_maintenance_reads_absolute_guest_request_through_relative_control_api(self):
        from unittest.mock import patch
        operation, maintenance, relative = self._maintenance_request()
        read = self.fixture.control.read_bytes
        reads = []

        def read_relative(path, **kwargs):
            RealBuildControl.path(path)
            reads.append(path)
            return read(path, **kwargs)

        with patch.object(self.fixture.control, 'read_bytes', side_effect=read_relative):
            subject.assert_prepared_maintenance_allowed(self.fixture.control, operation, maintenance)
        self.assertEqual(reads, [subject.PREPARED_QUARANTINE, relative])

    def test_prepared_maintenance_rejects_request_path_outside_its_exact_identity(self):
        from unittest.mock import patch
        operation, maintenance, _ = self._maintenance_request()
        maintenance['request_path'] = '/opt/fullmag/control/runtime-control/OWNER.json'
        with patch.object(self.fixture.control, 'read_bytes', wraps=self.fixture.control.read_bytes) as read:
            with self.assertRaisesRegex(BuildControlError, 'request path differs'):
                subject.assert_prepared_maintenance_allowed(self.fixture.control, operation, maintenance)
        self.assertEqual([call.args[0] for call in read.call_args_list], [subject.PREPARED_QUARANTINE])

    def test_prepared_maintenance_rejects_payload_with_another_request_id(self):
        operation, maintenance, relative = self._maintenance_request()
        request = subject.decode(self.fixture.docs[relative])
        request['request_id'] = '4c815b4b-2e89-4b4c-9696-31af150bb21e'
        raw = subject.canonical(request)
        self.fixture.docs[relative] = raw
        maintenance['request_sha256'] = subject.sha(raw)
        with self.assertRaisesRegex(ValueError, 'maintenance request differs'):
            subject.assert_prepared_maintenance_allowed(self.fixture.control, operation, maintenance)

    def test_prepared_maintenance_requires_its_live_quarantine_before_start(self):
        operation, maintenance, _ = self._maintenance_request()
        del self.fixture.docs[subject.PREPARED_QUARANTINE]
        with self.assertRaisesRegex(ValueError, 'live prepared quarantine'):
            subject.assert_prepared_maintenance_allowed(self.fixture.control, operation, maintenance)

    def test_legacy_maintenance_without_prepared_witness_keeps_optional_quarantine(self):
        del self.fixture.docs[subject.PREPARED_QUARANTINE]
        subject.assert_prepared_maintenance_allowed(self.fixture.control, {'receipt': {'inputs': {}}}, None)

    def test_render_preserves_40_cpu_budget_native_gate_and_all_44_sources(self):
        import docker_volume_dev as dev
        included = sorted('examples/fixture-' + str(i) + '.py' for i in range(44))
        constraints = {'backend_budget': {'Memory': 32 * 1024**3, 'NanoCpus': 40 * 10**9, 'MemorySwap': 0},
                       'retained_native_contracts': ['fem-demag-poisson'], 'retained_include_untracked': included}
        document = {'services': {'backend': {'mem_limit': 32 * 1024**3, 'cpus': 40,
                    'command': ['start', '--native-contract', 'fem-demag-poisson'],
                    'environment': {dev.INCLUDE_UNTRACKED_ENV: json.dumps(included, separators=(',', ':'))}}}}
        subject.validate_prepared_render(document, constraints)
        for field, value in [('cpus', 16), ('mem_limit', 128 * 1024**3), ('command', ['start'])]:
            changed = copy.deepcopy(document)
            changed['services']['backend'][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                subject.validate_prepared_render(changed, constraints)
        document['services']['backend']['environment'][dev.INCLUDE_UNTRACKED_ENV] = json.dumps(included[:-1], separators=(',', ':'))
        with self.assertRaisesRegex(ValueError, 'allowlist'):
            subject.validate_prepared_render(document, constraints)

    def test_fresh_gate_uses_terminal_history_with_original_succeeded_run_and_native_cancelled_target(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        f = self.fixture
        witness = subject.prepared_quarantine_context(
            f.control, f.previous, self.compose, f.rows, expected_sha256=self.quarantine_sha)
        old_task = {'task_id': f.target['task_id'], 'lifecycle': 'accepted', 'artifact_ids': []}
        write(f.runtime.run / 'run_catalog.json', {'schema_version': 'run_catalog.v1', 'run_id': f.target['run_id'],
              'revision': 3, 'tasks': [dict(old_task, lifecycle='cancelled')]})
        old_run = f.runtime.store / 'runs/run-cpuoff-original'
        write(old_run / 'run_intent.json', intent(f.runtime.store, 'run-cpuoff-original'))
        write(old_run / 'run_catalog.json', {'schema_version': 'run_catalog.v1', 'run_id': 'run-cpuoff-original',
              'revision': 2, 'tasks': [{'task_id': 'cpuoff', 'lifecycle': 'succeeded', 'artifact_ids': ['original-zarr']}]})
        attempt = 'c' * 32
        previous = dict(attempt=attempt, state_root=str(f.runtime.state),
            backend_container=f.backend, frontend_container=f.frontend,
            backend_started_at=f.rows['backend']['State']['StartedAt'],
            frontend_started_at=f.rows['frontend']['State']['StartedAt'])
        for service in ('backend', 'frontend'):
            f.rows[service]['Config']['Labels'] = {'com.docker.compose.project': f.control.project,
                                                  'com.docker.compose.service': service}
        f.rows['backend']['State'].update(ExitCode=0, FinishedAt='maintenance-finished')
        f.rows['frontend']['State'].update(Running=True, Pid=1234)
        f.docs['development/attempts/' + attempt + '/terminal.json'] = subject.canonical(previous)
        request = {'run_id': f.target['run_id'], 'task_id': f.target['task_id'], 'expected_task': old_task}
        result = {'native_result': {'catalog_revision': 3, 'disposition': 'cancelled'},
                  'backend_finished_at': 'maintenance-finished'}
        validated = (result, b'', b'', request, b'', {'prepared_unclaimed_quarantine': witness}, b'', self.compose, b'')
        args = SimpleNamespace(prepared_quarantine_sha256=self.quarantine_sha, fresh_state=True, script=None, source_root=f.root)
        def snapshot(control, backend, **kwargs):
            self.assertNotIn('retained_cancelled_runs', kwargs)
            self.assertEqual({row['run_id'] for row in kwargs['retained_terminal_runs']},
                             {f.target['run_id'], 'run-cpuoff-original'})
            return {'run_records': kwargs['retained_terminal_runs']}
        before_docs, before_signals = copy.deepcopy(f.docs), list(f.signals)
        with patch('docker_volume_cancelled_recovery._validate_operation', return_value=validated), \
             patch('docker_volume_container_recovery._ledger_and_store_snapshot', side_effect=snapshot) as checked:
            admission = subject.require_prepared_fresh_archive(
                f.control, args, previous, self.compose, f.rows, recreate_services=True,
                allow_running_frontend=True)
            checked.assert_called_once()
            with self.assertRaisesRegex(ValueError, 'stopped maintenance pair'):
                subject.require_prepared_fresh_archive(
                    f.control, args, previous, self.compose, f.rows, recreate_services=True)
            for case in ('backend-active', 'backend-exit', 'backend-finished', 'foreign-id',
                         'foreign-project', 'foreign-image', 'frontend-restarted', 'fingerprint-drift'):
                changed = copy.deepcopy(f.rows)
                if case == 'backend-active': changed['backend']['State'].update(Running=True, Pid=4321)
                if case == 'backend-exit': changed['backend']['State']['ExitCode'] = 1
                if case == 'backend-finished': changed['backend']['State']['FinishedAt'] = 'other'
                if case == 'foreign-id': changed['frontend']['Id'] = '0' * 64
                if case == 'foreign-project': changed['frontend']['Config']['Labels']['com.docker.compose.project'] = 'foreign'
                if case == 'foreign-image': changed['frontend']['Image'] = 'sha256:' + '0' * 64
                if case == 'frontend-restarted': changed['frontend']['State']['StartedAt'] = 'later'
                if case == 'fingerprint-drift': changed['frontend']['HostConfig']['ReadonlyRootfs'] = True
                with self.subTest(case=case), self.assertRaises((ValueError, BuildControlError)):
                    subject.require_prepared_fresh_archive(
                        f.control, args, previous, self.compose, changed, recreate_services=True,
                        allow_running_frontend=True, expected_service_pins=admission['maintenance_service_pins'])
            f.rows['frontend']['State'].update(Running=False, Pid=0)
            stopped_admission = subject.require_prepared_fresh_archive(
                f.control, args, previous, self.compose, f.rows, recreate_services=True,
                expected_service_pins=admission['maintenance_service_pins'])
            self.assertEqual(stopped_admission, admission)
        self.assertEqual(admission['quarantine_sha256'], self.quarantine_sha)
        self.assertEqual(admission['constraints'], witness)
        self.assertEqual(f.docs, before_docs)
        self.assertEqual(f.signals, before_signals)

    def test_fresh_consumer_recovers_only_missing_contracts_from_authenticated_witness(self):
        import docker_volume_dev as dev
        witness = {'retained_native_contracts': ['fem-demag-poisson']}
        previous = {'state': 'succeeded', 'inputs': {'prepared_unclaimed_quarantine': witness},
            'unclaimed_cancellation_preflight': {'prepared_unclaimed_quarantine': witness},
            'unclaimed_cancellation_result': {'state': 'cancelled'}}
        document = {'services': {'backend': {'command': ['start', '--native-contract', 'fem-demag-poisson']}}}
        admission = {'schema': 'fullmag.docker-prepared-cancelled-fresh-admission.v1',
                     'constraints': witness,
                     'cancellation_terminal_sha256': subject.sha(subject.canonical(previous) + b'\n')}
        original = copy.deepcopy(previous)
        self.assertEqual(dev._retained_prepared_fresh_contracts(previous, document, admission), ('fem-demag-poisson',))
        self.assertEqual(previous, original)
        for case in ('no-admission', 'empty-recorded', 'changed-recorded', 'empty-command',
                     'changed-command', 'empty-witness', 'foreign-terminal'):
            changed, compose, context = copy.deepcopy(previous), copy.deepcopy(document), copy.deepcopy(admission)
            if case == 'no-admission': context = None
            if case == 'empty-recorded': changed['inputs']['native_contracts'] = []
            if case == 'changed-recorded': changed['inputs']['native_contracts'] = ['foreign']
            if case == 'empty-command': compose['services']['backend']['command'] = ['start']
            if case == 'changed-command': compose['services']['backend']['command'][-1] = 'foreign'
            if case == 'empty-witness': context['constraints']['retained_native_contracts'] = []
            if case == 'foreign-terminal': context['cancellation_terminal_sha256'] = '0' * 64
            if context is not None and case != 'foreign-terminal':
                context['cancellation_terminal_sha256'] = subject.sha(subject.canonical(changed) + b'\n')
            with self.subTest(case=case), self.assertRaises(BuildControlError):
                dev._retained_prepared_fresh_contracts(changed, compose, context)

    def test_prepared_recreation_rechecks_stopped_pair_before_remove_and_archive(self):
        import docker_volume_dev as dev
        tree = ast.parse(Path(dev.__file__).read_text())
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                        and node.name == '_retained_operation')
        calls = [node for node in ast.walk(function) if isinstance(node, ast.Call)
                 and isinstance(node.func, ast.Name)]
        guards = sorted((node for node in calls if node.func.id == 'require_prepared_fresh_archive'),
                        key=lambda node: node.lineno)
        self.assertEqual(len(guards), 3)
        for guard in guards[:2]:
            keywords = {item.arg: item.value for item in guard.keywords}
            self.assertIsInstance(keywords['allow_running_frontend'], ast.Constant)
            self.assertIs(keywords['allow_running_frontend'].value, True)
        strict = guards[-1]
        self.assertNotIn('allow_running_frontend', {item.arg for item in strict.keywords})
        self.assertIn('expected_service_pins', {item.arg for item in strict.keywords})
        stopping = [node.lineno for node in calls if node.func.id == 'docker_capture'
                    and node.args and isinstance(node.args[0], ast.Constant)
                    and node.args[0].value == 'stop' and guards[1].lineno < node.lineno < strict.lineno]
        removing = [node.lineno for node in calls if node.func.id == 'docker_capture'
                    and node.args and isinstance(node.args[0], ast.Constant)
                    and node.args[0].value == 'rm' and node.lineno > strict.lineno]
        archives = [node.lineno for node in calls if node.func.id == 'archive_runtime_control']
        self.assertTrue(stopping)
        self.assertTrue(removing)
        self.assertLess(strict.lineno, min(removing))
        self.assertLess(strict.lineno, min(archives))


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
