"""Docker-free checks for original-evidence abrupt stop recovery."""
from __future__ import annotations
import ast
import copy
import inspect
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_volume_container_recovery as r


def _typed_foreign_alias_proof(alias, container_id):
    alias_sha = hashlib.sha256(alias.encode()).hexdigest()
    kernel = {
        "schema": "fullmag.docker-bind-overlap-proof.v1",
        "decision": "disjoint",
        "probe_schema": "fullmag.docker-bind-overlap-probe.v1",
        "candidate_alias_sha256": alias_sha,
        "reference_root_sha256": "a" * 64,
        "reference_marker_sha256": "b" * 64,
        "reference_marker_size": 10,
        "reference_marker_stat": {},
        "reference_stat": {},
        "reference_mount": {},
        "candidate_mounts": [],
        "candidate_stat": {},
        "mountinfo_sha256": "c" * 64,
    }
    return {
        "schema": "fullmag.foreign-bind-disjoint-proof.v1",
        "decision": "disjoint",
        "container_id": container_id,
        "image_id": "sha256:" + "d" * 64,
        "started_at": "2026-10-27T10:00:00Z",
        "status": "running",
        "running": True,
        "pid": 234,
        "inspection_sha256": "e" * 64,
        "candidate_alias_sha256": alias_sha,
        "reference_root_sha256": "a" * 64,
        "kernel_proof": kernel,
    }


class AbruptStopTests(unittest.TestCase):
    def fixture(self):
        project = 'fullmag-master'
        owner = {'schema_version': 'runtime_service_owner.v1', 'state': 'ready',
                 'owner_token': 'old-token', 'process_start_token': 'old-start',
                 'target_id': 'docker-all', 'host': 'old-backend', 'protocol': 'tcp',
                 'pid': 10, 'children': [{'role': 'compute', 'pid': 11}, {'role': 'preparation', 'pid': 12}]}
        originals = {'process_receipt': {'schema': 'fullmag.docker-process-tree.v1', 'state': 'ready', 'service_owner': owner},
                     'owner': owner, 'launch': {'original': 'launch'}, 'config': {'store_root': '/state/runs/docker-all/session-store'}}
        records = {}
        for key, path in {'process_receipt': 'runtime-service/process-tree.json', 'owner': 'runtime-services/OWNER.json',
                          'launch': 'runtime-services/LAUNCH.json', 'config': 'runtime-service/docker-all.json'}.items():
            # Intentionally retain noncanonical formatting.
            raw = (json.dumps(originals[key], indent=3) + '\n').encode()
            records[key] = {'path': 'runtime-control/' + path, 'raw_utf8': raw.decode(), 'sha256': r._sha256(raw)}
        compose = {'name': project}
        pins = {'request_id': '1eccf696-733d-4506-bbd7-9fd79ea602fa', 'source_root': '/selected/source',
                'compose_project': project, 'development_attempt': 'a'*32, 'compose_config_sha256': r._sha256(r._canonical(compose)),
                'backend_container_id': 'b'*64, 'frontend_container_id': 'c'*64, 'old_image_id': 'sha256:'+'d'*64,
                **{key+'_sha256': item['sha256'] for key,item in records.items()}}
        containers = {}
        for service in ('backend', 'frontend'):
            containers[service] = {'Id': pins[service+'_container_id'], 'Image': pins['old_image_id'],
                'Config': {'Hostname': 'old-backend' if service=='backend' else 'old-frontend', 'Labels': {
                    'com.docker.compose.project': project, 'com.docker.compose.service': service}},
                'HostConfig': {'PidMode': '', 'IpcMode': 'private', 'NetworkMode': 'fullmag-master_fullmag'},
                'NetworkSettings': {'Networks': {'fullmag-master_fullmag': {'NetworkID': 'e'*64}}},
                'Mounts': [{'Type': 'bind', 'Source': '/state/source', 'Destination': '/state', 'RW': True}],
                'State': {'Status': 'exited', 'Running': False, 'Paused': False, 'Restarting': False,
                          'Pid': 0, 'ExitCode': 255, 'StartedAt': '2026-10-26T00:00:00Z', 'FinishedAt': '2026-10-27T00:00:00Z'}}
        proof = {'schema': r.ABRUPT_PROOF_SCHEMA, 'authorization_pins': pins,
                 'docker_engine_id_sha256': 'f'*64, 'raw_records': records, 'containers': containers,
                 'network': {'name': 'fullmag-master_fullmag', 'network_id': 'e'*64, 'state': 'absent'},
                 'storage_proof': {'run_records': []}, 'retained_terminal_runs': None}
        auth = r.validate_operator_authorization({**pins, 'schema_version': r.ABRUPT_OPERATOR_SCHEMA,
            'abrupt_stop_proof': 'verification/abrupt-proof.json', 'abrupt_stop_proof_sha256': r._sha256(r._canonical(proof))})
        return proof, auth, compose

    def test_v2_frozen_fields_and_original_ready_bytes(self):
        proof, auth, _ = self.fixture()
        r.validate_abrupt_stop_proof(proof, auth)
        self.assertEqual(proof['raw_records']['process_receipt']['raw_utf8'][-1], '\n')
        with self.assertRaises(r.ContainerRecoveryError):
            r.validate_operator_authorization({**auth, 'prior_stop_journal': 'fake.json'})
        stale = copy.deepcopy(proof)
        stale['raw_records']['owner']['raw_utf8'] += ' '
        with self.assertRaisesRegex(r.ContainerRecoveryError, 'bytes'):
            r.validate_abrupt_stop_proof(stale, auth)

    def test_v2_abrupt_proof_freezes_v4_held_pins_and_preserves_v1_shape(self):
        proof, _, _=self.fixture()
        held={'run_id':'held-run','run_intent_sha256':'a'*64,'run_catalog_sha256':'b'*64,'start_release':'absent'}
        v2=copy.deepcopy(proof)
        v2['schema']=r.ABRUPT_PROOF_HELD_MANUAL_SCHEMA
        v2['retained_terminal_runs']=[]
        v2['retained_held_manual_runs']=[held]
        v2['storage_proof']['run_records']=[held]
        auth=r.validate_operator_authorization({
            **v2['authorization_pins'],'schema_version':r.ABRUPT_OPERATOR_SCHEMA,
            'abrupt_stop_proof':'verification/v4-proof.json',
            'abrupt_stop_proof_sha256':r._sha256(r._canonical(v2)),
        })
        r.validate_abrupt_stop_proof(v2,auth)
        request={'schema_version':r.HELD_MANUAL_REQUEST_SCHEMA,
                 'retained_terminal_runs':[],'retained_held_manual_runs':[held]}
        r._assert_request_matches_abrupt_retained_pins(request,v2)
        with self.assertRaisesRegex(r.ContainerRecoveryError,'held-manual pins'):
            r._assert_request_matches_abrupt_retained_pins({**request,'retained_held_manual_runs':[]},v2)
        with self.assertRaisesRegex(r.ContainerRecoveryError,'frozen schema'):
            r.validate_abrupt_stop_proof({**proof,'retained_held_manual_runs':[held]},self.fixture()[1])
        with self.assertRaisesRegex(r.ContainerRecoveryError,'both v4'):
            r.validate_abrupt_stop_proof({**v2,'retained_held_manual_runs':None},auth)

    def test_v4_absence_attestation_is_bound_to_request_digest(self):
        pin={'container_id':'1'*64,'image_id':'sha256:'+'2'*64,'config_sha256':'3'*64,'service':'backend'}
        request={'schema_version':r.HELD_MANUAL_REQUEST_SCHEMA,'retained_terminal_runs':[],
                 'retained_held_manual_runs':[{'run_id':'held-run','run_intent_sha256':'4'*64,
                                               'run_catalog_sha256':'5'*64,'start_release':'absent'}],
                 'docker_engine_id_sha256':'6'*64,'docker_manifest_sha256':'7'*64,
                 'device_release_resource_id':'resource','device_release_mapping_sha256':'8'*64,
                 'containers':[pin]}
        request_sha='9'*64
        attestation={'schema_version':r.ABSENCE_ATTESTATION_SCHEMA,'request_sha256':request_sha,
                     'docker_engine_id_sha256':request['docker_engine_id_sha256'],
                     'manifest_sha256':request['docker_manifest_sha256'],
                     'result':'authoritative_namespace_absence',
                     'containers':[{'container_id':pin['container_id'],'image_id':pin['image_id'],
                         'config_sha256':pin['config_sha256'],'service':pin['service'],
                         'absence':{'inspect':{'outcome':'no_such_object','matched_container_id':pin['container_id'],'output_sha256':'a'*64},
                                    'ps_all':{'outcome':'empty','output_sha256':'b'*64}}}],
                     'device_release':{'resource_id':'resource','mapping_sha256':'8'*64,'mapping_detached':True}}
        with patch.object(r,'validate_request',side_effect=lambda value:dict(value)):
            r.validate_attestation(attestation,request,request_sha)
            with self.assertRaisesRegex(r.ContainerRecoveryError,'digest differs'):
                r.validate_attestation(attestation,request,'c'*64)

    def test_v1_still_requires_shutdown_unknown_process_receipt(self):
        raw=b'{"schema":"fullmag.docker-process-tree.v1","state":"ready"}'
        with patch.object(r,'_control_json',return_value=(json.loads(raw),raw)):
            with self.assertRaisesRegex(r.ContainerRecoveryError,'shutdown_unknown'):
                r._runtime_process_receipt(SimpleNamespace())
            self.assertEqual(r._runtime_process_receipt(SimpleNamespace(),abrupt=True)[1],raw)

    def test_strict_stopped_rejects_boolean_ints_running_and_shared_namespaces(self):
        proof, _, _ = self.fixture()
        original = proof['containers']['backend']
        for field, value in [('Running', True), ('Running', None), ('Pid', False), ('ExitCode', True),
                             ('Restarting', True), ('Paused', True), ('Status', 'created'), ('FinishedAt', '0001-01-01T00:00:00Z')]:
            with self.subTest(field=field, value=value):
                item = copy.deepcopy(original); item['State'][field] = value
                with self.assertRaises(r.ContainerRecoveryError): r._strict_stopped(item)
        for field,value in [('PidMode','host'), ('IpcMode','shareable'), ('NetworkMode','host')]:
            item=copy.deepcopy(original); item['HostConfig'][field]=value
            with self.assertRaises(r.ContainerRecoveryError): r._strict_stopped(item)

    def test_network_absence_requires_inventory_and_recognized_inspect_failure(self):
        proof, _, _ = self.fixture(); b,f=proof['containers'].values()
        empty=SimpleNamespace(returncode=0, stdout=b'', stderr=b'')
        missing=SimpleNamespace(returncode=1, stdout=b'', stderr=b'Error: No such network: '+b'e'*64)
        with patch.object(r,'docker_capture',side_effect=[empty, missing, empty]) as docker:
            self.assertEqual(r._abrupt_network(b,f,'fullmag-master')['state'],'absent')
            self.assertEqual(docker.call_count,3)
        failed=SimpleNamespace(returncode=1, stdout=b'', stderr=b'Cannot connect to Docker daemon')
        with patch.object(r,'docker_capture',side_effect=[empty,failed]):
            with self.assertRaisesRegex(r.ContainerRecoveryError,'absence'): r._abrupt_network(b,f,'fullmag-master')
        with patch.object(r,'docker_capture',side_effect=r.BuildControlError('daemon unavailable')):
            with self.assertRaises(r.BuildControlError): r._abrupt_network(b,f,'fullmag-master')

    def test_network_name_reuse_and_foreign_consumers_fail_closed(self):
        proof,_,_=self.fixture(); b,f=proof['containers'].values()
        reused=SimpleNamespace(returncode=0,stdout=json.dumps({'Name':'fullmag-master_fullmag','ID':'a'*64}).encode())
        with patch.object(r,'docker_capture',return_value=reused):
            with self.assertRaisesRegex(r.ContainerRecoveryError,'changed'): r._abrupt_network(b,f,'fullmag-master')
        foreign={'Id':'a'*64,'Mounts':b['Mounts']}
        with patch.object(r,'docker_capture',side_effect=[SimpleNamespace(stdout=('a'*64).encode()), SimpleNamespace(stdout=json.dumps([foreign]).encode())]):
            with self.assertRaisesRegex(r.ContainerRecoveryError,'foreign'): r._assert_no_foreign_storage_consumers(SimpleNamespace(),b,f)

    def test_only_exact_authenticated_operation_helper_is_exempt(self):
        proof,_,_=self.fixture(); b,f=proof['containers'].values()
        helper='1'*64; lookalike='2'*64; operation={}
        authenticated=[]
        control=SimpleNamespace(_active_operation=operation,_pin_operation_helper=lambda current: authenticated.append(current) or helper)
        with patch.object(r,'docker_capture',return_value=SimpleNamespace(stdout=helper.encode())) as docker:
            r._assert_no_foreign_storage_consumers(control,b,f)
        self.assertEqual(authenticated,[operation]); self.assertEqual(docker.call_count,1)
        foreign={'Id':lookalike,'Config':{'Labels':{'com.docker.compose.service':'build-control'}},'Mounts':b['Mounts']}
        with patch.object(r,'docker_capture',side_effect=[SimpleNamespace(stdout=(helper+' '+lookalike).encode()),SimpleNamespace(stdout=json.dumps([foreign]).encode())]):
            with self.assertRaisesRegex(r.ContainerRecoveryError,'foreign'):
                r._assert_no_foreign_storage_consumers(control,b,f)
        control._pin_operation_helper=lambda current: (_ for _ in ()).throw(r.BuildControlError('helper config drift'))
        with patch.object(r,'docker_capture',return_value=SimpleNamespace(stdout=helper.encode())):
            with self.assertRaisesRegex(r.BuildControlError,'config drift'):
                r._assert_no_foreign_storage_consumers(control,b,f)

    def test_foreign_desktop_alias_is_not_assumed_distinct_from_same_store(self):
        proof,_,compose=self.fixture(); b,f=proof['containers'].values()
        prefix='/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu2/'
        b['Mounts'][0]['Source']=prefix+'hashA'
        compose['services']={'backend':{'volumes':[{'type':'bind','source':'/canonical/state','target':'/state'}]}}
        for alias in ('hashA','hashB','unknown'):
            foreign={'Id':'a'*64,'Mounts':[{'Type':'bind','Source':prefix+alias,'Destination':'/state','RW':True}]}
            with self.subTest(alias=alias),patch.object(r,'docker_capture',side_effect=[SimpleNamespace(stdout=('a'*64).encode()),SimpleNamespace(stdout=json.dumps([foreign]).encode())]):
                with self.assertRaisesRegex(r.ContainerRecoveryError,'foreign Docker container references|unresolved storage identity'):
                    r._assert_no_foreign_storage_consumers(SimpleNamespace(),b,f,compose)

    def test_desktop_drive_paths_do_not_bypass_abrupt_consumer_fence(self):
        proof, _, compose = self.fixture()
        backend, frontend = proof['containers'].values()
        control = SimpleNamespace(project=compose['name'])
        for source in ('/run/desktop/mnt/host/c/work', '/run/desktop/mnt/host/e/storage',
                       '/host_mnt/c/work', '/mnt/host/e/storage', '/run/desktop/mnt/host',
                       '//host_mnt/c/work', '//run/desktop/mnt/host/c/work'):
            foreign = {'Id': 'a' * 64, 'Mounts': [{'Type': 'bind', 'Source': source,
                       'Destination': '/data', 'RW': True}]}
            with self.subTest(source=source), \
                 patch.object(r, 'docker_capture', side_effect=[
                     SimpleNamespace(stdout=('a' * 64).encode()),
                     SimpleNamespace(stdout=json.dumps([foreign]).encode())]), \
                 patch.object(r, '_retained_compose_state_root',
                              return_value=Path('/retained/state')) as retained_root, \
                 patch('docker_windows_bind_isolation.prove_windows_bind_disjoint',
                       side_effect=ValueError('physical identity unresolved')) as present_proof, \
                 patch('docker_windows_absent_bind_isolation.prove_absent_stopped_windows_bind',
                       side_effect=ValueError('no positive absence proof')) as absent_proof:
                with self.assertRaisesRegex(r.ContainerRecoveryError, 'Windows.*unresolved|unsafe'):
                    r._assert_no_foreign_storage_consumers(control, backend, frontend, compose)
            if source.startswith('//'):
                retained_root.assert_not_called()
                present_proof.assert_not_called()
                absent_proof.assert_not_called()
            else:
                retained_root.assert_called_once_with(backend, compose, project=compose['name'])
                present_proof.assert_called_once_with(
                    control, backend, foreign, source, Path('/retained/state'))
                absent_proof.assert_called_once_with(
                    control, backend, foreign, source, Path('/retained/state'))

    def test_unknown_foreign_alias_uses_only_exact_disjoint_proof_and_keeps_other_guards(self):
        proof, _, compose = self.fixture()
        backend, frontend = proof['containers'].values()
        prefix = '/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu2/'
        backend['Mounts'][0]['Source'] = prefix + 'master-state'
        compose['services'] = {'backend': {'volumes': [
            {'type': 'bind', 'source': '/canonical/state', 'target': '/state'}],
            'x-fullmag-daemon-binds': {'/state': prefix + 'master-state'}}}
        alias = prefix + 'unknown-mongo-config'
        foreign = {'Id': 'a' * 64, 'Mounts': [
            {'Type': 'bind', 'Source': alias, 'Destination': '/etc/mongo.conf', 'RW': False}]}
        responses = [SimpleNamespace(stdout=foreign['Id'].encode()),
                     SimpleNamespace(stdout=json.dumps([foreign]).encode())]
        called = []
        with patch.object(r, 'docker_capture', side_effect=responses), \
             patch('docker_foreign_bind_identity.canonical_bind_sources',
                   side_effect=r.BuildControlError('not a registered Fullmag group')):
            r._assert_no_foreign_storage_consumers(
                SimpleNamespace(), backend, frontend, compose,
                prove_foreign_disjoint=lambda item, source: called.append((item, source)) or
                    _typed_foreign_alias_proof(source, item['Id']))
        self.assertEqual(called, [(foreign, alias)])

        incomplete = {'Id': foreign['Id']}
        with patch.object(r, 'docker_capture', side_effect=[
                SimpleNamespace(stdout=foreign['Id'].encode()),
                SimpleNamespace(stdout=json.dumps([incomplete]).encode())]), \
             patch('docker_foreign_bind_identity.canonical_bind_sources',
                   side_effect=r.BuildControlError('not registered')):
            with self.assertRaisesRegex(r.ContainerRecoveryError, 'no complete mount inventory'):
                r._assert_no_foreign_storage_consumers(
                    SimpleNamespace(), backend, frontend, compose,
                    prove_foreign_disjoint=lambda *_args: self.fail(
                        'incomplete consumer inventory must not use the fallback'))

        bad = _typed_foreign_alias_proof(alias, foreign['Id'])
        bad['decision'] = 'overlap'
        with patch.object(r, 'docker_capture', side_effect=[
                SimpleNamespace(stdout=foreign['Id'].encode()),
                SimpleNamespace(stdout=json.dumps([foreign]).encode())]), \
             patch('docker_foreign_bind_identity.canonical_bind_sources',
                   side_effect=r.BuildControlError('not registered')):
            with self.assertRaisesRegex(r.ContainerRecoveryError, 'unresolved storage identity'):
                r._assert_no_foreign_storage_consumers(
                    SimpleNamespace(), backend, frontend, compose,
                    prove_foreign_disjoint=lambda *_args: bad)

        foreign_with_ledger = copy.deepcopy(foreign)
        backend['Mounts'].extend([
            {'Type': 'volume', 'Name': 'control-vol', 'Source': '/control',
             'Destination': '/opt/fullmag/control'},
            {'Type': 'volume', 'Name': 'ledger-vol', 'Source': '/ledger',
             'Destination': '/host-ledger'},
        ])
        foreign_with_ledger['Mounts'].append(
            {'Type': 'volume', 'Name': 'ledger-vol', 'Destination': '/ledger'})
        with patch.object(r, 'docker_capture', side_effect=[
                SimpleNamespace(stdout=foreign['Id'].encode()),
                SimpleNamespace(stdout=json.dumps([foreign_with_ledger]).encode())]), \
             patch('docker_foreign_bind_identity.canonical_bind_sources',
                   side_effect=r.BuildControlError('not registered')):
            with self.assertRaisesRegex(r.ContainerRecoveryError, 'control/ledger'):
                r._assert_no_foreign_storage_consumers(
                    SimpleNamespace(), backend, frontend, compose,
                    prove_foreign_disjoint=lambda item, source: _typed_foreign_alias_proof(
                        source, item['Id']))

    def test_wrapper_publish_runs_real_consumer_gate_with_authenticated_lease(self):
        import contextlib
        import docker_prepare_container_recovery as preparation
        proof,auth,compose=self.fixture(); pins=proof['authorization_pins']
        docs={item['path']:item['raw_utf8'].encode() for item in proof['raw_records'].values()}
        authenticated=[]; active_helper='1'*64
        @contextlib.contextmanager
        def operation(*args):
            op={'receipt':{'attempt':'operation-attempt'},'root':'operations/fake'}
            control._active_operation=op
            try: yield op
            finally: control._active_operation=None
        def pin(op):
            self.assertIs(control._active_operation,op)
            authenticated.append(op)
            return active_helper
        control=SimpleNamespace(project=compose['name'],_active_operation=None,_pin_operation_helper=pin,
            prepare=lambda:None,operation=operation,read_bytes=lambda path,optional=False:docs.get(path),
            write_bytes=lambda path,raw:docs.update({path:raw}))
        calls=[]
        def docker(*args,**kwargs):
            self.assertEqual(args,('ps','-aq','--no-trunc'))
            calls.append(args)
            return SimpleNamespace(stdout=active_helper.encode() if control._active_operation else b'')
        with patch.object(r,'_control_bytes',side_effect=lambda c,p:docs[p]),patch.object(r,'_control_json',side_effect=lambda c,p:(json.loads(docs[p]),docs[p])),patch.object(r,'_inspect_pair',return_value=tuple(proof['containers'].values())),patch.object(r,'_ledger_and_store_snapshot',return_value=proof['storage_proof']),patch.object(r,'_docker_engine_sha',return_value='f'*64),patch.object(r,'_abrupt_network',return_value=proof['network']),patch.object(r,'docker_capture',side_effect=docker):
            result=preparation.prepare(control,pins,compose,publish=True)
        self.assertEqual(result['state'],'prepared-awaiting-explicit-start')
        self.assertEqual(len(calls),3)
        self.assertEqual(len(authenticated),2)
        self.assertIn(result['proof_path'],docs)

    def test_live_cas_rejects_raw_engine_and_container_drift(self):
        proof,auth,compose=self.fixture()
        records={item['path']:item['raw_utf8'].encode() for item in proof['raw_records'].values()}
        with patch.object(r,'_control_bytes',side_effect=lambda c,p: records[p]+b' '):
            with self.assertRaisesRegex(r.ContainerRecoveryError,'stale'): r.validate_abrupt_stop_proof(proof,auth,control=SimpleNamespace(),compose=compose)
        with patch.object(r,'_control_bytes',side_effect=lambda c,p: records[p]), patch.object(r,'_docker_engine_sha',return_value='a'*64):
            with self.assertRaisesRegex(r.ContainerRecoveryError,'engine'): r.validate_abrupt_stop_proof(proof,auth,control=SimpleNamespace(),compose=compose)
        drift=copy.deepcopy(proof['containers']); drift['backend']['State']['ExitCode']=1
        with patch.object(r,'_control_bytes',side_effect=lambda c,p: records[p]), patch.object(r,'_docker_engine_sha',return_value='f'*64), patch.object(r,'_inspect_pair',return_value=tuple(drift.values())):
            with self.assertRaisesRegex(r.ContainerRecoveryError,'observations'): r.validate_abrupt_stop_proof(proof,auth,control=SimpleNamespace(project=compose['name']),compose=compose)

    def test_mount_order_is_not_drift_but_every_mount_field_is_pinned(self):
        proof, auth, compose = self.fixture()
        records = {item['path']: item['raw_utf8'].encode() for item in proof['raw_records'].values()}
        for item in proof['containers'].values():
            item['Mounts'].append({'Type': 'volume', 'Name': 'cache', 'Destination': '/build',
                                  'RW': True, 'Options': {'subpath': 'private'}})
        current = copy.deepcopy(proof['containers'])
        for item in current.values():
            item['Mounts'].reverse()
        original = copy.deepcopy(proof)
        control = SimpleNamespace(project=compose['name'])
        with patch.object(r, '_control_bytes', side_effect=lambda c, p: records[p]), \
             patch.object(r, '_docker_engine_sha', return_value='f'*64), \
             patch.object(r, '_inspect_pair', return_value=tuple(current.values())), \
             patch.object(r, '_abrupt_network', return_value=proof['network']), \
             patch.object(r, '_assert_no_foreign_storage_consumers'), \
             patch.object(r, '_ledger_and_store_snapshot', return_value=proof['storage_proof']):
            r.validate_abrupt_stop_proof(proof, auth, control=control, compose=compose)
            transition = {**current, 'present': current}
            r.validate_abrupt_stop_proof(proof, auth, control=control, compose=compose, transition=transition)
            self.assertEqual(proof, original)  # Never rewrite archived evidence.
            for key, changed in [('Name', 'other-cache'), ('RW', False), ('Options', {'subpath': 'foreign'})]:
                mount = current['backend']['Mounts'][0]
                old = mount[key]
                mount[key] = changed
                with self.subTest(key=key), self.assertRaisesRegex(r.ContainerRecoveryError, 'observations'):
                    r.validate_abrupt_stop_proof(proof, auth, control=control, compose=compose)
                mount[key] = old
            current['backend']['Mounts'][1]['Source'] = '/other/store'
            with self.assertRaisesRegex(r.ContainerRecoveryError, 'observations'):
                r.validate_abrupt_stop_proof(proof, auth, control=control, compose=compose)

    def test_mount_inventory_must_have_unique_nonempty_destinations(self):
        proof, _, _ = self.fixture()
        original = proof['containers']['backend']
        for extra in [dict(original['Mounts'][0]), {}, {'Destination': ''}, {'Destination': 3}, None]:
            value = copy.deepcopy(original)
            value['Mounts'].append(extra)
            with self.subTest(extra=extra), self.assertRaises(r.ContainerRecoveryError):
                r._stable_container_observation(value)

    def test_retained_state_root_accepts_only_explicit_matching_worktree(self):
        proof, _, _ = self.fixture()
        backend = copy.deepcopy(proof['containers']['backend'])
        project = 'fullmag-worktree-selected'
        backend['Config']['Labels']['com.docker.compose.project'] = project
        with tempfile.TemporaryDirectory() as directory:
            state = str(Path(directory).resolve())
            backend['Mounts'][0]['Source'] = '/daemon/state-alias'
            compose = {'name': project, 'services': {'backend': {
                'volumes': [{'type': 'bind', 'source': state, 'target': '/state'}],
                'x-fullmag-daemon-binds': {'/state': '/daemon/state-alias'}}}}
            image = {'Id': backend['Image'], 'Config': {}}
            with patch.object(r, 'docker_capture', return_value=SimpleNamespace(stdout=json.dumps([image]).encode())), \
                 patch('docker_volume_dev._validate_retained_service') as validate:
                self.assertEqual(r._retained_compose_state_root(backend, compose, project=project), Path(state))
                validate.assert_called_once()
                with self.assertRaisesRegex(r.ContainerRecoveryError, 'selected Compose identity'):
                    r._retained_compose_state_root(backend, compose)
                backend['Config']['Labels']['com.docker.compose.project'] = 'foreign'
                with self.assertRaisesRegex(r.ContainerRecoveryError, 'selected Compose identity'):
                    r._retained_compose_state_root(backend, compose, project=project)
                self.assertEqual(validate.call_count, 1)

    def test_windows_raw_protected_overlap_precedes_qualified_proof(self):
        proof, _, compose = self.fixture()
        backend, frontend = proof['containers'].values()
        backend['Mounts'][0]['Source'] = r'D:\retained\state'
        for source in (r'd:\RETAINED\state', r'D:\retained\state\runs', r'D:\retained'):
            foreign = {'Id': 'a'*64, 'Mounts': [
                {'Type': 'bind', 'Source': source, 'Destination': '/data', 'RW': True}]}
            with self.subTest(source=source), patch.object(r, 'docker_capture', side_effect=[
                    SimpleNamespace(stdout=foreign['Id'].encode()),
                    SimpleNamespace(stdout=json.dumps([foreign]).encode())]), \
                 patch('docker_windows_bind_isolation.prove_windows_bind_disjoint') as prove:
                with self.assertRaisesRegex(r.ContainerRecoveryError, 'control/ledger'):
                    r._assert_no_foreign_storage_consumers(
                        SimpleNamespace(project=compose['name']), backend, frontend, compose)
                prove.assert_not_called()

    def test_windows_bind_dispatch_requires_qualified_proof_and_keeps_volume_guard(self):
        proof, _, compose = self.fixture()
        backend, frontend = proof['containers'].values()
        foreign = {'Id': 'a'*64, 'Mounts': [
            {'Type': 'bind', 'Source': r'D:\foreign\storage', 'Destination': '/storage', 'RW': True}]}
        def responses():
            return [SimpleNamespace(stdout=foreign['Id'].encode()),
                    SimpleNamespace(stdout=json.dumps([foreign]).encode())]
        with patch.object(r, 'docker_capture', side_effect=responses()), \
             patch.object(r, '_retained_compose_state_root', return_value=Path('/retained/state')), \
             patch('docker_windows_bind_isolation.prove_windows_bind_disjoint', return_value={'typed': 'proof'}) as prove, \
             patch('docker_windows_bind_isolation.validate_windows_bind_disjoint_proof') as validate:
            r._assert_no_foreign_storage_consumers(SimpleNamespace(project=compose['name']), backend, frontend, compose)
            self.assertEqual(prove.call_args.args[3:], (r'D:\foreign\storage', Path('/retained/state')))
            validate.assert_called_once_with({'typed': 'proof'}, source=r'D:\foreign\storage', container_id=foreign['Id'])
        with patch.object(r, 'docker_capture', side_effect=responses()), \
             patch.object(r, '_retained_compose_state_root', return_value=Path('/retained/state')), \
             patch('docker_windows_bind_isolation.prove_windows_bind_disjoint', side_effect=ValueError('physical overlap')):
            with self.assertRaisesRegex(r.ContainerRecoveryError, 'unresolved storage identity.*physical overlap'):
                r._assert_no_foreign_storage_consumers(SimpleNamespace(project=compose['name']), backend, frontend, compose)
        backend['Mounts'].append({'Type': 'volume', 'Name': 'control-vol', 'Destination': r.CONTROL_ROOT})
        foreign['Mounts'].append({'Type': 'volume', 'Name': 'control-vol', 'Destination': '/foreign-control'})
        with patch.object(r, 'docker_capture', side_effect=responses()), \
             patch.object(r, '_retained_compose_state_root', return_value=Path('/retained/state')), \
             patch('docker_windows_bind_isolation.prove_windows_bind_disjoint', return_value={'typed': 'proof'}), \
             patch('docker_windows_bind_isolation.validate_windows_bind_disjoint_proof'):
            with self.assertRaisesRegex(r.ContainerRecoveryError, 'control/ledger'):
                r._assert_no_foreign_storage_consumers(SimpleNamespace(project=compose['name']), backend, frontend, compose)

    def test_owner_host_and_identity_cannot_be_fabricated(self):
        proof,auth,_=self.fixture()
        for key in ('host','owner_token'):
            modified=copy.deepcopy(proof)
            owner=json.loads(modified['raw_records']['owner']['raw_utf8']); owner[key]='foreign'
            raw=r._canonical(owner); modified['raw_records']['owner'].update(raw_utf8=raw.decode(),sha256=r._sha256(raw))
            changed_auth={**auth,'owner_sha256':r._sha256(raw)}
            modified['authorization_pins']['owner_sha256']=r._sha256(raw)
            with self.assertRaises(r.ContainerRecoveryError): r.validate_abrupt_stop_proof(modified,changed_auth)

    def test_prepare_archives_originals_without_control_writes(self):
        proof,_,compose=self.fixture(); pins=proof['authorization_pins']; c=SimpleNamespace(project=compose['name'])
        paths={item['path']:item['raw_utf8'].encode() for item in proof['raw_records'].values()}
        with patch.object(r,'_control_json',side_effect=lambda c,p: (json.loads(paths[p]),paths[p])), patch.object(r,'_inspect_pair',return_value=tuple(proof['containers'].values())), patch.object(r,'_assert_no_foreign_storage_consumers'), patch.object(r,'_ledger_and_store_snapshot',return_value=proof['storage_proof']), patch.object(r,'_docker_engine_sha',return_value='f'*64), patch.object(r,'_abrupt_network',return_value=proof['network']):
            observed=r.prepare_abrupt_stop_proof(c,pins,compose)
        self.assertEqual(observed,proof)

    def test_prepared_retry_cas_keeps_archived_observations(self):
        proof,auth,compose=self.fixture(); records={i['path']:i['raw_utf8'].encode() for i in proof['raw_records'].values()}
        transition={**proof['containers'],'present':{}}
        with patch.object(r,'_control_bytes',side_effect=lambda c,p:records[p]), patch.object(r,'_docker_engine_sha',return_value='f'*64), patch.object(r,'_abrupt_network'), patch.object(r,'_assert_no_foreign_storage_consumers'), patch.object(r,'_ledger_and_store_snapshot',return_value=proof['storage_proof']):
            r.validate_abrupt_stop_proof(proof,auth,control=SimpleNamespace(project=compose['name']),compose=compose,transition=transition)
            transition['backend']=copy.deepcopy(transition['backend']); transition['backend']['State']['ExitCode']=1
            with self.assertRaisesRegex(r.ContainerRecoveryError,'prepared retry'): r.validate_abrupt_stop_proof(proof,auth,control=SimpleNamespace(project=compose['name']),compose=compose,transition=transition)

    def test_history_publication_is_immutable(self):
        control=SimpleNamespace(write_bytes=lambda *a: self.fail('must not overwrite'))
        with patch.object(r,'_control_bytes',return_value=b'{"original":true}'):
            r._write_record(control,'proof.json',{'original':True})
            with self.assertRaisesRegex(r.ContainerRecoveryError,'history'): r._write_record(control,'proof.json',{'original':False})

    def test_terminal_pin_shape_outcome_and_v1_v2_isolation(self):
        pin={'run_id':'run-1','run_intent_sha256':'a'*64,'run_catalog_sha256':'b'*64,'artifact_catalog_sha256':None}
        request={'schema_version':r.TERMINAL_REQUEST_SCHEMA,'retained_terminal_runs':[pin]}
        self.assertEqual(r.expected_recovery_outcome(request),'retained_terminal_runs_recovered')
        for changed in [[],[pin,pin],[{**pin,'artifact_catalog_sha256':'bad'}],[{k:v for k,v in pin.items() if k!='artifact_catalog_sha256'}]]:
            with self.assertRaises(r.ContainerRecoveryError): r.expected_recovery_outcome({**request,'retained_terminal_runs':changed})
        for schema in (r.REQUEST_SCHEMA,r.RETAINED_REQUEST_SCHEMA):
            with self.assertRaises(r.ContainerRecoveryError): r.expected_recovery_outcome({**request,'schema_version':schema})
        held={'run_id':'run-held','run_intent_sha256':'c'*64,'run_catalog_sha256':'d'*64,'start_release':'absent'}
        with self.assertRaises(r.ContainerRecoveryError):
            r.expected_recovery_outcome({**request,'retained_held_manual_runs':[held]})
        with self.assertRaises(r.ContainerRecoveryError): r.expected_recovery_outcome({**request,'retained_cancelled_runs':[pin]})

    def test_held_manual_v4_pin_pairing_limits_and_version_isolation(self):
        terminal={'run_id':'run-terminal','run_intent_sha256':'a'*64,'run_catalog_sha256':'b'*64,'artifact_catalog_sha256':None}
        held={'run_id':'run-held','run_intent_sha256':'c'*64,'run_catalog_sha256':'d'*64,'start_release':'absent'}
        request={'schema_version':'runtime_service_container_recovery_request.v4',
                 'retained_terminal_runs':[],'retained_held_manual_runs':[held]}
        self.assertEqual(r.expected_recovery_outcome(request),'retained_manual_held_runs_recovered')
        self.assertEqual(r.expected_recovery_outcome({**request,'retained_terminal_runs':[terminal]}),
                         'retained_manual_held_runs_recovered')
        invalid=[
            {**request,'retained_held_manual_runs':[]},
            {**request,'retained_held_manual_runs':[{**held,'start_release':'present'}]},
            {**request,'retained_held_manual_runs':[{**held,'extra':True}]},
            {**request,'retained_held_manual_runs':[{**held,'run_catalog_sha256':'bad'}]},
            {**request,'retained_terminal_runs':[terminal],'retained_held_manual_runs':[{**held,'run_id':terminal['run_id']}]},
            {**request,'retained_cancelled_runs':[]},
            {**request,'schema_version':r.TERMINAL_REQUEST_SCHEMA,'retained_terminal_runs':[terminal]},
            {**request,'schema_version':r.TERMINAL_REQUEST_SCHEMA,'retained_terminal_runs':[terminal],'retained_held_manual_runs':None},
            {**request,'retained_terminal_runs':[terminal]*128},
        ]
        for changed in invalid:
            with self.subTest(changed=changed), self.assertRaises(r.ContainerRecoveryError):
                r.expected_recovery_outcome(changed)

    def test_snapshot_uses_only_pinned_canonical_state_for_stale_wsl_alias(self):
        proof,_,_=self.fixture(); backend=proof['containers']['backend']
        alias='/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu2/old'
        backend['Mounts']=[{'Type':'bind','Source':alias,'Destination':'/state','RW':True},
                           {'Type':'bind','Source':'/ledger/source','Destination':'/host-ledger','RW':True}]
        compose={'services':{'backend':{'volumes':[{'type':'bind','source':'/canonical/state','target':'/state'}],
                                            'x-fullmag-daemon-binds':{'/state':alias}}}}
        output={'store_root_sha256':'1'*64,'ledger_root_sha256':'2'*64,'ledger_snapshot_sha256':'3'*64,'run_records':[]}
        with patch.object(r,'bounded_capture',return_value=SimpleNamespace(returncode=0,stdout=json.dumps(output).encode(),stderr=b'')) as helper:
            r._ledger_and_store_snapshot(SimpleNamespace(project='fullmag-master'),backend,compose=compose)
            self.assertIn('type=bind,src=/canonical/state,dst=/state,readonly',helper.call_args.args[0])
            compose['services']['backend']['x-fullmag-daemon-binds']['/state']='foreign-alias'
            with self.assertRaisesRegex(r.ContainerRecoveryError,'retained daemon alias'):
                r._ledger_and_store_snapshot(SimpleNamespace(project='fullmag-master'),backend,compose=compose)
            self.assertEqual(helper.call_count,1)

    def test_terminal_helper_checks_real_raw_catalog_artifact_and_active_leases(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); state=root/'state'; ledger=root/'ledger'; ledger.mkdir(); (ledger/'WRITER.lock').touch()
            (ledger/'HOST_RESOURCE_LEDGER.json').write_text(json.dumps({'policy':{},'reservations':[]}))
            run=state/'runs/docker-all/session-store/runs/run-1'; run.mkdir(parents=True)
            (run.parent.parent/'objects/pins').mkdir(parents=True)
            intent=b'{"run_id":"run-1"}'
            output_payload=b'published terminal output'; output_ref=r._sha256(output_payload)
            catalog=json.dumps({'tasks':[{'task_id':'task-1','attempt_id':'current-attempt','ownership_epoch':1,'resource_id':'cpu','lifecycle':'succeeded','artifact_ids':['result']}]},separators=(',',':')).encode()
            artifact=json.dumps({'schema_version':'artifact_catalog.v1','run_id':'run-1','revision':1,'updated_at':'2026-10-27T00:00:00Z','entries':[{'artifact_id':'result','task_id':'task-1','attempt_id':'current-attempt','ownership_epoch':1,'logical_path':'results/result.json','artifact_type':'result','content_sha256':output_ref,'object_ref':output_ref,'status':'published','required':True}]},separators=(',',':')).encode()
            for name,raw in [('run_intent',intent),('run_catalog',catalog),('artifact_catalog',artifact)]: (run/(name+'.json')).write_bytes(raw)
            store=run.parent.parent; cas=store/'objects/sha256'; pins=store/'objects/pins'
            cas.mkdir(parents=True); pins.mkdir(parents=True,exist_ok=True)
            (cas/output_ref).write_bytes(output_payload)
            (pins/(output_ref+'.json')).write_text(json.dumps({'schema':'fullmag.cas-pin.v1','object_ref':output_ref}))
            leases=run/'resource_leases/cpu'; leases.mkdir(parents=True)
            lease={'schema_version':'resource_lease.v1','resource_id':'cpu','kind':'cpu','budget':{'cpu_millis':1,'memory_bytes':0,'gpu_memory_bytes':0,'storage_bytes':0},'run_id':'run-1','task_id':'task-1','attempt_id':'current-attempt','ownership_epoch':1,'lease_token':'lease-token','state':'released','acquired_at':'2026-10-27T00:00:00Z','heartbeat_at':'2026-10-27T00:00:01Z','heartbeat_sequence':1,'released_at':'2026-10-27T00:00:02Z'}
            (leases/'lease.json').write_text(json.dumps(lease))
            pin={'run_id':'run-1','run_intent_sha256':r._sha256(intent),'run_catalog_sha256':r._sha256(catalog),'artifact_catalog_sha256':r._sha256(artifact)}
            backend={'Image':'sha256:'+'d'*64,'Mounts':[{'Type':'bind','Source':str(state),'Destination':'/state','RW':True},{'Type':'bind','Source':str(root),'Destination':'/host-ledger','RW':True}]}
            def execute(argv,**kwargs):
                # Replace the one fixed store path without touching digest constants.
                script=argv[-2].replace("pathlib.Path('/state/runs/docker-all/session-store')",'pathlib.Path('+repr(str(state/'runs/docker-all/session-store'))+')').replace("pathlib.Path('/host-ledger/ledger')",'pathlib.Path('+repr(str(ledger))+')')
                return subprocess.run([sys.executable,'-B','-c',script,argv[-1]],capture_output=True)
            with patch.object(r,'bounded_capture',side_effect=execute):
                result=r._ledger_and_store_snapshot(SimpleNamespace(project='fullmag-master'),backend,retained_terminal_runs=[pin])
                self.assertEqual(result['run_records'],[pin])
                lease_path=leases/'lease.json'; lease_raw=lease_path.read_bytes()
                lease_path.unlink()
                with self.assertRaisesRegex(r.ContainerRecoveryError,'no matching released task lease'):
                    r._ledger_and_store_snapshot(SimpleNamespace(project='fullmag-master'),backend,retained_terminal_runs=[pin])
                lease_path.write_bytes(lease_raw)
                changed_catalog=json.loads(artifact); changed_catalog['entries'][0]['attempt_id']='historical-attempt'
                changed_artifact=json.dumps(changed_catalog,separators=(',',':')).encode()
                (run/'artifact_catalog.json').write_bytes(changed_artifact)
                changed_pin={**pin,'artifact_catalog_sha256':r._sha256(changed_artifact)}
                with self.assertRaisesRegex(r.ContainerRecoveryError,'differs from its task attempt'):
                    r._ledger_and_store_snapshot(SimpleNamespace(project='fullmag-master'),backend,retained_terminal_runs=[changed_pin])
                (run/'artifact_catalog.json').write_bytes(artifact)
                (run/'artifact_catalog.json').write_bytes(artifact+b' ')
                with self.assertRaisesRegex(r.ContainerRecoveryError,'bytes differ'): r._ledger_and_store_snapshot(SimpleNamespace(project='fullmag-master'),backend,retained_terminal_runs=[pin])
                (run/'artifact_catalog.json').write_bytes(artifact)
                payload=b'accepted input'; ref=r._sha256(payload); (cas/ref).write_bytes(payload)
                (run.parent.parent/'objects/pins'/(ref+'.json')).write_text(json.dumps({'schema':'fullmag.cas-pin.v1','object_ref':ref}))
                intent=json.dumps({'run_id':'run-1','definition_object_ref':ref}).encode(); (run/'run_intent.json').write_bytes(intent)
                pin={**pin,'run_intent_sha256':r._sha256(intent)}
                self.assertEqual(r._ledger_and_store_snapshot(SimpleNamespace(project='fullmag-master'),backend,retained_terminal_runs=[pin])['run_records'],[pin])
                (cas/ref).write_bytes(b'tampered accepted input')
                with self.assertRaisesRegex(r.ContainerRecoveryError,'CAS object bytes differ'):
                    r._ledger_and_store_snapshot(SimpleNamespace(project='fullmag-master'),backend,retained_terminal_runs=[pin])
                (cas/ref).write_bytes(payload)
                pending=run.parent.parent/'temp'; pending.mkdir(); pending_file=pending/'pending'; pending_file.write_text('pending')
                with self.assertRaisesRegex(r.ContainerRecoveryError,'pending or unknown'):
                    r._ledger_and_store_snapshot(SimpleNamespace(project='fullmag-master'),backend,retained_terminal_runs=[pin])
                pending_file.unlink()
                (leases/'lease.json').write_text('{"state":"active"}')
                with self.assertRaisesRegex(r.ContainerRecoveryError,'active or unknown'): r._ledger_and_store_snapshot(SimpleNamespace(project='fullmag-master'),backend,retained_terminal_runs=[pin])
                (leases/'lease.json').write_text(json.dumps(lease))
                admissions=run/'task_admissions/task-1';admissions.mkdir(parents=True)
                admission={'task':{'task_id':'task-1','attempt_id':'current-attempt','ownership_epoch':1},'lease':{**lease,'state':'active'}}
                admission_path=admissions/'current-attempt.json';admission_path.write_text(json.dumps(admission))
                self.assertEqual(r._ledger_and_store_snapshot(SimpleNamespace(project='fullmag-master'),backend,retained_terminal_runs=[pin])['run_records'],[pin])
                for older_lease in ({**lease,'attempt_id':'historical-attempt'},{**lease,'ownership_epoch':2}):
                    (leases/'lease.json').write_text(json.dumps(older_lease))
                    with self.assertRaisesRegex(r.ContainerRecoveryError,'unsupported historical retry'):
                        r._ledger_and_store_snapshot(SimpleNamespace(project='fullmag-master'),backend,retained_terminal_runs=[pin])
                (leases/'lease.json').write_text(json.dumps(lease))
                for component in ('task','lease'):
                    alternate=copy.deepcopy(admission);alternate[component]['attempt_id']='historical-attempt'
                    admission_path.write_text(json.dumps(alternate))
                    with self.assertRaisesRegex(r.ContainerRecoveryError,'unsupported historical retry'):
                        r._ledger_and_store_snapshot(SimpleNamespace(project='fullmag-master'),backend,retained_terminal_runs=[pin])
                admission_path.write_text(json.dumps(admission))
                alternate_path=admissions/'historical-attempt.json';alternate_path.write_text(json.dumps(admission))
                with self.assertRaisesRegex(r.ContainerRecoveryError,'unsupported historical retry'):
                    r._ledger_and_store_snapshot(SimpleNamespace(project='fullmag-master'),backend,retained_terminal_runs=[pin])
                alternate_path.unlink()
                null_pin={**pin,'artifact_catalog_sha256':None}; (run/'artifact_catalog.json').unlink()
                with self.assertRaisesRegex(r.ContainerRecoveryError,'outputs'): r._ledger_and_store_snapshot(SimpleNamespace(project='fullmag-master'),backend,retained_terminal_runs=[null_pin])
                (ledger/'HOST_RESOURCE_LEDGER.json').write_text(json.dumps({'policy':{},'reservations':[{'state':'active'}]}))
                with self.assertRaisesRegex(r.ContainerRecoveryError,'reservations'): r._ledger_and_store_snapshot(SimpleNamespace(project='fullmag-master'),backend,retained_terminal_runs=[pin])

    def test_terminal_snapshot_streams_large_cas_with_metadata_and_size_fences(self):
        if not sys.platform.startswith('linux'):
            self.skipTest('the helper memory-bound regression uses Linux resource limits')
        import resource

        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); state=root/'state'; ledger=root/'ledger'; ledger.mkdir()
            (ledger/'WRITER.lock').touch()
            (ledger/'HOST_RESOURCE_LEDGER.json').write_text(json.dumps({'policy':{},'reservations':[]}))
            run=state/'runs/docker-all/session-store/runs/run-large'; run.mkdir(parents=True)
            store=run.parent.parent; cas=store/'objects/sha256'; pins=store/'objects/pins'
            cas.mkdir(parents=True); pins.mkdir(parents=True)
            size=81*1024*1024; zero_chunk=bytes(1024*1024); digest=hashlib.sha256()
            for _ in range(81): digest.update(zero_chunk)
            object_ref=digest.hexdigest(); object_path=cas/object_ref
            with object_path.open('wb') as output: output.truncate(size)
            (pins/(object_ref+'.json')).write_text(json.dumps({'schema':'fullmag.cas-pin.v1','object_ref':object_ref}))
            intent=json.dumps({'run_id':'run-large','definition_object_ref':object_ref},separators=(',',':')).encode()
            catalog=json.dumps({'tasks':[{'task_id':'task-large','lifecycle':'succeeded','artifact_ids':[]}]},separators=(',',':')).encode()
            (run/'run_intent.json').write_bytes(intent); (run/'run_catalog.json').write_bytes(catalog)
            pin={'run_id':'run-large','run_intent_sha256':r._sha256(intent),
                 'run_catalog_sha256':r._sha256(catalog),'artifact_catalog_sha256':None}
            backend={'Image':'sha256:'+'d'*64,'Mounts':[
                {'Type':'bind','Source':str(state),'Destination':'/state','RW':True},
                {'Type':'bind','Source':str(root),'Destination':'/host-ledger','RW':True}]}

            def invoke(*,drift=False):
                def execute(argv,**kwargs):
                    script=argv[-2].replace(
                        "pathlib.Path('/state/runs/docker-all/session-store')",
                        'pathlib.Path('+repr(str(state/'runs/docker-all/session-store'))+')',
                    ).replace(
                        "pathlib.Path('/host-ledger/ledger')",
                        'pathlib.Path('+repr(str(ledger))+')',
                    )
                    if drift:
                        injection=("_read_before_drift=os.read\n_drift_target=pathlib.Path("+repr(str(object_path))+")\n"
                                   "_did_drift=[False]\ndef _read_with_metadata_drift(fd,count):\n"
                                   "    data=_read_before_drift(fd,count)\n"
                                   "    if data and not _did_drift[0]:\n"
                                   "        _did_drift[0]=True\n        os.utime(_drift_target,ns=(1,1))\n"
                                   "    return data\nos.read=_read_with_metadata_drift\n")
                        script=script.replace('MAX_ENTRIES=8192\n','MAX_ENTRIES=8192\n'+injection,1)
                    def limit_address_space():
                        memory_limit=64*1024*1024
                        resource.setrlimit(resource.RLIMIT_AS,(memory_limit,memory_limit))
                    return subprocess.run([sys.executable,'-B','-c',script,argv[-1]],
                                          capture_output=True,preexec_fn=limit_address_space)
                with patch.object(r,'bounded_capture',side_effect=execute):
                    return r._ledger_and_store_snapshot(SimpleNamespace(project='fullmag-master'),backend,
                                                        retained_terminal_runs=[pin])

            result=invoke()
            self.assertEqual(result['run_records'],[pin])
            with self.assertRaisesRegex(r.ContainerRecoveryError,'metadata changed while reading'):
                invoke(drift=True)
            with object_path.open('wb') as output: output.truncate(128*1024*1024+1)
            with self.assertRaisesRegex(r.ContainerRecoveryError,'exceeds its size/aggregate bound'):
                invoke()

    def _run_embedded_v5_inventory(self, *, v5, files=0, directories=1, runs=0,
                                   bad_file=None, symlink_directory=False, ticks=None):
        # Exercise the real embedded inventory, not copied cap logic or a large
        # on-disk fixture. Other tests execute the complete helper on real files.
        function=ast.parse(inspect.getsource(r._ledger_and_store_snapshot))
        script=next(node.value.value for node in ast.walk(function)
                    if isinstance(node,ast.Assign) and isinstance(node.value,ast.Constant)
                    and isinstance(node.value.value,str)
                    and any(isinstance(target,ast.Name) and target.id=='script' for target in node.targets))
        start=script.index("v5=observation.get('v5_mode') is True\n")
        finish=script.index("pins=observation.get('retained_cancelled_runs')",start)
        class MetadataPath(type(Path())):
            def is_symlink(self):return self.name=='symlink'
            def is_file(self):return self.name!='not-a-file'
        def entries(_):
            for index in range(runs):
                yield SimpleNamespace(name='run-'+str(index),is_symlink=lambda:False,is_dir=lambda **kwargs:True)
        def walk(*args,**kwargs):
            names=[bad_file] if bad_file else ['payload-'+str(index) for index in range(files)]
            yield '/store',['symlink'] if symlink_directory else [],names
            for index in range(1,directories):yield '/store/dir-'+str(index),[],[]
        def clock():
            if not v5:raise AssertionError('v4 inventory acquired a v5 time policy')
            return next(ticks) if ticks is not None else 0
        history={'run_id':'history','run_evidence_sha256':r._sha256(r._canonical({})),
                 'attempts':[{'task_id':'task','attempt_id':'old','ownership_epoch':1,'resource_id':'cpu'}]}
        namespace={'observation':{'v4_mode':True,'v5_mode':v5,'retained_attempt_histories':[history] if v5 else None},
                   'store':MetadataPath('/store'),'runs':MetadataPath('/store/runs'),
                   'pathlib':SimpleNamespace(Path=MetadataPath),'os':SimpleNamespace(scandir=entries,walk=walk),
                   'time':SimpleNamespace(monotonic=clock),'hashlib':hashlib,'canonical':r._canonical}
        constants=ast.parse(script[:script.index('def cas_identity(')])
        constants.body=[node for node in constants.body if isinstance(node,ast.Assign)]
        exec(compile(constants,'<actual-embedded-store-constants>','exec'),namespace)
        exec(compile(script[start:finish],'<actual-embedded-v5-inventory>','exec'),namespace)
        return namespace

    def test_v5_inventory_file_boundaries_do_not_increase_v4_limit(self):
        for v5,limit in ((False,8192),(True,32768)):
            with self.subTest(v5=v5):
                self.assertEqual(self._run_embedded_v5_inventory(v5=v5,files=limit)['count'],limit)
                with self.assertRaisesRegex(RuntimeError,'inventory is unbounded'):
                    self._run_embedded_v5_inventory(v5=v5,files=limit+1)
        self.assertEqual(self._run_embedded_v5_inventory(v5=True,files=8193)['count'],8193)

    def test_v5_inventory_directory_and_run_boundaries_preserve_v4(self):
        self.assertEqual(self._run_embedded_v5_inventory(v5=True,directories=4096)['directory_count'],4096)
        with self.assertRaisesRegex(RuntimeError,'directory inventory'):
            self._run_embedded_v5_inventory(v5=True,directories=4097)
        self.assertEqual(self._run_embedded_v5_inventory(v5=False,directories=4097)['directory_count'],4097)
        self.assertEqual(len(self._run_embedded_v5_inventory(v5=True,runs=128)['run_dirs']),128)
        with self.assertRaisesRegex(RuntimeError,'inventory is unbounded'):
            self._run_embedded_v5_inventory(v5=True,runs=129)

    def test_v5_inventory_timeout_and_invalid_entry_guards_are_executed(self):
        for arguments,ticks in (({'runs':1},[0,30]),({},[0,30]),({'files':1},[0,0,30]),({},[0,0,30])):
            with self.subTest(arguments=arguments),self.assertRaisesRegex(RuntimeError,'time bound'):
                self._run_embedded_v5_inventory(v5=True,ticks=iter(ticks),**arguments)
        for v5 in (False,True):
            with self.subTest(v5=v5),self.assertRaisesRegex(RuntimeError,'contains a symlink'):
                self._run_embedded_v5_inventory(v5=v5,symlink_directory=True)
            for bad in ('symlink','not-a-file'):
                with self.subTest(v5=v5,bad=bad),self.assertRaisesRegex(RuntimeError,'invalid file'):
                    self._run_embedded_v5_inventory(v5=v5,bad_file=bad)

    def _v5_fixture(self, root):
        state=root/'state'; ledger=root/'ledger'; ledger.mkdir()
        (ledger/'WRITER.lock').touch()
        (ledger/'HOST_RESOURCE_LEDGER.json').write_text(json.dumps({'policy':{},'reservations':[]}))
        store=state/'runs/docker-all/session-store'
        payload=b'accepted v5 input'; ref=hashlib.sha256(payload).hexdigest()
        (store/'objects/sha256').mkdir(parents=True); (store/'objects/pins').mkdir()
        (store/'objects/sha256'/ref).write_bytes(payload)
        (store/'objects/pins'/(ref+'.json')).write_text(json.dumps({'schema':'fullmag.cas-pin.v1','object_ref':ref}))
        terminal=[]; held=[]; histories=[]
        def write(path,value):
            path.parent.mkdir(parents=True,exist_ok=True)
            path.write_bytes(r._canonical(value))
        for run_id in ('run-history-a','run-history-b','run-held'):
            run=store/'runs'/run_id; run.mkdir(parents=True)
            intent={'schema_version':'run_intent.v1','run_id':run_id,'idempotency_key':run_id,
                    'payload_sha256':'e'*64,'definition_object_ref':ref,'specification':{'parameters':{}}}
            task={'task_id':'task-1','input_fingerprint':'a'*64,'artifact_ids':[]}
            if run_id=='run-held':
                intent['specification']['parameters']['fullmag.accepted_run_start']={'schema_version':'accepted_run_start_policy.v1','mode':'manual'}
                task.update(lifecycle='accepted',readiness={'state':'blocked','reason':'awaiting preparation'})
            else:
                task.update(lifecycle='succeeded',attempt_id='attempt-new',ownership_epoch=2,resource_id='cpu',readiness={'state':'ready'})
            catalog={'schema_version':'run_catalog.v1','run_id':run_id,'revision':2,
                     'updated_at':'2026-10-28T12:00:00Z','tasks':[task]}
            write(run/'run_intent.json',intent); write(run/'run_catalog.json',catalog)
            pin={'run_id':run_id,'run_intent_sha256':r._sha256((run/'run_intent.json').read_bytes()),
                 'run_catalog_sha256':r._sha256((run/'run_catalog.json').read_bytes())}
            if run_id=='run-held':
                held.append({**pin,'start_release':'absent'}); continue
            terminal.append({**pin,'artifact_catalog_sha256':None})
            old={'task_id':'task-1','attempt_id':'attempt-old','ownership_epoch':1,'resource_id':'cpu'}
            for attempt,epoch in (('attempt-old',1),('attempt-new',2)):
                lease={'schema_version':'resource_lease.v1','resource_id':'cpu','kind':'cpu',
                       'budget':{'cpu_millis':1,'memory_bytes':0,'gpu_memory_bytes':0,'storage_bytes':0},
                       'run_id':run_id,'task_id':'task-1','attempt_id':attempt,'ownership_epoch':epoch,
                       'lease_token':'private-fixture-'+attempt,'state':'released','heartbeat_sequence':0,
                       'acquired_at':'2026-10-28T12:00:00Z','heartbeat_at':'2026-10-28T12:00:01Z',
                       'released_at':'2026-10-28T12:00:02Z'}
                write(run/'resource_leases/cpu'/(attempt+'.json'),lease)
                admitted={**task,'attempt_id':attempt,'ownership_epoch':epoch,'lifecycle':'preparing'}
                write(run/'task_admissions/task-1'/(attempt+'.json'),{'task':admitted,'lease':{**lease,'state':'active'}})
            write(run/'retry_decisions/retry-1.json',{'schema_version':'retry_decision.v1','decision_id':'retry-1',
                  'run_id':run_id,**{key:old[key] for key in ('task_id','attempt_id','ownership_epoch')},
                  'trigger':'explicit_operator_request','action':'retry','reason':'operator retry',
                  'created_at':'2026-10-28T12:00:03Z'})
            write(run/'worker_process_exit_receipts/exit-old.json',{
                'schema_version':'worker_process_exit_receipt.v1','receipt_id':'exit-old','run_id':run_id,**old,
                'lease_token':'private-fixture-attempt-old','lease_heartbeat_sequence':0,'process_id':123,
                'status_success':False,'exit_code':1,'timed_out':False,'stop_requested':False,
                'observed_at':'2026-10-28T12:00:02Z'})
            # Raw stream content is pinned here; deep typed journal/heartbeat
            # qualification belongs to the mandatory native preview tests.
            write(run/'worker_inboxes/old.json',{'pending':None,'applied_count':2,'commands_count':3})
            histories.append({'run_id':run_id,'run_evidence_sha256':'0'*64,'attempts':[old]})
        backend={'Image':'sha256:'+'d'*64,'Mounts':[
            {'Type':'bind','Source':str(state),'Destination':'/state','RW':True},
            {'Type':'bind','Source':str(root),'Destination':'/host-ledger','RW':True}]}
        def repin():
            for history in histories:
                run=store/'runs'/history['run_id']
                raw={path.relative_to(run).as_posix():r._sha256(path.read_bytes())
                     for path in run.rglob('*') if path.is_file()}
                history['run_evidence_sha256']=r._sha256(r._canonical(raw))
        repin()
        def invoke(v5=True):
            def execute(argv,**kwargs):
                script=argv[-2].replace("pathlib.Path('/state/runs/docker-all/session-store')",'pathlib.Path('+repr(str(store))+')').replace("pathlib.Path('/host-ledger/ledger')",'pathlib.Path('+repr(str(ledger))+')')
                return subprocess.run([sys.executable,'-B','-c',script,argv[-1]],capture_output=True)
            with patch.object(r,'bounded_capture',side_effect=execute):
                return r._ledger_and_store_snapshot(SimpleNamespace(project='fullmag-master'),backend,
                    retained_terminal_runs=terminal,retained_held_manual_runs=held,
                    **({'retained_attempt_histories':histories} if v5 else {}))
        return store,terminal,held,histories,repin,invoke

    def test_v5_preflight_reads_two_failed_retry_histories_and_v4_still_refuses(self):
        with tempfile.TemporaryDirectory() as directory:
            store,terminal,held,histories,repin,invoke=self._v5_fixture(Path(directory))
            observed=invoke()
            self.assertEqual(observed['retained_attempt_histories'],histories)
            self.assertEqual(observed['run_records'],sorted(terminal+held,key=lambda item:item['run_id']))
            with self.assertRaisesRegex(r.ContainerRecoveryError,'unsupported historical retry'):
                invoke(v5=False)

    def test_v5_full_run_digest_rejects_changed_or_additional_stream_evidence(self):
        for change in ('changed','additional'):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as directory:
                store,_,_,histories,_,invoke=self._v5_fixture(Path(directory))
                run=store/'runs'/histories[0]['run_id']
                path=run/('worker_inboxes/old.json' if change=='changed' else 'unexpected.json')
                path.write_bytes(b'{"changed":true}')
                with self.assertRaisesRegex(r.ContainerRecoveryError,'full run evidence inventory/digest'):
                    invoke()

    def test_v5_history_identity_guards_refuse_even_after_explicit_digest_repin(self):
        for change in ('active','token','resource','missing_admission','missing_exit','missing_retry','wrong_exit','epoch_gap','unknown_lease'):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as directory:
                store,terminal,held,histories,repin,invoke=self._v5_fixture(Path(directory))
                run=store/'runs'/histories[0]['run_id']
                lease_path=run/'resource_leases/cpu/attempt-old.json'
                if change in ('active','token','resource','unknown_lease'):
                    lease=json.loads(lease_path.read_bytes())
                    if change=='active':lease['state']='active'
                    elif change=='token':lease['lease_token']='foreign'
                    elif change=='resource':lease['resource_id']='foreign'
                    else:lease['attempt_id']='unknown'
                    lease_path.write_bytes(r._canonical(lease))
                elif change=='missing_admission':(run/'task_admissions/task-1/attempt-old.json').unlink()
                elif change=='missing_exit':(run/'worker_process_exit_receipts/exit-old.json').unlink()
                elif change=='missing_retry':(run/'retry_decisions/retry-1.json').unlink()
                elif change=='wrong_exit':
                    path=run/'worker_process_exit_receipts/exit-old.json'; record=json.loads(path.read_bytes())
                    record['lease_heartbeat_sequence']=1;path.write_bytes(r._canonical(record))
                else:
                    path=run/'run_catalog.json'; catalog=json.loads(path.read_bytes());catalog['tasks'][0]['ownership_epoch']=3
                    path.write_bytes(r._canonical(catalog));terminal[0]['run_catalog_sha256']=r._sha256(path.read_bytes())
                repin()
                with self.assertRaises(r.ContainerRecoveryError):invoke()

    def test_v5_request_history_shape_subset_bounds_and_legacy_refusals(self):
        terminal={'run_id':'terminal','run_intent_sha256':'1'*64,'run_catalog_sha256':'2'*64,'artifact_catalog_sha256':None}
        held={'run_id':'held','run_intent_sha256':'3'*64,'run_catalog_sha256':'4'*64,'start_release':'absent'}
        claim={'task_id':'task','attempt_id':'old','ownership_epoch':1,'resource_id':'cpu'}
        history={'run_id':'terminal','run_evidence_sha256':'5'*64,'attempts':[claim]}
        request={'schema_version':r.ATTEMPT_HISTORY_REQUEST_SCHEMA,'retained_terminal_runs':[terminal],
                 'retained_held_manual_runs':[held],'retained_attempt_histories':[history]}
        self.assertEqual(r.expected_recovery_outcome(request),'retained_attempt_history_recovered')
        for schema in (r.REQUEST_SCHEMA,r.RETAINED_REQUEST_SCHEMA,r.TERMINAL_REQUEST_SCHEMA,r.HELD_MANUAL_REQUEST_SCHEMA):
            with self.subTest(schema=schema), self.assertRaisesRegex(r.ContainerRecoveryError,'require v5'):
                r.expected_recovery_outcome({**request,'schema_version':schema})
        for bad in ([],[{**history,'run_id':'held'}],[{**history,'run_evidence_sha256':'bad'}],
                    [{**history,'attempts':[]}],[{**history,'attempts':[claim,claim]}],
                    [{**history,'attempts':[{**claim,'ownership_epoch':True}]}]):
            with self.subTest(bad=bad), self.assertRaises(r.ContainerRecoveryError):
                r.expected_recovery_outcome({**request,'retained_attempt_histories':bad})
        claims=[{**claim,'task_id':'task-'+str(i),'attempt_id':'attempt-'+str(i)} for i in range(128)]
        r.expected_recovery_outcome({**request,'retained_attempt_histories':[{**history,'attempts':claims}]})
        with self.assertRaisesRegex(r.ContainerRecoveryError,'exceeds 128'):
            r.expected_recovery_outcome({**request,'retained_attempt_histories':[{**history,'attempts':claims+[dict(claim)]}]})

    def test_v5_abrupt_request_history_cas_requires_matching_proof_version_and_pins(self):
        terminal={'run_id':'terminal','run_intent_sha256':'1'*64,'run_catalog_sha256':'2'*64,'artifact_catalog_sha256':None}
        held={'run_id':'held','run_intent_sha256':'3'*64,'run_catalog_sha256':'4'*64,'start_release':'absent'}
        history={'run_id':'terminal','run_evidence_sha256':'5'*64,'attempts':[{
            'task_id':'task','attempt_id':'old','ownership_epoch':1,'resource_id':'cpu'}]}
        request={'schema_version':r.ATTEMPT_HISTORY_REQUEST_SCHEMA,'retained_terminal_runs':[terminal],
                 'retained_held_manual_runs':[held],'retained_attempt_histories':[history]}
        proof={'schema':r.ABRUPT_PROOF_ATTEMPT_HISTORY_SCHEMA,**{key:value for key,value in request.items() if key!='schema_version'}}
        r._assert_request_matches_abrupt_retained_pins(request,proof)
        with self.assertRaises(r.ContainerRecoveryError):
            r._assert_request_matches_abrupt_retained_pins({**request,'retained_attempt_histories':[]},proof)
        with self.assertRaises(r.ContainerRecoveryError):
            r._assert_request_matches_abrupt_retained_pins(request,{**proof,'schema':r.ABRUPT_PROOF_HELD_MANUAL_SCHEMA})

    def test_v4_snapshot_accepts_exact_held_manual_inventory_and_rejects_release_or_unknown_evidence(self):
        def make_state(root):
            state=root/'state'; ledger=root/'ledger'; ledger.mkdir()
            (ledger/'WRITER.lock').touch()
            (ledger/'HOST_RESOURCE_LEDGER.json').write_text(json.dumps({'policy':{},'reservations':[]}))
            store=state/'runs/docker-all/session-store'
            run=store/'runs/run-held'; run.mkdir(parents=True)
            terminal_run=store/'runs/run-terminal'; terminal_run.mkdir(parents=True)
            digest=hashlib.sha256(b'held manual accepted input').hexdigest()
            objects=store/'objects'
            (objects/'sha256').mkdir(parents=True)
            (objects/'pins').mkdir(parents=True)
            (objects/'sha256'/digest).write_bytes(b'held manual accepted input')
            (objects/'pins'/(digest+'.json')).write_text(json.dumps({'schema':'fullmag.cas-pin.v1','object_ref':digest}))
            intent={'schema_version':'run_intent.v1','run_id':'run-held','idempotency_key':'key-held',
                    'payload_sha256':'e'*64,'specification':{'parameters':{'fullmag.accepted_run_start':{'schema_version':'accepted_run_start_policy.v1','mode':'manual'}}},
                    'definition_object_ref':digest}
            task={'task_id':'task-held','input_fingerprint':'a'*64,'lifecycle':'accepted',
                  'readiness':{'state':'blocked','reason':'awaiting preparation'},'artifact_ids':[]}
            catalog={'schema_version':'run_catalog.v1','run_id':'run-held','revision':1,
                     'updated_at':'2026-10-27T12:00:00Z','tasks':[task]}
            terminal_intent={'schema_version':'run_intent.v1','run_id':'run-terminal','idempotency_key':'key-terminal',
                             'payload_sha256':'f'*64,'specification':{'parameters':{}},'definition_object_ref':digest}
            terminal_catalog={'schema_version':'run_catalog.v1','run_id':'run-terminal','revision':1,
                              'updated_at':'2026-10-27T12:00:00Z',
                              'tasks':[{'task_id':'task-terminal','input_fingerprint':'b'*64,'lifecycle':'succeeded',
                                        'readiness':{'state':'ready'},'artifact_ids':[]}]}
            intent_raw=json.dumps(intent,separators=(',',':')).encode()
            catalog_raw=json.dumps(catalog,separators=(',',':')).encode()
            terminal_intent_raw=json.dumps(terminal_intent,separators=(',',':')).encode()
            terminal_catalog_raw=json.dumps(terminal_catalog,separators=(',',':')).encode()
            (run/'run_intent.json').write_bytes(intent_raw)
            (run/'run_catalog.json').write_bytes(catalog_raw)
            (terminal_run/'run_intent.json').write_bytes(terminal_intent_raw)
            (terminal_run/'run_catalog.json').write_bytes(terminal_catalog_raw)
            held={'run_id':'run-held','run_intent_sha256':hashlib.sha256(intent_raw).hexdigest(),
                  'run_catalog_sha256':hashlib.sha256(catalog_raw).hexdigest(),'start_release':'absent'}
            terminal={'run_id':'run-terminal','run_intent_sha256':hashlib.sha256(terminal_intent_raw).hexdigest(),
                      'run_catalog_sha256':hashlib.sha256(terminal_catalog_raw).hexdigest(),'artifact_catalog_sha256':None}
            backend={'Image':'sha256:'+'d'*64,'Mounts':[
                {'Type':'bind','Source':str(state),'Destination':'/state','RW':True},
                {'Type':'bind','Source':str(root),'Destination':'/host-ledger','RW':True}]}
            return state,ledger,store,run,backend,terminal,held

        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); state,ledger,store,run,backend,terminal,held=make_state(root)
            # Re-run with both subsets to prove one exact inventory/CAS union.
            def run_combined():
                def execute(argv,**kwargs):
                    script=argv[-2].replace(
                        "pathlib.Path('/state/runs/docker-all/session-store')",
                        'pathlib.Path('+repr(str(state/'runs/docker-all/session-store'))+')',
                    ).replace(
                        "pathlib.Path('/host-ledger/ledger')",
                        'pathlib.Path('+repr(str(state.parent/'ledger'))+')',
                    )
                    return subprocess.run([sys.executable,'-B','-c',script,argv[-1]],capture_output=True)
                with patch.object(r,'bounded_capture',side_effect=execute):
                    return r._ledger_and_store_snapshot(SimpleNamespace(project='fullmag-master'),backend,
                                                        retained_terminal_runs=[terminal],retained_held_manual_runs=[held])
            combined=run_combined()
            self.assertEqual(combined['run_records'],sorted([terminal,held],key=lambda item:item['run_id']))
            self.assertEqual(combined['run_directories'],['run-held','run-terminal'])
            self.assertEqual(combined['store_file_count'],6)
            prep_key={'run_id':'run-held','task_id':'task-held','preparation_attempt_id':'prep-attempt-1',
                      'resource_id':'resource-1','lease_token':'lease-1'}
            lease={**prep_key,'state':'released','released_at':'2026-10-27T12:00:03Z','heartbeat_sequence':2}
            launch={**prep_key,'lease_heartbeat_sequence':1,'supervisor_process_id':123,'created_at':'2026-10-27T12:00:01Z'}
            exit_receipt={**prep_key,'lease_heartbeat_sequence':2,'process_id':123,'status_success':True,
                          'exit_code':0,'timed_out':False,'failure_reason':None,'observed_at':'2026-10-27T12:00:02Z'}
            for relative,value in (
                ('preparation_resource_leases/resource-1/lease-1.json',lease),
                ('preparation_process_launches/launch.json',launch),
                ('preparation_process_exit_receipts/exit.json',exit_receipt),
                ('task_preparation_receipts/task-held.json',{'run_id':'run-held','task_id':'task-held'}),
            ):
                path=run/relative;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(value))
            prepared=run_combined()
            self.assertEqual(prepared['run_records'],sorted([terminal,held],key=lambda item:item['run_id']))
            self.assertEqual(prepared['store_file_count'],10)
            (run/'start_release.json').write_text('{}')
            with self.assertRaisesRegex(r.ContainerRecoveryError,'start_release'):
                run_combined()

        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); state,ledger,store,run,backend,terminal,held=make_state(root)
            evidence=run/'resource_leases'/'compute.json'; evidence.parent.mkdir(); evidence.write_text('{}')
            with self.assertRaisesRegex(r.ContainerRecoveryError,'unknown evidence'):
                def invoke():
                    def execute(argv,**kwargs):
                        script=argv[-2].replace("pathlib.Path('/state/runs/docker-all/session-store')",'pathlib.Path('+repr(str(state/'runs/docker-all/session-store'))+')').replace("pathlib.Path('/host-ledger/ledger')",'pathlib.Path('+repr(str(state.parent/'ledger'))+')')
                        return subprocess.run([sys.executable,'-B','-c',script,argv[-1]],capture_output=True)
                    with patch.object(r,'bounded_capture',side_effect=execute):
                        return r._ledger_and_store_snapshot(SimpleNamespace(project='fullmag-master'),backend,retained_terminal_runs=[terminal],retained_held_manual_runs=[held])
                invoke()

        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); state,ledger,store,run,backend,terminal,held=make_state(root)
            intent=json.loads((run/'run_intent.json').read_bytes())
            intent['specification']['parameters']['fullmag.accepted_run_start']['mode']='automatic'
            (run/'run_intent.json').write_text(json.dumps(intent,separators=(',',':')))
            with self.assertRaisesRegex(r.ContainerRecoveryError,'bytes differ'):
                def invoke():
                    def execute(argv,**kwargs):
                        script=argv[-2].replace("pathlib.Path('/state/runs/docker-all/session-store')",'pathlib.Path('+repr(str(state/'runs/docker-all/session-store'))+')').replace("pathlib.Path('/host-ledger/ledger')",'pathlib.Path('+repr(str(state.parent/'ledger'))+')')
                        return subprocess.run([sys.executable,'-B','-c',script,argv[-1]],capture_output=True)
                    with patch.object(r,'bounded_capture',side_effect=execute):
                        return r._ledger_and_store_snapshot(SimpleNamespace(project='fullmag-master'),backend,retained_terminal_runs=[terminal],retained_held_manual_runs=[held])
                invoke()

    def test_full_recover_v2_consumes_ready_proof_and_builds_v3_without_solve(self):
        """Exercise orchestration through start() with all external actions mocked."""
        import contextlib
        proof, auth, compose = self.fixture()
        selected = Path(__file__).resolve().parent.parent
        pins = proof['authorization_pins']
        pins['source_root'] = str(selected)
        b,f=proof['containers'].values()
        b['Config']['Env']=['FULLMAG_DOCKER_DEVICE_ACCESS=cpu']
        terminal_pins=[{'run_id':'completed','run_intent_sha256':'1'*64,'run_catalog_sha256':'2'*64,'artifact_catalog_sha256':None}]
        proof['retained_terminal_runs']=terminal_pins
        proof['storage_proof']={'store_root_sha256':'3'*64,'ledger_root_sha256':'4'*64,'ledger_snapshot_sha256':'5'*64,'run_records':terminal_pins}
        proof['docker_engine_id_sha256']=r._sha256(b'engine')
        operator={**pins,'schema_version':r.ABRUPT_OPERATOR_SCHEMA,'abrupt_stop_proof':'verification/abrupt-proof.json','abrupt_stop_proof_sha256':r._sha256(r._canonical(proof))}
        auth=r.validate_operator_authorization(operator)
        terminal={'phase':'development','attempt':pins['development_attempt'],'inputs':{'gpu_access_requested':'disabled'},'state_root':'/canonical/state'}
        documents={'operator.json':r._canonical(operator),auth['stop_journal_path']:r._canonical(proof),
                   f"development/attempts/{pins['development_attempt']}/terminal.json":r._canonical(terminal),
                   f"development/attempts/{pins['development_attempt']}/compose.json":r._canonical(compose)}
        documents.update({item['path']:item['raw_utf8'].encode() for item in proof['raw_records'].values()})
        @contextlib.contextmanager
        def operation(*args):
            yield {'receipt':{},'root':'operations/fake'}
        control=SimpleNamespace(project=compose['name'],prepare=lambda:None,operation=operation,write_bytes=lambda path,raw:documents.update({path:raw}))
        def read(control,path,*,optional=False):
            if path not in documents and not optional: self.fail('missing '+path)
            return documents.get(path)
        def read_json(control,path,*,optional=False):
            raw=read(control,path,optional=optional)
            return (json.loads(raw),raw) if raw else (None,None)
        def docker(*args,**kwargs):
            if args[0]=='rm': return SimpleNamespace(returncode=0,stdout=b'',stderr=b'')
            if args[:2]==('network','ls'): return SimpleNamespace(returncode=0,stdout=b'',stderr=b'')
            if args[:2]==('network','inspect'): return SimpleNamespace(returncode=1,stdout=b'',stderr=('Error response from daemon: network '+str(args[2])+' not found').encode())
            if args[0]=='inspect': return SimpleNamespace(returncode=1,stdout=b'',stderr=b'No such object')
            self.fail('unexpected Docker command '+str(args))
        device={'resource_id':'runtime-cpu','mapping_sha256':'6'*64,'mapping_detached':True}
        toolchain={'image_id':pins['old_image_id'],'inputs':{'build_args':{'FULLMAG_CUDA_BASE_IMAGE':'helper'}}}
        images={'backend':{'image_id':pins['old_image_id']}}
        args=SimpleNamespace(repo_root=selected,source_root=str(selected),recovery_authorization='operator.json',attempt=pins['development_attempt'])
        patches=[patch.object(r,'BuildControl',return_value=control),
            patch.object(r,'toolchain_configuration',return_value={'services':{'fem-gpu-toolchain':{'build':{'args':{'FULLMAG_CUDA_BASE_IMAGE':'helper'}}}}}),
            patch.object(r,'_control_bytes',side_effect=read),patch.object(r,'_control_json',side_effect=read_json),
            patch.object(r,'_inspect_pair',return_value=(b,f)),patch.object(r,'_abrupt_network',return_value=proof['network']),
            patch.object(r,'_assert_no_foreign_storage_consumers'),patch.object(r,'_ledger_and_store_snapshot',return_value=proof['storage_proof']),
            patch.object(r,'_docker_engine_sha',return_value=proof['docker_engine_id_sha256']),patch.object(r,'_docker_engine_id',return_value='engine'),
            patch.object(r,'_device_release_from_config',return_value=(device,{'kind':'cpu'})),
            patch.object(r,'_application_pin',return_value={'mode':'external_only','raw_sha256':pins['config_sha256']}),
            patch.object(r,'_validate_reused_session_before_removal',return_value={'state':'/canonical/state','host_certificate':{},'owner_marker':{}}),
            patch.object(r,'docker_capture',side_effect=docker),
            patch('docker_dev._select_source',return_value=(selected,{})),patch('docker_dev._compose_identity',return_value={'project_id':'project','worktree_id':'master','checkout_kind':'main'}),
            patch('docker_dev._resolve_gpu_access',return_value='cpu'),patch('docker_dev._verify_docker_gpu_access',return_value='cpu'),
            patch('docker_build_control.build_volume_toolchain',return_value=toolchain),patch('docker_build_control.build_volume_runtime_images',return_value=images),
            patch('docker_volume_dev._operator_probe_record_from_retained',return_value={})]
        with contextlib.ExitStack() as stack:
            for item in patches: stack.enter_context(item)
            start=stack.enter_context(patch('docker_volume_dev.start'))
            r.recover(args)
        start.assert_called_once()
        request=json.loads(documents[f"{r.RECOVERY_RELATIVE_ROOT}/{auth['request_id']}/request.json"])
        self.assertEqual(request['schema_version'],r.TERMINAL_REQUEST_SCHEMA)
        self.assertEqual(request['retained_terminal_runs'],terminal_pins)
        self.assertEqual(request['expected_owner']['state'],'ready')
        self.assertEqual(documents['runtime-control/runtime-service/process-tree.json'],proof['raw_records']['process_receipt']['raw_utf8'].encode())
        self.assertIsNone(start.call_args.args[0].script)
        self.assertTrue(any(path.endswith('/absence.json') for path in documents))

    def test_inspect_pair_checks_image_service_and_retained_config_before_no_bridge(self):
        proof,auth,compose=self.fixture(); b,f=proof['containers'].values()
        def inspect(*args,**kwargs):
            if args[:2]==('image','inspect'): return SimpleNamespace(stdout=b'[{"Config":{}}]')
            return SimpleNamespace(stdout=json.dumps([b,f]).encode())
        with patch.object(r,'docker_capture',side_effect=inspect),patch('docker_volume_dev._validate_retained_service') as service,patch.object(r,'_abrupt_network',return_value=proof['network']):
            self.assertEqual(r._inspect_pair(auth,compose['name'],compose),(b,f))
            self.assertEqual(service.call_count,2)
            b['Image']='sha256:'+'a'*64
            with self.assertRaisesRegex(r.ContainerRecoveryError,'ownership'):r._inspect_pair(auth,compose['name'],compose)
            b['Image']=auth['old_image_id']
            service.side_effect=ValueError('mount/config drift')
            with self.assertRaisesRegex(r.ContainerRecoveryError,'configuration'):r._inspect_pair(auth,compose['name'],compose)

if __name__=='__main__': unittest.main()
