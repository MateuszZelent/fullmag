"""Exact loader-failure reconciliation, without any native/runtime invocation."""
import copy
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_volume_no_spawn_loader_reconcile as subject


class ReceiptTests(unittest.TestCase):
    def fixture(self):
        control = SimpleNamespace(project='own-project', volume='own-control', namespace='', namespace_registry_sha256=None)
        request_raw = b'{"request_id":"original-request"}\n'
        receipt = {'schema': 'fullmag.docker-build-operation.v1', 'phase': subject.PHASE,
                   'state': 'outcome-unknown-resources-retained', 'attempt': 'a' * 32,
                   'compose_project': control.project, 'control_volume': control.volume,
                   'helper_container': 'fullmag-control-' + 'a' * 32, 'error': subject.LOADER_ERROR,
                   'inputs': {'source_root': '/source', 'request_sha256': subject.sha(request_raw),
                              'backend_container_id': 'b' * 64, 'image_id': 'sha256:' + 'c' * 64,
                              'executor': {'source_root': '/source', 'commit': 'd' * 40,
                                           'controller_sha256': subject.CONTROLLER_SHA256}}}
        raw = subject.canonical(receipt) + b'\n'
        return control, request_raw, receipt, raw

    def validate(self, receipt=None):
        control, request_raw, original, raw = self.fixture()
        if receipt is not None:
            original = receipt
            raw = subject.canonical(receipt) + b'\n'
        return subject.validate_receipt(control, raw, attempt='a' * 32, receipt_sha256=subject.sha(raw),
                                        request_raw=request_raw, selected='/source', backend_id='b' * 64,
                                        image_id='sha256:' + 'c' * 64)

    def test_only_exact_historical_loader_error_and_controller_are_admitted(self):
        self.validate()
        _, _, receipt, _ = self.fixture()
        for field in ['error', 'phase', 'state']:
            changed = copy.deepcopy(receipt)
            changed[field] += ' changed'
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.validate(changed)
        receipt['inputs']['executor']['controller_sha256'] = 'f' * 64
        with self.assertRaisesRegex(ValueError, 'controller'):
            self.validate(receipt)

    def test_request_namespace_backend_and_receipt_cas_drift_are_rejected(self):
        control, request_raw, receipt, raw = self.fixture()
        with self.assertRaisesRegex(ValueError, 'receipt CAS'):
            subject.validate_receipt(control, raw, attempt='a' * 32, receipt_sha256='e' * 64,
                                     request_raw=request_raw, selected='/source', backend_id='b' * 64,
                                     image_id='sha256:' + 'c' * 64)
        for key, value in [('backend_container_id', 'e' * 64), ('request_sha256', 'e' * 64)]:
            changed = copy.deepcopy(receipt)
            changed['inputs'][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.validate(changed)
        receipt['control_namespace'] = 'foreign'
        with self.assertRaisesRegex(ValueError, 'namespace'):
            self.validate(receipt)




class InventoryTests(unittest.TestCase):
    def setUp(self):
        from docker_volume_linux_supervision_stop import ERROR
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.store, self.ledger, self.owners = root/'store', root/'ledger', root/'control/runtime-services'
        self.run = self.store/'runs/run-a'
        def save(path, value):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(subject.canonical(value) + b'\n')
        self.save = save
        owner = {'state': 'failed', 'pid': 10, 'children': [{'pid': 11}, {'pid': 12}]}
        save(self.owners/'OWNER.json', owner)
        config = {'store_root': str(self.store)}
        save(self.owners.parent/'runtime-service/docker-all.json', config)
        process = {'state': 'failed_outcome_retained', 'api_diagnostic_only': True,
                   'accepted_store': str(self.store), 'error': ERROR}
        save(self.owners.parent/'runtime-service/process-tree.json', process)
        identity = {'run_id': 'run-a', 'task_id': 'task-a', 'resource_id': 'cpu',
                    'lease_token': 'lease-a', 'owner': {'attempt_id': 'attempt-a'}}
        lease = {'state': 'active'}
        reservation = {'state': 'committed', 'identity': identity, 'worker_launch_gate': {'state': 'pending'}}
        save(self.run/'resource_leases/cpu/lease-a.json', lease)
        save(self.ledger/'HOST_RESOURCE_LEDGER.json', {'reservations': [reservation]})
        task = {'task_id': 'task-a', 'lifecycle': 'preparing'}
        save(self.run/'run_catalog.json', {'tasks': [task]})
        save(self.run/'run_intent.json', {'run_id': 'run-a', 'original': True})
        claim = {'immutable': 'original claim'}
        for i, kind in enumerate(['prepare', 'start']):
            save(self.run/('coordinator_journal/command/cmd-'+str(i)+'.json'), {
                'task_id': 'task-a', 'attempt_id': 'attempt-a', 'terminal': False,
                'payload': {'checkpoint': {'claim': claim}, 'message': {'envelope': {'command': {'kind': kind}}}}})
        save(self.run/'coordinator_journal/event/prepared.json', {'task_id': 'task-a', 'attempt_id': 'attempt-a',
            'payload': {'message': {'envelope': {'event': {'kind': 'prepared'}}}}})
        self.before = {'owner_sha256': subject.sha((self.owners/'OWNER.json').read_bytes()),
                       'config_sha256': subject.sha(subject.canonical(config)),
                       'process_receipt_sha256': subject.sha((self.owners.parent/'runtime-service/process-tree.json').read_bytes()),
                       'claim': claim, 'task': task, 'lease': lease, 'reservation': reservation}
        self.request = {'identity': identity, 'expected_owner': owner,
                        'owner_sha256': self.before['owner_sha256'], 'config_sha256': self.before['config_sha256'],
                        **{name+'_sha256': subject.sha(subject.canonical(self.before[name])) for name in ['claim','lease','reservation']}}

    def snapshot(self):
        return subject.inventory_snapshot(self.store, self.ledger, self.owners, self.request, self.before)

    def test_complete_target_tree_is_pinned_and_original_prepare_start_is_preserved(self):
        before = self.snapshot()
        self.save(self.run/'retained-artifact.json', {'saved': 'preserve'})
        self.assertNotEqual(before, self.snapshot())
        self.assertIn('coordinator_journal/event/prepared.json', before['run_inventory']['files'])

    def test_stop_exit_and_started_side_effects_refuse_technical_finalization(self):
        path = self.run/'coordinator_journal/command/cmd-1.json'
        record = json.loads(path.read_bytes())
        record['payload']['message']['envelope']['command']['kind'] = 'stop'
        self.save(path, record)
        with self.assertRaisesRegex(ValueError, 'Stop appeared'):
            self.snapshot()
        record['payload']['message']['envelope']['command']['kind'] = 'start'
        self.save(path, record)
        (self.run/'worker-attempts').mkdir()
        with self.assertRaisesRegex(ValueError, 'side effect directory'):
            self.snapshot()

    def test_committed_pending_gate_and_active_lease_cannot_be_relaxed(self):
        changed = copy.deepcopy(self.before['reservation'])
        changed['worker_launch_gate'] = {'state': 'consumed', 'token': 'used'}
        self.save(self.ledger/'HOST_RESOURCE_LEDGER.json', {'reservations': [changed]})
        with self.assertRaisesRegex(ValueError, 'pending host reservation'):
            self.snapshot()

    def test_generated_guard_source_compiles_and_technical_script_is_create_only(self):
        compile(subject.guest_script(self.request, self.before, hold=True), '<readonly guard>', 'exec')
        control = SimpleNamespace(path=lambda relative: '/control/'+relative, _namespace_guard=lambda script: script)
        script = subject.commit_script(control, 'cancel-failed-no-spawn/attempts/'+'a'*32,
                                       'a'*32, 'b'*64, 'c'*64, 'd'*64)
        # Exercise the actual shell transaction against temporary control paths.
        import subprocess
        parent = Path(self.tmp.name)/'technical'
        parent.mkdir()
        receipt, request, active = b'original unknown', b'original request', ('a'*32+'\n').encode()
        (parent/'receipt.json').write_bytes(receipt)
        (parent/'request.json').write_bytes(request)
        (parent/'active').write_bytes(active)
        terminal = b'{"state":"failed-confirmed"}\n'
        control.path = lambda relative: str(parent)
        script = subject.commit_script(control, 'unused', 'a'*32,
            subject.sha(receipt), subject.sha(request), subject.sha(terminal))
        script = script.replace('/control/active', str(parent/'active'))
        result = subprocess.run(['/bin/bash','-euo','pipefail','-c',script],input=terminal,capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual((parent/'terminal.json').read_bytes(), terminal)
        self.assertEqual((parent/'receipt.json').read_bytes(), receipt)
        self.assertEqual((parent/'active').read_bytes(), active)
        self.assertNotEqual(subprocess.run(['/bin/bash','-euo','pipefail','-c',script],input=terminal,capture_output=True).returncode, 0)




class ProtocolTests(ReceiptTests):
    def test_preview_and_existing_terminal_replay_never_repeat_publication(self):
        from contextlib import nullcontext
        from unittest.mock import patch
        control, request_raw, receipt, raw = self.fixture()
        root = subject.PHASE + '/attempts/' + 'a'*32
        docs = {root+'/receipt.json': raw, root+'/request.json': request_raw, 'active': ('a'*32+'\n').encode()}
        control.read_bytes = lambda path, optional=False: docs.get(path) if optional else docs[path]
        control.path = lambda path: '/control/' + path
        control._namespace_guard = lambda script: script
        before = {'same': 'frozen native observation'}
        inventory = {'complete': 'protected run inventory'}
        helper = {'id': 'e'*64, 'image_id': 'sha256:'+'f'*64, 'started_at': 'original start'}
        kwargs = dict(attempt='a'*32, receipt_sha256=subject.sha(raw), request_raw=request_raw,
                      selected='/source', backend_id='b'*64, image_id='sha256:'+'c'*64,
                      before=before, observe=lambda: before)
        def publish(argv, data, timeout):
            self.assertIn(helper['id'], argv)
            docs[root+'/terminal.json'] = data
            return SimpleNamespace(returncode=0)
        with patch.object(subject, 'authenticate_helper', return_value=helper), \
             patch.object(subject, 'capture_inventory', return_value=inventory), \
             patch.object(subject, 'inventory_guard', return_value=nullcontext()), \
             patch.object(subject, 'confirm_release') as release, \
             patch('docker_build_control.bounded_capture', side_effect=publish) as execute:
            preview = subject.reconcile(control, apply=False, **kwargs)
            self.assertEqual(preview['state'], 'preview-loader-failure-no-mutation')
            execute.assert_not_called()
            applied = subject.reconcile(control, apply=True, **kwargs)
            self.assertEqual(applied['state'], 'failed-confirmed')
            self.assertEqual(docs[root+'/receipt.json'], raw)
            self.assertEqual(docs[root+'/request.json'], request_raw)
            self.assertEqual(execute.call_count, 1)
            control.image = 'immutable-original-helper'
            with patch.object(subject, 'docker_capture', return_value=SimpleNamespace(
                    stdout=json.dumps([{'Id': helper['image_id']}]).encode())):
                replay = subject.reconcile(control, apply=True, **kwargs)
            self.assertTrue(replay['replay'])
            self.assertEqual(execute.call_count, 1)
            self.assertEqual(release.call_count, 2)

    def test_existing_native_result_blocks_before_helper_or_publication(self):
        from unittest.mock import patch
        control, request_raw, receipt, raw = self.fixture()
        root = subject.PHASE+'/attempts/'+'a'*32
        docs = {root+'/receipt.json':raw,root+'/request.json':request_raw,
                root+'/native-result.json':b'{"native":"effect"}', 'active':('a'*32+'\n').encode()}
        control.read_bytes = lambda path, optional=False: docs.get(path) if optional else docs[path]
        with patch.object(subject, 'authenticate_helper') as helper:
            with self.assertRaisesRegex(ValueError, 'native result already exists'):
                subject.reconcile(control,attempt='a'*32,receipt_sha256=subject.sha(raw),request_raw=request_raw,
                    selected='/source',backend_id='b'*64,image_id='sha256:'+'c'*64,
                    before={},observe=lambda:{},apply=True)
            helper.assert_not_called()


class ReleaseTests(unittest.TestCase):
    def test_exact_lowercase_and_uppercase_daemon_absence_confirm_release(self):
        from unittest.mock import patch
        helper={'id':'a'*64,'image_id':'sha256:'+'b'*64,'started_at':'original'}
        control=SimpleNamespace(read_bytes=lambda *args,**kwargs:None,helper_args=lambda script:[script])
        for prefix in ('error: no such object: ','Error: No such container: '):
            with self.subTest(prefix=prefix),\
                 patch.object(subject,'docker_capture',return_value=SimpleNamespace(returncode=1,stdout=b'[]\n',stderr=(prefix+helper['id']+'\n').encode())),\
                 patch('docker_volume_activation_reconcile._probe_helper_absence',return_value='c'*64) as absence,\
                 patch('docker_build_control.bounded_capture',return_value=SimpleNamespace(returncode=0)) as lock:
                subject.confirm_release(control,helper,'d'*32)
                absence.assert_called_once_with('fullmag-control-'+'d'*32)
                lock.assert_called_once()

    def test_daemon_error_is_never_an_absence_proof(self):
        from unittest.mock import patch
        helper={'id':'a'*64,'image_id':'sha256:'+'b'*64,'started_at':'original'}
        control=SimpleNamespace(read_bytes=lambda *args,**kwargs:None)
        with patch.object(subject,'docker_capture',return_value=SimpleNamespace(returncode=1,stdout=b'',stderr=b'cannot connect to daemon')),\
             patch('docker_build_control.bounded_capture') as lock:
            with self.assertRaisesRegex(ValueError,'absence is not confirmed'):
                subject.confirm_release(control,helper,'d'*32)
            lock.assert_not_called()


if __name__ == '__main__':
    unittest.main()
