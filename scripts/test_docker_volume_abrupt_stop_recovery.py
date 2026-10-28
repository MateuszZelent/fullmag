"""Docker-free checks for original-evidence abrupt stop recovery."""
from __future__ import annotations
import copy
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
