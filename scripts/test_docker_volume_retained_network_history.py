"""Synthetic retained-prestart history proofs; never contact Docker."""
from copy import deepcopy
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from docker_build_control import BuildControlError, canonical
from docker_volume_reconcile import digest
import docker_volume_retained_network_history as history


def raw(value):
    return canonical(value) + b'\n'


def fixture():
    old, current, failed, stop, recreation = (char * 32 for char in '12345')
    identity = dict(source_root='/source', project_name='test-project', project_id='test',
                    worktree_id='test-worktree', checkout_kind='worktree')
    control = SimpleNamespace(identity=identity, project='test-project', volume='test-control', namespace='')
    inputs = dict(source_root='/source', source_project_id='test', source_worktree_id='test-worktree',
                  source_checkout_kind='worktree')
    common = dict(schema='fullmag.docker-build-operation.v1', compose_project=control.project,
                  control_volume=control.volume, inputs=inputs)
    backend, frontend = 'a' * 64, 'b' * 64
    compose = dict(name=control.project, services={'backend': {'image': 'sha256:' + 'a' * 64}, 'frontend': {'image': 'sha256:' + 'a' * 64}})
    config_sha = digest(canonical(compose))
    config = dict(schema_version='runtime_service_config.v2', target_id='docker-all',
                  compute_pool_id='compute', preparation_pool_id='preparation')
    ready = dict(schema_version='runtime_service_owner.v1', protocol='stdin-v1', target_id='docker-all',
                 state='ready', owner_token='11111111-1111-4111-8111-111111111111',
                 process_start_token='22222222-2222-4222-8222-222222222222', pid=10, host='test-host',
                 acquired_at='test-time', heartbeat_at='test-time', build_commit='c' * 40,
                 build_snapshot='d' * 64, compute_pool_generation=1, preparation_pool_generation=1,
                 compute_pool_id='compute', preparation_pool_id='preparation', control_address='local',
                 children=[dict(role='compute', pid=11, status='running'),
                           dict(role='preparation', pid=12, status='running')])
    owner = deepcopy(ready)
    owner.update(state='drained', children=[{**child, 'status': 'exited_success'} for child in ready['children']])
    process = dict(schema='fullmag.docker-process-tree.v1', state='drained', service_owner=ready,
                   terminal_service_owner=owner)
    provenance = dict(schema='fullmag.docker-all-image.v1', state='succeeded',
                      build_receipt_sha256='e' * 64, package_root='/opt/fullmag/package',
                      backend_build_receipt='/opt/fullmag/package/backend-build-receipt.json',
                      backend_build_receipt_schema='fullmag.direct-compose.backend-build-receipt.v1',
                      native_source_identity=dict(schema='fullmag.source-snapshot.v2',
                                                  head_commit_full='c' * 40, source_snapshot_sha256='d' * 64),
                      commit='c' * 40, source_snapshot_sha256='d' * 64, source_mode='live-shadow-v1',
                      direct_source_provenance='fullmag.docker-backend-live-source.v1', source_digest='f' * 64,
                      binary_hashes={'native': 'a' * 64})
    provenance['native_source_identity_sha256'] = digest(raw(provenance['native_source_identity']))
    previous = dict(common, phase='development', attempt=old, state='succeeded', started_at=1, finished_at=2,
                    config_sha256=config_sha, backend_container=backend, frontend_container=frontend,
                    backend_build_receipt_sha256='e' * 64, state_root='/runtime/' + old)
    failed_current = dict(common, phase='development', attempt=current, state='failed-confirmed',
                          started_at=7, finished_at=8, error='cache failure before Compose')
    original = dict(common, phase='development', attempt=failed, state='outcome-unknown-resources-retained',
                    started_at=9)
    stop_doc = dict(common, phase='iteration', attempt=stop, state='succeeded', started_at=3, finished_at=4,
                    inputs=dict(source_root='/source', attempt=old, config_sha256=config_sha),
                    idle_backend_stopped=True, backend_container=backend, frontend_container=frontend,
                    config_sha256=config_sha)
    rec_doc = dict(common, phase='recreate-services', attempt=recreation, state='succeeded', started_at=5,
                   finished_at=6, inputs=dict(source_root='/source', attempt=old, config_sha256=config_sha),
                   removed_containers=[backend, frontend], fresh_state=False, previous_state_root=previous['state_root'])
    documents = {'development/current.json': raw(failed_current), 'development/verified.json': raw(previous),
                 'backend/runtime-provenance.json': raw(provenance),
                 'runtime-control/runtime-service/process-tree.json': raw(process),
                 'runtime-control/runtime-services/OWNER.json': raw(owner),
                 'runtime-control/runtime-services/docker-client-' + ready['owner_token'] + '.json': raw(ready),
                 'runtime-control/runtime-service/docker-all.json': raw(config),
                 'iteration/attempts/' + stop + '/backend-drain.json': raw(dict(
                     schema='fullmag.docker-idle-restart-drain.v1', backend_container_id=backend,
                     process_receipt=process, process_receipt_sha256=digest(raw(process)))),
                 'development/attempts/' + old + '/compose.json': raw(compose)}
    from docker_compose_identity import source_labels
    snapshot = {service: dict(Id=identifier, Image='sha256:' + 'a' * 64,
                Config={'Labels': {**source_labels(identity), 'com.docker.compose.project': control.project,
                                  'com.docker.compose.service': service}}, HostConfig={}, Mounts=[], State=dict(Running=False, Status='exited', Pid=0,
                ExitCode=0, OOMKilled=False)) for service, identifier in (('backend', backend), ('frontend', frontend))}
    documents['iteration/attempts/' + stop + '/idle-stop-containers.json'] = raw(snapshot)
    documents['iteration/attempts/' + stop + '/compose.json'] = raw(compose)
    documents['recreate-services/attempts/' + recreation + '/retained-containers.json'] = raw(snapshot)
    stop_doc['idle_stop_containers_sha256'] = digest(raw(snapshot))
    for phase, token, doc in [('development', old, previous), ('development', current, failed_current),
                              ('iteration', stop, stop_doc), ('recreate-services', recreation, rec_doc)]:
        for name in ('receipt', 'terminal'):
            documents[f'{phase}/attempts/{token}/{name}.json'] = raw(doc)
    import json
    for path in ('runtime-control/runtime-services/OWNER.json',
                 'runtime-control/runtime-services/docker-client-' + ready['owner_token'] + '.json'):
        documents[path] = json.dumps(json.loads(documents[path]), indent=2).encode()
    publications = {name: documents[name] for name in history.PUBLICATION_PATHS}
    publications['development/attempts/' + failed + '/terminal.json'] = None
    kwargs = dict(failed_attempt=failed, original=original, publications=publications,
                  attempts=[(token, 'd') for token in sorted([old, current, failed])],
                  current_sha256=digest(raw(failed_current)), verified_sha256=digest(raw(previous)),
                  recreation_attempt=recreation, recreation_sha256=digest(raw(rec_doc)),
                  stop_attempt=stop, stop_sha256=digest(raw(stop_doc)), native_config_sha256=digest(raw(config)))
    return control, documents, kwargs


class RetainedHistoryTests(unittest.TestCase):
    def validate(self, documents, control, kwargs):
        with patch.object(history, 'read_raw', side_effect=lambda c, p, optional=False: documents.get(p)):
            return history.validate_retained_history(control, **kwargs)

    def test_retained_current_and_verified_are_bound_to_distinct_terminal_receipts(self):
        control, documents, kwargs = fixture()
        proof = self.validate(documents, control, kwargs)
        self.assertEqual(proof['mode'], 'retained-prestart')
        self.assertEqual(proof['manifest_sha256'], digest(canonical(proof['retained_records'])))
        self.assertEqual(proof['retained_records']['development/current.json'], kwargs['current_sha256'])

    def test_rejects_every_missing_or_modified_protected_record(self):
        control, documents, kwargs = fixture()
        proof = self.validate(documents, control, kwargs)
        for path in proof['retained_records']:
            if path not in documents:
                continue
            with self.subTest(path=path), self.assertRaises(BuildControlError):
                self.validate({**documents, path: b'{}\n'}, control, kwargs)

    def test_precompose_partial_publication_and_native_pool_or_child_drift_are_refused(self):
        import json
        for mutation in ('current-compose', 'partial', 'config-pool', 'failed-child', 'recreated-incarnation'):
            with self.subTest(mutation=mutation):
                control, documents, kwargs = fixture()
                if mutation == 'current-compose':
                    documents['development/attempts/' + '2' * 32 + '/compose.json'] = raw({'name': control.project})
                elif mutation == 'partial':
                    documents['development/attempts/' + '3' * 32 + '/reconciliation/prepared.json'] = raw({})
                elif mutation == 'config-pool':
                    path = 'runtime-control/runtime-service/docker-all.json'
                    config = json.loads(documents[path])
                    config['compute_pool_id'] = 'another-pool'
                    documents[path] = raw(config)
                    kwargs['native_config_sha256'] = digest(documents[path])
                elif mutation == 'failed-child':
                    path = 'runtime-control/runtime-services/OWNER.json'
                    owner = json.loads(documents[path])
                    owner['children'][0]['status'] = 'exited_failure'
                    documents[path] = raw(owner)
                    kwargs['publications'][path] = documents[path]
                else:
                    path = 'recreate-services/attempts/' + '5' * 32 + '/retained-containers.json'
                    snapshot = json.loads(documents[path])
                    snapshot['backend']['State']['StartedAt'] = 'another-incarnation'
                    documents[path] = raw(snapshot)
                with self.assertRaises(BuildControlError):
                    self.validate(documents, control, kwargs)

    def test_unknown_history_attempt_is_refused(self):
        control, documents, kwargs = fixture()
        kwargs['attempts'].append(('f' * 32, 'd'))
        with self.assertRaises(BuildControlError):
            self.validate(documents, control, kwargs)

    def test_drained_label_without_authenticated_transition_is_refused(self):
        control, documents, kwargs = fixture()
        documents['runtime-control/runtime-services/OWNER.json'] = raw(dict(state='drained'))
        kwargs['publications']['runtime-control/runtime-services/OWNER.json'] = documents['runtime-control/runtime-services/OWNER.json']
        with self.assertRaises(BuildControlError):
            self.validate(documents, control, kwargs)




class RetainedPublicationTests(unittest.TestCase):
    def test_real_shell_cas_preserves_records_and_refuses_record_inventory_and_active_drift(self):
        import fcntl
        from pathlib import Path
        import subprocess
        import tempfile
        import docker_volume_network_failure_reconcile as reconcile
        for drift in (None, 'owner', 'current', 'history', 'inventory', 'active', 'partial'):
            with self.subTest(drift=drift), tempfile.TemporaryDirectory() as temp:
                base = Path(temp).resolve()
                control, documents, kwargs = fixture()
                proof = RetainedHistoryTests().validate(documents, control, kwargs)
                attempt = kwargs['failed_attempt']
                control.path = lambda path: str(base / path)
                root = base / 'development/attempts' / attempt
                root.mkdir(parents=True)
                (root / 'receipt.json').write_bytes(b'original')
                (root / 'compose.json').write_bytes(b'compose')
                for path, payload in documents.items():
                    target = base / path
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(payload)
                (base / 'active').write_text(attempt + '\n')
                (base / 'operation.lock').touch()
                with (base / 'operation.lock').open('rb') as lock:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    prepared = {str(root / path): payload for path, payload in (
                        ('unknown-receipt.json', b'original'), ('reconciliation/network-failure-proof.json', b'proof'),
                        ('reconciliation/result.json', b'result'), ('reconciliation/prepared.json', b'prepared'))}
                    script = reconcile._cas_script(control, attempt, digest(b'original'), digest(b'compose'),
                        digest(b'proof'), digest(b'result'), digest(b'prepared'), prepared_documents=prepared,
                        retained_records=proof['retained_records'], retained_attempts=kwargs['attempts'])
                    if drift in ('owner', 'current', 'history'):
                        path = {'owner': 'runtime-control/runtime-services/OWNER.json', 'current': 'development/current.json',
                                'history': 'development/attempts/' + '1' * 32 + '/terminal.json'}[drift]
                        (base / path).write_bytes(b'changed')
                    elif drift == 'inventory':
                        (base / 'development/attempts' / ('f' * 32)).mkdir()
                    elif drift == 'active':
                        (base / 'active').write_text(attempt + '\n\n')
                    elif drift == 'partial':
                        (root / 'reconciliation').mkdir()
                        (root / 'reconciliation/prepared.json').write_bytes(b'partial')
                    result = subprocess.run(['bash', '-euc', script], input=reconcile._prepared_input(prepared), capture_output=True)
                if drift is None:
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual((root / 'terminal.json').read_bytes(), b'result')
                    self.assertEqual((root / 'receipt.json').read_bytes(), b'result')
                    for path, payload in documents.items():
                        self.assertEqual((base / path).read_bytes(), payload)
                else:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse((root / 'terminal.json').exists())
                    self.assertEqual((root / 'receipt.json').read_bytes(), b'original')
                self.assertTrue((base / 'active').exists())  # Only original helper releases its own marker.


class RetainedPreviewApplyTests(unittest.TestCase):
    def setup_transaction(self):
        import test_docker_volume_network_failure_reconcile as existing
        import docker_volume_network_failure_reconcile as reconcile
        f = existing.ReconcileTransactionTests()
        f.setUp()
        f.args.retained_prestart = True
        for name in ('retained_current_sha256', 'retained_verified_sha256', 'stop_sha256', 'native_config_sha256', 'recreation_sha256'):
            setattr(f.args, name, 'a' * 64)
        f.args.stop_attempt = 'b' * 32
        f.args.recreation_attempt = 'c' * 32
        f.observation['retained_history'] = dict(mode='retained-prestart', retained_records={
            'development/current.json': digest(b'current'), 'development/verified.json': digest(b'verified')})
        f.args.expected_plan_sha256 = digest(canonical(dict(schema=reconcile.SCHEMA, observation=f.observation)))
        return f

    def test_apply_requires_plan_pin_before_any_docker_observation(self):
        import docker_volume_network_failure_reconcile as reconcile
        f = self.setup_transaction()
        f.args.expected_plan_sha256 = None
        with patch.object(reconcile, '_identity_and_control') as identify, self.assertRaises(BuildControlError):
            reconcile.reconcile(f.args)
        identify.assert_not_called()

    def test_changed_preview_hash_refuses_before_any_publication(self):
        import docker_volume_network_failure_reconcile as reconcile
        f = self.setup_transaction()
        f.args.expected_plan_sha256 = '0' * 64
        from pathlib import Path
        with patch.object(reconcile, '_identity_and_control', return_value=(Path(f.args.source_root),
                          dict(source_root=f.args.source_root, network_name='test-network'), f.control)), \
             patch.object(reconcile, '_observe', return_value=f.observation), \
             patch.object(reconcile.time, 'sleep'), patch.object(reconcile, 'bounded_capture') as publish:
            with self.assertRaisesRegex(BuildControlError, 'plan SHA-256 differs'):
                reconcile.reconcile(f.args)
        publish.assert_not_called()

    def test_retained_apply_keeps_both_pointers_and_passes_manifest_and_census_to_cas(self):
        import docker_volume_network_failure_reconcile as reconcile
        import subprocess
        from pathlib import Path
        f = self.setup_transaction()
        state = {'committed': False}
        def read(control, path, optional=False):
            if path in ('development/current.json', 'development/verified.json'):
                return b'current' if path.endswith('current.json') else b'verified'
            if path.endswith('/receipt.json'):
                return f.result_raw if state['committed'] else f.original_raw
            if path.endswith('/terminal.json'):
                return f.result_raw if state['committed'] else None
            if path == 'active':
                return None if state['committed'] else (f.args.attempt + '\n').encode()
            return None
        def commit(*args, **kwargs):
            state['committed'] = True
            return subprocess.CompletedProcess([], 0, b'', b'')
        with patch.object(reconcile, '_identity_and_control', return_value=(Path(f.args.source_root),
                          dict(source_root=f.args.source_root, network_name='test-network'), f.control)), \
             patch.object(reconcile, '_observe', return_value=f.observation), \
             patch.object(reconcile.time, 'sleep'), patch.object(reconcile, 'read_raw', side_effect=read), \
             patch.object(reconcile, '_failure_result', return_value=f.result_raw), \
             patch.object(reconcile, '_cas_script', return_value='cas') as cas, \
             patch.object(reconcile, '_probe_helper_absence', return_value='d' * 64), \
             patch.object(reconcile, 'bounded_capture', side_effect=commit):
            result = reconcile.reconcile(f.args)
        self.assertEqual(result['state'], 'failed-confirmed')
        self.assertEqual(result['plan_sha256'], f.args.expected_plan_sha256)
        self.assertEqual(cas.call_args.kwargs['retained_records'], f.observation['retained_history']['retained_records'])
        self.assertEqual(cas.call_args.kwargs['retained_attempts'], f.observation['development_attempts'])


if __name__ == '__main__':
    unittest.main()
