"""Pure Python v3 bridge regressions; no Docker, Rust build or real native CLI."""
from __future__ import annotations
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock
sys.path.insert(0,str(Path(__file__).resolve().parent))
import test_docker_container_runtime_recovery as fixtures
r=fixtures.runtime_service


class TerminalContainerRecoveryTests(unittest.TestCase):
    @staticmethod
    def terminal_pin():
        return {'run_id':'terminal-1','run_intent_sha256':'1'*64,'run_catalog_sha256':'2'*64,'artifact_catalog_sha256':None}

    @staticmethod
    def held_pin():
        return {'run_id':'held-1','run_intent_sha256':'3'*64,'run_catalog_sha256':'4'*64,'start_release':'absent'}

    def make_v4(self, context, terminal=None):
        request=context['request']
        request['schema_version']=r.CONTAINER_RECOVERY_HELD_MANUAL_REQUEST_SCHEMA
        request['retained_terminal_runs']=[] if terminal is None else terminal
        request['retained_held_manual_runs']=[self.held_pin()]
        request.pop('retained_cancelled_runs',None)
        context['request_sha256']=r._sha256_bytes(r._canonical_container_recovery_json(request))
        return request

    def fixture(self, root):
        fixture=fixtures.ContainerRuntimeRecoveryBridgeTests()._document_fixture(root)
        package=root/'package'; (package/'bin').mkdir(parents=True)
        binary=package/'bin/fullmag-bin'; binary.write_bytes(b'original native executable'); binary.chmod(0o755)
        state=root/'state'; state.mkdir()
        runtime=root/'runtime-control/runtime-services'; runtime.mkdir(parents=True)
        store=root/'store'; store.mkdir()
        config=root/'runtime-control/runtime-service/docker-all.json'; config.parent.mkdir(); config.write_bytes(b'{"configuration":"original"}')
        provenance=root/'provenance.json'; provenance.write_text(json.dumps({'commit':'a'*40,'native_source_identity':{'source_snapshot_sha256':'b'*64}}))
        paths=r.RuntimePaths(state=state,package=package,store=store,runtime_services=runtime,config=config,provenance=provenance)
        request=fixture['request']; request.update(schema_version=r.CONTAINER_RECOVERY_TERMINAL_REQUEST_SCHEMA,retained_terminal_runs=[self.terminal_pin()])
        owner=request['expected_owner']; owner_raw=json.dumps(owner).encode(); (runtime/'OWNER.json').write_bytes(owner_raw)
        launch=b'{"launch":"original"}'; (runtime/'LAUNCH.json').write_bytes(launch)
        request.update(owner_sha256=r._sha256_bytes(owner_raw),config_sha256=r._sha256_bytes(config.read_bytes()),launch_sha256=r._sha256_bytes(launch))
        request_sha=r._sha256_bytes(r._canonical_container_recovery_json(request))
        authorization={'owner_sha256':request['owner_sha256'],'launch_sha256':request['launch_sha256']}
        context={'request':request,'request_sha256':request_sha,'config_sha256':request['config_sha256'],'authorization':authorization,
                 'request_path':root/'request.json','attestation_path':root/'attestation.json','attestation_sha256':'c'*64,'expected_owner':owner}
        capability={'schema_version':r.CONTAINER_RECOVERY_CAPABILITIES_SCHEMA,
                    'supported_recovery_schemas':[r.CONTAINER_RECOVERY_REQUEST_SCHEMA,'runtime_service_container_recovery_request.v2',r.CONTAINER_RECOVERY_TERMINAL_REQUEST_SCHEMA,r.CONTAINER_RECOVERY_HELD_MANUAL_REQUEST_SCHEMA],
                    'build_identity':{'version':'0.1.0','built_at_utc':'2026-10-27T12:00:00Z','git_commit':'a'*40,'worktree_state':'clean','source_snapshot_sha256':'b'*64}}
        return paths,context,capability,fixture

    def run_recovery(self, paths,context,cli_action):
        with mock.patch.dict(os.environ,{r.CONTAINER_RECOVERY_AUTHORIZATION_ENV:'/control/operator.json',r.CONTAINER_RECOVERY_AUTHORIZATION_SHA256_ENV:'a'*64},clear=True),mock.patch.object(r,'_read_container_recovery_authorization',return_value=context),mock.patch.object(r,'_run_cli',side_effect=cli_action),mock.patch.object(r,'_validate_container_recovery_archive'):
            return r.recover_container_namespace(paths)

    def receipt(self, context, owner_after):
        request=context['request']
        result={'schema_version':r.CONTAINER_RECOVERY_RECEIPT_SCHEMA,'status':'recovered','outcome':r._container_recovery_expected_outcome(request),
                'request_id':request['request_id'],'request_sha256':context['request_sha256'],'target_id':'docker-all',
                'owner_sha256_before':request['owner_sha256'],'owner_state_before':request['expected_owner']['state'],'owner_state_after':'failed',
                'owner_sha256_after':r._sha256_bytes(owner_after),'attestation_sha256':context['attestation_sha256'],
                'historical_build_commit':'d'*40,'executor_build_commit':'a'*40,'historical_build_snapshot':'e'*64,'executor_build_snapshot':'b'*64,
                'archived_evidence_sha256':'f'*64}
        for key in ('config_sha256','store_root_sha256','application','ledger_root_sha256','ledger_snapshot_sha256','docker_manifest_sha256','prior_ready_owner_proof_sha256','device_release_mapping_sha256'):
            result[key]=request[key]
        return result

    def test_valid_v3_probe_precedes_native_mutator_and_publishes_exact_binary_and_raw_sha(self):
        with tempfile.TemporaryDirectory() as directory:
            paths,context,cap,_=self.fixture(Path(directory)); calls=[]
            raw=(json.dumps(cap,indent=3)+'\n').encode()
            failed=json.dumps({**context['expected_owner'],'state':'failed'}).encode(); receipt=self.receipt(context,failed)
            original_owner=(paths.runtime_services/'OWNER.json').read_bytes()
            def cli(paths,args,*,timeout,cli,raw_output=None):
                calls.append(tuple(args))
                if args[1]=='service-container-recovery-capabilities':
                    self.assertEqual(tuple(args),('runtime','service-container-recovery-capabilities'))
                    self.assertEqual((paths.runtime_services/'OWNER.json').read_bytes(),original_owner)
                    raw_output.append(raw); return cap
                self.assertEqual(args[1],'service-recover-container')
                (paths.runtime_services/'OWNER.json').write_bytes(failed)
                return receipt
            result=self.run_recovery(paths,context,cli)
            self.assertEqual(result,receipt)
            self.assertEqual([call[1] for call in calls],['service-container-recovery-capabilities','service-recover-container'])
            proofs=list(paths.runtime_services.glob('container-recovery/*/native-capabilities/*.json'))
            self.assertEqual(len(proofs),1); proof=json.loads(proofs[0].read_bytes())
            self.assertEqual(proof['binary_sha256'],r._sha256_bytes((paths.package/'bin/fullmag-bin').read_bytes()))
            self.assertEqual(proof['capabilities_raw_sha256'],r._sha256_bytes(raw))
            self.assertEqual(proof['capabilities_raw_utf8'],raw.decode())
            self.assertNotIn('binary_sha256',result)

    def test_unsupported_missing_command_corrupt_payload_and_wrong_build_refuse_before_mutator(self):
        for mode in ('unsupported','missing-command','extra-field','wrong-build','raw-drift','duplicate-schemas','bad-build-shape'):
            with self.subTest(mode=mode),tempfile.TemporaryDirectory() as directory:
                paths,context,cap,_=self.fixture(Path(directory)); calls=[]; before=(paths.runtime_services/'OWNER.json').read_bytes()
                if mode=='unsupported':cap['supported_recovery_schemas']=[r.CONTAINER_RECOVERY_REQUEST_SCHEMA]
                if mode=='extra-field':cap['unexpected']=True
                if mode=='wrong-build':cap['build_identity']['git_commit']='f'*40
                if mode=='duplicate-schemas':cap['supported_recovery_schemas']*=2
                if mode=='bad-build-shape':cap['build_identity'].pop('version')
                def cli(paths,args,*,timeout,cli,raw_output=None):
                    calls.append(tuple(args)); self.assertEqual(args[1],'service-container-recovery-capabilities')
                    if mode=='missing-command':raise r.RuntimeServiceError('unrecognized subcommand')
                    raw_output.append(json.dumps({'corrupt':True} if mode=='raw-drift' else cap).encode()); return cap
                with self.assertRaises(r.RuntimeServiceError):self.run_recovery(paths,context,cli)
                self.assertEqual(len(calls),1)
                self.assertEqual((paths.runtime_services/'OWNER.json').read_bytes(),before)
                self.assertFalse(any(paths.runtime_services.glob('container-recovery/*/native-capabilities/*.json')))

    def test_binary_drift_during_capabilities_and_before_each_mutator_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            paths,context,cap,_=self.fixture(Path(directory)); calls=[]
            def cli(paths,args,*,timeout,cli,raw_output=None):
                calls.append(args); raw_output.append(json.dumps(cap).encode())
                (paths.package/'bin/fullmag-bin').write_bytes(b'changed executable'); return cap
            with self.assertRaisesRegex(r.RuntimeServiceError,'changed during capability'):self.run_recovery(paths,context,cli)
            self.assertEqual(len(calls),1)
            with mock.patch.object(r,'_run_cli') as native:
                with self.assertRaisesRegex(r.RuntimeServiceError,'changed before mutator'):
                    r._run_container_recovery_cli(paths,('runtime','service-recover-container'),timeout=90,cli=None,binary_sha256='0'*64)
                native.assert_not_called()

    def test_binary_replacement_after_publishing_probe_is_rejected_before_mutator(self):
        with tempfile.TemporaryDirectory() as directory:
            paths,context,cap,_=self.fixture(Path(directory)); calls=[]
            original=r._publish_container_capability_proof
            def publish(paths,context,proof):
                original(paths,context,proof)
                (paths.package/'bin/fullmag-bin').write_bytes(b'replaced after proof publication')
            def cli(paths,args,*,timeout,cli,raw_output=None):
                calls.append(tuple(args)); self.assertEqual(args[1],'service-container-recovery-capabilities')
                raw_output.append(json.dumps(cap).encode());return cap
            before=(paths.runtime_services/'OWNER.json').read_bytes()
            with mock.patch.object(r,'_publish_container_capability_proof',side_effect=publish):
                with self.assertRaisesRegex(r.RuntimeServiceError,'changed before mutator'):
                    self.run_recovery(paths,context,cli)
            self.assertEqual(len(calls),1)
            self.assertEqual((paths.runtime_services/'OWNER.json').read_bytes(),before)

    def test_bounded_cli_runner_captures_exact_raw_stdout_without_newline_translation(self):
        with tempfile.TemporaryDirectory() as directory:
            paths,_,_,_=self.fixture(Path(directory)); binary=paths.package/'bin/fullmag-bin'
            payload=b' { "pure": true }\r\n'
            binary.write_text('#!'+sys.executable+'\nimport sys\nsys.stdout.buffer.write('+repr(payload)+')\n')
            captured=[]
            with mock.patch.object(r,'process_environment',return_value=dict(os.environ)):
                value=r._run_cli(paths,('runtime','service-container-recovery-capabilities'),timeout=5,raw_output=captured)
            self.assertEqual(value,{'pure':True});self.assertEqual(captured,[payload])

    def test_capability_proof_partial_write_or_failed_publication_allows_clean_retry(self):
        for failure in ('partial-write','before-publication'):
            with self.subTest(failure=failure),tempfile.TemporaryDirectory() as directory:
                paths,context,_,_=self.fixture(Path(directory))
                proof={'binary_sha256':'1'*64,'capabilities_raw_sha256':'2'*64,'original':'evidence'}
                original_write=os.write; writes=[]
                def partial_write(fd, data):
                    if not writes:
                        writes.append(True)
                        return original_write(fd,data[:5])
                    raise OSError('simulated ENOSPC')
                patcher=mock.patch.object(r.os,'write',side_effect=partial_write) if failure=='partial-write' else mock.patch.object(r.os,'link',side_effect=OSError('simulated interruption before publication'))
                with patcher:
                    with self.assertRaises(OSError):r._publish_container_capability_proof(paths,context,proof)
                destination=paths.runtime_services/'container-recovery'/context['request_sha256']/'native-capabilities'
                self.assertEqual(list(destination.iterdir()),[])
                r._publish_container_capability_proof(paths,context,proof)
                published=list(destination.iterdir());self.assertEqual(len(published),1)
                self.assertEqual(json.loads(published[0].read_bytes()),proof)
                original=published[0].read_bytes()
                with self.assertRaisesRegex(r.RuntimeServiceError,'different bytes'):
                    r._publish_container_capability_proof(paths,context,{**proof,'original':'modified'})
                self.assertEqual(published[0].read_bytes(),original)

    def test_no_follow_actual_package_binary_and_no_store_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            paths,context,cap,_=self.fixture(Path(directory)); binary=paths.package/'bin/fullmag-bin'
            foreign=Path(directory)/'foreign'; foreign.write_bytes(binary.read_bytes()); foreign.chmod(0o755)
            with self.assertRaisesRegex(r.RuntimeServiceError,'actual native package'):
                r._container_recovery_binary_sha(paths,foreign)
            binary.unlink(); binary.symlink_to(foreign)
            with self.assertRaises(r.RuntimeServiceError):r._container_recovery_binary_sha(paths,None)
            with self.assertRaisesRegex(r.RuntimeServiceError,'explicit runtime-control'):
                r._publish_container_capability_proof(r.dataclasses.replace(paths,runtime_services=None),context,{})

    def test_terminal_pin_null_hash_duplicates_and_version_isolation(self):
        pin=self.terminal_pin(); request={'schema_version':r.CONTAINER_RECOVERY_TERMINAL_REQUEST_SCHEMA,'retained_terminal_runs':[pin]}
        self.assertEqual(r._container_recovery_expected_outcome(request),'retained_terminal_runs_recovered')
        self.assertEqual(r._container_recovery_expected_outcome({**request,'retained_terminal_runs':[{**pin,'artifact_catalog_sha256':'3'*64}]}),'retained_terminal_runs_recovered')
        for pins in ([],[pin,pin],[{**pin,'artifact_catalog_sha256':'bad'}],[{key:value for key,value in pin.items() if key!='artifact_catalog_sha256'}]):
            with self.assertRaises(r.RuntimeServiceError):r._container_recovery_expected_outcome({**request,'retained_terminal_runs':pins})
        for schema in (r.CONTAINER_RECOVERY_REQUEST_SCHEMA,'runtime_service_container_recovery_request.v2'):
            with self.assertRaises(r.RuntimeServiceError):r._container_recovery_expected_outcome({**request,'schema_version':schema})
        self.assertEqual(r._container_recovery_expected_outcome({'schema_version':r.CONTAINER_RECOVERY_REQUEST_SCHEMA}),'empty_namespace_recovered')
        cancelled={key:value for key,value in pin.items() if key!='artifact_catalog_sha256'}
        self.assertEqual(r._container_recovery_expected_outcome({'schema_version':'runtime_service_container_recovery_request.v2','retained_cancelled_runs':[cancelled]}),'retained_cancelled_runs_recovered')

    def test_v4_held_manual_pin_pairing_limits_and_v3_isolation(self):
        terminal=self.terminal_pin(); held=self.held_pin()
        request={'schema_version':r.CONTAINER_RECOVERY_HELD_MANUAL_REQUEST_SCHEMA,
                 'retained_terminal_runs':[],'retained_held_manual_runs':[held]}
        self.assertEqual(r._container_recovery_expected_outcome(request),'retained_manual_held_runs_recovered')
        self.assertEqual(r._container_recovery_expected_outcome({**request,'retained_terminal_runs':[terminal]}),
                         'retained_manual_held_runs_recovered')
        for changed in (
            {**request,'retained_held_manual_runs':[]},
            {**request,'retained_held_manual_runs':[{**held,'start_release':'present'}]},
            {**request,'retained_held_manual_runs':[{**held,'unexpected':True}]},
            {**request,'retained_held_manual_runs':[{**held,'run_intent_sha256':'invalid'}]},
            {**request,'retained_terminal_runs':[terminal],'retained_held_manual_runs':[{**held,'run_id':terminal['run_id']}]},
            {**request,'retained_cancelled_runs':[]},
            {**request,'retained_terminal_runs':[terminal]*128},
        ):
            with self.subTest(changed=changed),self.assertRaises(r.RuntimeServiceError):
                r._container_recovery_expected_outcome(changed)
        v3={'schema_version':r.CONTAINER_RECOVERY_TERMINAL_REQUEST_SCHEMA,'retained_terminal_runs':[terminal],
            'retained_held_manual_runs':[held]}
        with self.assertRaises(r.RuntimeServiceError):r._container_recovery_expected_outcome(v3)

    def test_absence_attestation_accepts_exact_v3_terminal_pins(self):
        with tempfile.TemporaryDirectory() as directory:
            paths,context,cap,_=self.fixture(Path(directory)); request=context['request']
            attestation={'schema_version':r.CONTAINER_RECOVERY_ABSENCE_ATTESTATION_SCHEMA,'request_sha256':context['request_sha256'],
                'docker_engine_id_sha256':request['docker_engine_id_sha256'],'manifest_sha256':request['docker_manifest_sha256'],'result':'authoritative_namespace_absence',
                'device_release':{'resource_id':request['device_release_resource_id'],'mapping_sha256':request['device_release_mapping_sha256'],'mapping_detached':True},
                'containers':[{'container_id':pin['container_id'],'image_id':pin['image_id'],'config_sha256':pin['config_sha256'],'service':pin['service'],
                    'absence':{'inspect':{'outcome':'no_such_object','matched_container_id':pin['container_id'],'output_sha256':'1'*64},'ps_all':{'outcome':'empty','output_sha256':'2'*64}}} for pin in request['containers']]}
            r._validate_container_recovery_attestation_document(request,context['request_sha256'],attestation,'a'*64)
            cancelled={key:value for key,value in self.terminal_pin().items() if key!='artifact_catalog_sha256'}
            v2={**request,'schema_version':'runtime_service_container_recovery_request.v2','retained_terminal_runs':None,'retained_cancelled_runs':[cancelled]}
            r._validate_container_recovery_attestation_document(v2,context['request_sha256'],attestation,'a'*64)
            v1={**request,'schema_version':r.CONTAINER_RECOVERY_REQUEST_SCHEMA,'retained_terminal_runs':None}
            with self.assertRaises(r.RuntimeServiceError):r._validate_container_recovery_attestation_document(v1,context['request_sha256'],attestation,'a'*64)
            attestation['containers'][0]['absence']['ps_all']['outcome']='unknown'
            with self.assertRaises(r.RuntimeServiceError):r._validate_container_recovery_attestation_document(request,context['request_sha256'],attestation,'a'*64)

    def test_absence_attestation_accepts_v4_and_request_digest_freezes_held_pins(self):
        with tempfile.TemporaryDirectory() as directory:
            paths,context,cap,_=self.fixture(Path(directory)); request=self.make_v4(context)
            attestation={'schema_version':r.CONTAINER_RECOVERY_ABSENCE_ATTESTATION_SCHEMA,
                'request_sha256':context['request_sha256'],'docker_engine_id_sha256':request['docker_engine_id_sha256'],
                'manifest_sha256':request['docker_manifest_sha256'],'result':'authoritative_namespace_absence',
                'device_release':{'resource_id':request['device_release_resource_id'],'mapping_sha256':request['device_release_mapping_sha256'],'mapping_detached':True},
                'containers':[{'container_id':pin['container_id'],'image_id':pin['image_id'],'config_sha256':pin['config_sha256'],'service':pin['service'],
                    'absence':{'inspect':{'outcome':'no_such_object','matched_container_id':pin['container_id'],'output_sha256':'1'*64},
                               'ps_all':{'outcome':'empty','output_sha256':'2'*64}}} for pin in request['containers']]}
            r._validate_container_recovery_attestation_document(request,context['request_sha256'],attestation,'a'*64)
            request['retained_held_manual_runs']=[{**self.held_pin(),'run_catalog_sha256':'5'*64}]
            changed_sha=r._sha256_bytes(r._canonical_container_recovery_json(request))
            with self.assertRaisesRegex(r.RuntimeServiceError,'request'):
                r._validate_container_recovery_attestation_document(request,changed_sha,attestation,'a'*64)

    def test_v4_actual_capability_gate_precedes_mutator_and_pins_outcome(self):
        with tempfile.TemporaryDirectory() as directory:
            paths,context,cap,_=self.fixture(Path(directory)); request=self.make_v4(context); calls=[]
            raw=(json.dumps(cap,indent=2)+'\n').encode()
            failed=json.dumps({**context['expected_owner'],'state':'failed'}).encode(); receipt=self.receipt(context,failed)
            original=(paths.runtime_services/'OWNER.json').read_bytes()
            def cli(paths,args,*,timeout,cli,raw_output=None):
                calls.append(tuple(args))
                if args[1]=='service-container-recovery-capabilities':
                    raw_output.append(raw);return cap
                (paths.runtime_services/'OWNER.json').write_bytes(failed);return receipt
            result=self.run_recovery(paths,context,cli)
            self.assertEqual(result['outcome'],'retained_manual_held_runs_recovered')
            self.assertEqual([call[1] for call in calls],['service-container-recovery-capabilities','service-recover-container'])
            proof=list(paths.runtime_services.glob('container-recovery/*/native-capabilities/*.json'))
            self.assertEqual(len(proof),1)
            self.assertEqual(json.loads(proof[0].read_bytes())['request_schema'],r.CONTAINER_RECOVERY_HELD_MANUAL_REQUEST_SCHEMA)
            self.assertNotEqual((paths.runtime_services/'OWNER.json').read_bytes(),original)

    def test_v4_requires_actual_native_capability_and_replay_skips_mutator(self):
        with tempfile.TemporaryDirectory() as directory:
            paths,context,cap,_=self.fixture(Path(directory)); self.make_v4(context); cap['supported_recovery_schemas']=[r.CONTAINER_RECOVERY_TERMINAL_REQUEST_SCHEMA]
            calls=[]
            def cli(paths,args,*,timeout,cli,raw_output=None):
                calls.append(tuple(args));raw_output.append(json.dumps(cap).encode());return cap
            with self.assertRaisesRegex(r.RuntimeServiceError,'does not support'):
                self.run_recovery(paths,context,cli)
            self.assertEqual([call[1] for call in calls],['service-container-recovery-capabilities'])
        with tempfile.TemporaryDirectory() as directory:
            paths,context,cap,_=self.fixture(Path(directory)); self.make_v4(context)
            failed=json.dumps({**context['expected_owner'],'state':'failed'}).encode()
            (paths.runtime_services/'OWNER.json').write_bytes(failed)
            receipt=self.receipt(context,failed); target=paths.store/'runtime-services/container-recovery'/context['request_sha256']/'receipt.json'; target.parent.mkdir(parents=True);target.write_text(json.dumps(receipt))
            native=mock.Mock(side_effect=AssertionError('v4 replay must not invoke native or capability probe'))
            self.assertEqual(self.run_recovery(paths,context,native),receipt)
            native.assert_not_called()

    def test_completed_v3_replay_validates_receipt_without_capability_or_native_invocation(self):
        with tempfile.TemporaryDirectory() as directory:
            paths,context,cap,_=self.fixture(Path(directory)); failed=json.dumps({**context['expected_owner'],'state':'failed'}).encode()
            (paths.runtime_services/'OWNER.json').write_bytes(failed)
            receipt=self.receipt(context,failed); target=paths.store/'runtime-services/container-recovery'/context['request_sha256']/'receipt.json'; target.parent.mkdir(parents=True);target.write_text(json.dumps(receipt))
            native=mock.Mock(side_effect=AssertionError('replay must not invoke native'))
            self.assertEqual(self.run_recovery(paths,context,native),receipt)
            native.assert_not_called()

    def test_v1_v2_recovery_keeps_legacy_cli_without_capability_command(self):
        for schema in (r.CONTAINER_RECOVERY_REQUEST_SCHEMA,'runtime_service_container_recovery_request.v2'):
            with self.subTest(schema=schema),tempfile.TemporaryDirectory() as directory:
                paths,context,cap,_=self.fixture(Path(directory)); request=context['request'];request['schema_version']=schema;request.pop('retained_terminal_runs')
                if schema.endswith('.v2'):request['retained_cancelled_runs']=[{key:value for key,value in self.terminal_pin().items() if key!='artifact_catalog_sha256'}]
                failed=json.dumps({**context['expected_owner'],'state':'failed'}).encode();receipt=self.receipt(context,failed); calls=[]
                def cli(paths,args,*,timeout,cli):
                    calls.append(tuple(args));self.assertEqual(args[1],'service-recover-container');(paths.runtime_services/'OWNER.json').write_bytes(failed);return receipt
                self.assertEqual(self.run_recovery(paths,context,cli),receipt)
                self.assertEqual(len(calls),1)

if __name__=='__main__':unittest.main()
