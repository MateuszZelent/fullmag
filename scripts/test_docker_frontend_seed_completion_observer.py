"""Metadata-only failed-seed observer regressions; no live Docker calls."""
import copy
from contextlib import ExitStack
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest import mock
sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_volume_frontend_refresh_reconcile as completion
from docker_build_control import BuildControlError


def seed_mode():
    return {'schema': 'fullmag.docker-frontend-failed-seed-recovery.v1',
        'failed_attempt': 'b'*32, 'failed_config_sha256': 'c'*64,
        'prior_terminal_sha256': 'd'*64, 'prior_input_manifest_sha256': 'e'*64,
        'source_pins': {'backend_app_commit': '1'*40, 'input_manifest_commit': '1'*40,
            'controller_commit': '2'*40, 'seed_files_sha256': '3'*64, 'next_env_sha256': '4'*64,
            'backend_receipt_sha256': '5'*64, 'backend_provenance_sha256': '6'*64,
            'backend_binary_sha256': '7'*64, 'backend_container_id': 'd'*64,
            'backend_started_at': 'backend-start'}}


class SeedObserverTests(unittest.TestCase):
    def test_aggregate_source_failure_requires_explicit_seed_mode(self):
        source = Path('/selected')
        control = types.SimpleNamespace(project='own', volume='control')
        original = {'schema': 'fullmag.docker-build-operation.v1', 'phase': 'development',
            'state': 'outcome-unknown-resources-retained',
            'error': 'Recreated frontend source bind identity could not be proven',
            'attempt': 'a'*32, 'compose_project': 'own', 'control_volume': 'control',
            'helper_container': 'fullmag-control-'+'a'*32, 'state_root': '/state',
            'backend_volumes': {}, 'previous_frontend_volume': 'control',
            'inputs': {'source_root': str(source), 'native_build_requested': False,
                'frontend_refresh_from_attempt': 'b'*32,
                'frontend_refresh_from_config_sha256': 'c'*64,
                'failed_seed_new_generation': seed_mode()}}
        previous = {'state': 'failed-confirmed', 'attempt': 'b'*32, 'compose_project': 'own',
                    'state_root': '/state', 'backend_volumes': {}, 'frontend_volume': 'control'}
        document = {'name': 'own', 'services': {'backend': {'environment': {}}}}
        completion.validate_unknown(original, previous, document, control, source, 'a'*32, 'b'*32)
        for change in ('absent', 'wrong-schema', 'other-error'):
            invalid = copy.deepcopy(original)
            if change == 'absent': del invalid['inputs']['failed_seed_new_generation']
            elif change == 'wrong-schema': invalid['inputs']['failed_seed_new_generation']['schema'] = 'foreign'
            else: invalid['error'] = 'timeout'
            with self.subTest(change=change), self.assertRaises(BuildControlError):
                completion.validate_unknown(invalid, previous, document, control, source, 'a'*32, 'b'*32)

    def test_seed_source_witness_covers_root_and_only_declared_readonly_app_targets(self):
        source = Path('/selected')
        root = '/opt/fullmag/source'
        child = '/state/development/workspace/apps/control-room/scripts'
        document = {'services': {'frontend': {'volumes': [
            {'type': 'bind', 'source': str(source), 'target': root, 'read_only': True},
            {'type': 'bind', 'source': str(source / 'apps/control-room/scripts'),
             'target': child, 'read_only': True}]}}}
        witness = {root: {'files': ['proof']}, child: {'files': ['proof']}}
        completion.require_seed_source_witness(document, source, witness)
        for change in ('missing-root', 'foreign-target', 'writable', 'wrong-source'):
            doc, proof = copy.deepcopy(document), copy.deepcopy(witness)
            if change == 'missing-root': del proof[root]
            elif change == 'foreign-target': proof['/foreign'] = {'files': ['proof']}
            elif change == 'writable': doc['services']['frontend']['volumes'][1]['read_only'] = False
            else: doc['services']['frontend']['volumes'][1]['source'] = '/foreign'
            with self.subTest(change=change), self.assertRaises(BuildControlError):
                completion.require_seed_source_witness(doc, source, proof)

    def test_baseline_prefers_journal_and_never_falls_back_from_malformed_journal(self):
        control = object()
        raw = {}
        journal = 'development/attempts/' + 'a'*32 + '/backend-incarnation-baseline.json'
        operator = 'verification/frontend-seed-completion/' + 'a'*32 + '/operator-backend-baseline.json'
        record = {'kind': 'captured-under-lease'}
        def read(c, path, optional=False):
            return json.dumps(record).encode() if path == journal else b'{"kind":"operator-pinned-prior-observation"}'
        with mock.patch.object(completion, 'read_raw', side_effect=read):
            relative, value = completion.seed_baseline_document(control, raw, 'a'*32)
        self.assertEqual(relative, journal)
        self.assertEqual(value, record)
        self.assertNotIn(operator, raw)
        with mock.patch.object(completion, 'read_raw', return_value=b'broken'), self.assertRaises(BuildControlError):
            completion.seed_baseline_document(control, {}, 'a'*32)

    def test_missing_baseline_does_not_create_a_current_baseline(self):
        with mock.patch.object(completion, 'read_raw', return_value=None), self.assertRaises(BuildControlError):
            completion.seed_baseline_document(object(), {}, 'a'*32)


    def run_observer(self, *, seed=True, native_matches=True, seed_error=None):
        import docker_volume_dev as dev
        import docker_dev_codegen as codegen
        import docker_development_inputs as inputs_module
        import docker_backend_volume_cache as cache
        source = Path('/selected')
        attempt, base_attempt = 'a'*32, 'b'*32
        root, base = 'development/attempts/' + attempt, 'development/attempts/' + base_attempt
        control = types.SimpleNamespace(project='own', volume='control', _inspect_operation_helper=mock.Mock())
        original = {'schema': 'fullmag.docker-build-operation.v1', 'phase': 'development',
            'state': 'outcome-unknown-resources-retained', 'attempt': attempt,
            'error': 'Recreated frontend source bind identity could not be proven' if seed else completion.ERROR,
            'compose_project': 'own', 'control_volume': 'control',
            'helper_container': 'fullmag-control-'+attempt, 'state_root': '/state',
            'backend_volumes': {}, 'previous_frontend_volume': 'control',
            'inputs': {'source_root': str(source), 'native_build_requested': False,
                'frontend_refresh_from_attempt': base_attempt}}
        if seed:
            original['inputs']['failed_seed_new_generation'] = seed_mode()
        document = {'name': 'own', 'services': {
            'backend': {'environment': {}, 'image': 'backend-image'},
            'frontend': {'image': 'frontend-image', 'environment': {'FULLMAG_FRONTEND_HOST_PORT': '3243'},
                         'volumes': [{'type': 'bind', 'source': str(source),
                                      'target': '/opt/fullmag/source', 'read_only': True}]}},
            'volumes': {'frontend-build': {'name': 'control'}}}
        original['inputs']['frontend_refresh_from_config_sha256'] = completion.digest(completion.canonical(document))
        actual = {name: {'Id': char*64, 'Image': name+'-image', 'Config': {},
                  'HostConfig': {}, 'Mounts': [], 'State': {'Running': True, 'StartedAt': name+'-start',
                  'Health': {'Status': 'healthy'}}} for name, char in (('backend','d'),('frontend','e'),('lease','f'))}
        previous = {'state': 'failed-confirmed' if seed else 'succeeded', 'attempt': base_attempt,
            'compose_project': 'own', 'state_root': '/state', 'backend_volumes': {},
            'frontend_volume': 'control', 'frontend_container': '0'*64,
            'backend_container': actual['backend']['Id'], 'backend_started_at': 'backend-start'}
        package, provenance = {'package': True}, {'provenance': True}
        docs = {'active': attempt.encode(), root+'/receipt.json': completion.canonical(original),
            root+'/compose.json': completion.canonical(document), root+'/rollback-compose.json': completion.canonical(document),
            root+'/backend-cache.json': b'{}', root+'/frontend-seed.json': b'{}',
            root+'/backend-build-receipt.json': completion.canonical(package), root+'/provenance.json': completion.canonical(provenance),
            base+'/terminal.json': completion.canonical(previous),
            'development/current.json': completion.canonical({**previous, 'phase': 'development',
                'inputs': {'source_root': str(source)}}), 'frontend/development-inputs.json': b'{"files":[]}'}
        def text(*args):
            if args[0] == 'logs': return 'READY\nLOGGED\n'
            if args[:2] == ('image','inspect'): return '[{"Config":{}}]'
            values = {row['Id']: row for row in actual.values()}
            return json.dumps([actual['lease'] if args[1] == original['helper_container'] else values[args[1]]])
        with ExitStack() as stack:
            stack.enter_context(mock.patch.object(completion, 'read_raw', side_effect=lambda c,p,optional=False: docs.get(p)))
            authority = stack.enter_context(mock.patch.object(completion.seed_completion, 'validate_seed_authority', return_value={}))
            seed_evidence = stack.enter_context(mock.patch.object(completion, 'seed_completion_evidence',
                return_value={'selected_source_qualification': 'NOT VERIFIED'}, side_effect=seed_error))
            stack.enter_context(mock.patch.object(dev, 'compose_capture', side_effect=lambda d,*args: actual[args[-1]]['Id'].encode()))
            stack.enter_context(mock.patch.object(dev, 'docker_text', side_effect=text))
            stack.enter_context(mock.patch.object(dev, '_repin_frontend_daemon_binds',
                return_value=(document, {'/opt/fullmag/source': {'files': ['verified']}})))
            stack.enter_context(mock.patch.object(dev, '_validate_retained_service'))
            stack.enter_context(mock.patch.object(cache, 'validate_container'))
            stack.enter_context(mock.patch.object(dev, '_assert_private_restart_network'))
            stack.enter_context(mock.patch.object(codegen, '_backend_documents', return_value=(package,provenance,'c'*64,{})))
            stack.enter_context(mock.patch.object(codegen, '_validate_backend', return_value=({'commit':'1'*40},'2'*64,'3'*64)))
            probe = stack.enter_context(mock.patch.object(codegen, '_probe_source', return_value=({},None)))
            matches = stack.enter_context(mock.patch.object(codegen, '_source_matches', return_value=native_matches))
            stack.enter_context(mock.patch.object(inputs_module, 'describe', return_value={'files':[]}))
            stack.enter_context(mock.patch.object(inputs_module, 'frontend_view', return_value={'files':[]}))
            host = types.SimpleNamespace(OWNER_NAME='owner', HOST_CERT_PATH='/cert.json', read_owned_regular=lambda p: b'{"restart_verified":true}')
            stack.enter_context(mock.patch.object(dev, '_session_host', return_value=host))
            stack.enter_context(mock.patch.object(dev, '_retained_certificate'))
            stack.enter_context(mock.patch.object(dev, '_frontend_recovery_backend_observation', return_value={'active_session':False}))
            result = completion.observe(control, source, attempt, base_attempt, 3243)
            if seed:
                probe.assert_not_called(); matches.assert_not_called()
                authority.assert_called_once(); seed_evidence.assert_called_once()
            else:
                probe.assert_called_once(); matches.assert_called_once()
                authority.assert_not_called(); seed_evidence.assert_not_called()
            return result

    def test_failed_seed_observer_requires_its_own_authority_without_native_parity_claim(self):
        evidence, original, _ = self.run_observer(seed=True, native_matches=False)
        self.assertEqual(original['state'], 'outcome-unknown-resources-retained')
        self.assertEqual(evidence['seed_completion']['selected_source_qualification'], 'NOT VERIFIED')
        with self.assertRaisesRegex(BuildControlError, 'prior baseline changed'):
            self.run_observer(seed_error=BuildControlError('prior baseline changed'))

    def test_ordinary_completion_still_requires_exact_native_source_equality(self):
        evidence, _, _ = self.run_observer(seed=False)
        self.assertNotIn('seed_completion', evidence)
        with self.assertRaisesRegex(BuildControlError, 'Native source snapshot differs'):
            self.run_observer(seed=False, native_matches=False)



class SeedEvidenceTests(unittest.TestCase):
    def run_evidence(self, fault=None):
        import docker_volume_frontend_seed_recovery as seed_recovery
        seed = completion.seed_completion
        import docker_development_inputs as inputs_module
        attempt, base = 'a'*32, 'b'*32
        root = 'development/attempts/' + attempt
        api = {'active_session': False, 'api_instance_id': 'instance', 'session': None,
            'scene_revision': None, 'run_id': None,
            'processes': [{'pid': 10, 'start_ticks': '100', 'executable': '/bin/fullmag-api'}]}
        backend = {'Id': 'd'*64, 'Image': 'sha256:'+'e'*64, 'RestartCount': 0,
            'State': {'Status': 'running', 'Running': True, 'Pid': 123,
                      'StartedAt': 'backend-start', 'Health': {'Status': 'healthy'}}}
        baseline = seed.baseline_record(attempt, base, seed.capture_baseline(backend, api),
                                        'operator-pinned-prior-observation')
        relative = seed.baseline_relative(attempt)
        generation = 'private/frontend/generations/' + attempt
        frontend = {'Mounts': [{'Destination': '/state/development', 'Type': 'volume',
                               'Name': 'control', 'RW': True}],
            'HostConfig': {'Mounts': [{'Target': '/state/development', 'Type': 'volume',
                'Source': 'control', 'ReadOnly': False, 'VolumeOptions': {'Subpath': generation}}]}}
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp)
            file = source / 'apps/control-room/next-env.d.ts'; file.parent.mkdir(parents=True)
            file.write_bytes(b'exact seed')
            prior = {'schema': 'fullmag.docker-development-inputs.v1', 'source_commit': '1'*40,
                     'host_port': 3243, 'source_volume': {'host_device': 2128},
                     'configuration_changes': 'prepare_new_workspace',
                     'files': [{'relative': 'apps/control-room/next-env.d.ts',
                                'sha256': completion.digest(file.read_bytes())}]}
            published = {**prior, 'source_commit': '2'*40}
            captured = {**prior, 'source_commit': '3'*40}
            desired = {key:value for key,value in captured.items() if key != 'source_volume'}
            desired['configuration_changes'] = 'describe_only'
            package_pins = {key:value for key,value in seed_mode()['source_pins'].items()
                if key.startswith('backend_') or key == 'input_manifest_commit'}
            pins = seed_recovery.validate_seed_manifest(prior, published,
                backend_app_commit='1'*40, expected_backend_app_commit='1'*40,
                input_manifest_commit='1'*40, controller_commit='2'*40,
                selected_seed_bytes={'apps/control-room/next-env.d.ts': file.read_bytes()})
            pins.update(package_pins)
            prior_raw = completion.canonical(prior)
            original = {'state_root': '/state', 'frontend_generation_subpath': generation, 'inputs': {
                'failed_seed_new_generation': {**seed_mode(), 'source_pins': pins,
                    'prior_input_manifest_sha256': completion.digest(prior_raw)}}}
            raw = {root+'/backend-build-receipt.json': b'receipt', root+'/provenance.json': b'provenance'}
            documents = {root+'/rollback-development-inputs.json': prior_raw,
                'development/attempts/'+base+'/backend-build-receipt.json': b'receipt',
                'development/attempts/'+base+'/provenance.json': b'provenance',
                relative: completion.canonical(baseline)}
            if fault == 'prior-manifest': documents[root+'/rollback-development-inputs.json'] += b' '
            elif fault == 'package': documents['development/attempts/'+base+'/provenance.json'] = b'changed'
            elif fault == 'live-package': package_pins['backend_binary_sha256'] = '0'*64
            elif fault == 'frontend-seed': file.write_bytes(b'changed seed')
            elif fault == 'generation': frontend['HostConfig']['Mounts'][0]['VolumeOptions']['Subpath'] = 'foreign'
            elif fault == 'backend-pid': backend['State']['Pid'] += 1
            elif fault == 'api-instance': api['api_instance_id'] = 'changed'
            def capture(selected, state, port, *, write_file):
                self.assertEqual(port, 3243)
                write_file('apps/control-room/next-env.d.ts', file.read_bytes())
                return captured
            with mock.patch.object(inputs_module, 'seed', side_effect=capture), \
                 mock.patch.object(completion, 'read_raw', side_effect=lambda c,p,optional=False: documents.get(p)), \
                 mock.patch.object(seed, 'validate_seed_authority', return_value=pins), \
                 mock.patch.object(seed_recovery, 'authenticated_source_pins', return_value=package_pins):
                result = completion.seed_completion_evidence(
                    types.SimpleNamespace(volume='control'), raw, original, {}, {}, {},
                    {'backend': backend, 'frontend': frontend}, source, attempt, base, published, desired, api)
            self.assertEqual(result['baseline']['kind'], 'operator-pinned-prior-observation')
            self.assertEqual(result['selected_source_qualification'], 'NOT VERIFIED')
            self.assertEqual(result['frontend_input_commit'], '2'*40)
            self.assertEqual(result['selected_source_commit'], '3'*40)
            self.assertIn(relative, raw)
            self.assertIsNone(raw[root+'/backend-incarnation-baseline.json'])
            return result

    def test_complete_seed_evidence_preserves_three_commit_roles_and_prior_baseline(self):
        self.run_evidence()

    def test_seed_evidence_refuses_manifest_package_generation_and_incarnation_drift(self):
        for fault in ('prior-manifest', 'package', 'live-package', 'frontend-seed',
                      'generation', 'backend-pid', 'api-instance'):
            with self.subTest(fault=fault), self.assertRaises(BuildControlError):
                self.run_evidence(fault)


if __name__ == '__main__':
    unittest.main()
