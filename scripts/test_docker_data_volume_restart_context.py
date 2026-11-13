"""Retained migrated restart inputs; real issuer, simulated control/namespace."""
from contextlib import ExitStack
from copy import deepcopy
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

import docker_data_volume_restart_context as restart
import docker_data_volume_startup_scope as startup
from scripts.test_docker_data_volume_startup_scope import StartupScopeFixture


def encoded(value):
    return restart.canonical(value)+b'\n'


class Records:
    def __init__(self, source, state, project='compose-fixture'):
        from docker_dev import OPERATOR_PROBE_ENVIRONMENT_DEFAULTS
        operator=restart.volume._operator_probe_record(OPERATOR_PROBE_ENVIRONMENT_DEFAULTS)
        self.control=SimpleNamespace(project=project,volume='fixture-volume',image='sha256:'+'5'*64,
            namespace='',namespace_registry=None)
        self.document={'name':project,'services':{
            'backend':{'gpus':'all','command':['start','--native-contract','fem-demag-poisson'],
                'environment':{'FULLMAG_DOCKER_DEVICE_ACCESS':'gpu','FULLMAG_SESSION_STORAGE_PROFILE':'linux-native-v1',
                    'FULLMAG_DEVELOPMENT_INPUTS_PATH':'/opt/fullmag/control/frontend/development-inputs.json',
                    'FULLMAG_OPERATOR_PROBE_ENVIRONMENT_SHA256':operator['operator_probe_environment_sha256'],
                    **operator['operator_probe_environment']}},
            'frontend':{'ports':[{'host_ip':'127.0.0.1','target':8080,'protocol':'tcp','mode':'ingress','published':'3274'}],
                'environment':{'FULLMAG_FRONTEND_HOST_PORT':'3274',
                    'FULLMAG_DEVELOPMENT_INPUTS_PATH':'/opt/fullmag/control/development-inputs.json'},
                'volumes':[{'source':'build-control','target':'/opt/fullmag/control','volume':{'subpath':'frontend'}}]}}}
        self.pin={'attempt':'1'*32,'config_sha256':hashlib.sha256(restart.canonical(self.document)).hexdigest(),
            'backend':'3'*64,'frontend':'4'*64,'image_id':self.control.image,'state_root':str(state),
            'runtime_witness_path':'development/attempts/'+'1'*32+'/terminal.json','runtime_witness_sha256':'0'*64}
        self.cold={'journal_relative':'verification/historical-budget.json','journal_sha256':hashlib.sha256(encoded({'budget':'preserved'})).hexdigest()}
        self.previous={'phase':'development','state':'succeeded','attempt':self.pin['attempt'],
            'compose_project':project,'control_volume':self.control.volume,'state_root':str(state),
            'config_sha256':self.pin['config_sha256'],'backend_container':self.pin['backend'],
            'frontend_container':self.pin['frontend'],'ledger_profile':'group-ledger-v1','ui_mode':'gui',
            'url':'http://127.0.0.1:3274','cold_budget_restore':self.cold,
            'terminal_observation':{'historical':'must-be-rebuilt'},**operator,
            'inputs':{'source_root':str(source),'image_id':self.control.image,'gpu_access_requested':'required',
                'device_access':'gpu','gpu_preflight':'PASS','ui_mode':'gui','native_contracts':['fem-demag-poisson']}}
        self.actual={role:{'Id':self.pin[role],'Image':self.control.image} for role in ('backend','frontend')}
        self.snapshot={'actual':self.actual,'source_proof':{'run':'retained'},'process_receipt_sha256':'f'*64}
        self.context={'source':source,'plan':{'runtime_pins':self.pin}}
        self.records={}; self.refresh()

    def refresh(self):
        self.pin['config_sha256']=hashlib.sha256(restart.canonical(self.document)).hexdigest()
        self.previous['config_sha256']=self.pin['config_sha256']
        base='development/attempts/'+self.pin['attempt']
        self.records[base+'/terminal.json']=encoded(self.previous)
        self.records[base+'/compose.json']=encoded(self.document)
        self.pin['runtime_witness_sha256']=hashlib.sha256(self.records[base+'/terminal.json']).hexdigest()
        self.records[self.cold['journal_relative']]=encoded({'budget':'preserved'})

    def read(self, _control, path, *, optional=False):
        if path in self.records:return self.records[path]
        if optional:return None
        raise FileNotFoundError(path)

    def patches(self):
        stack=ExitStack()
        stack.enter_context(mock.patch.object(restart,'_read',side_effect=self.read))
        stack.enter_context(mock.patch.object(restart.volume,'_retained_recovery_context',
            return_value={'cold_budget_restore':deepcopy(self.cold)}))
        stack.enter_context(mock.patch.object(restart.cold,'authenticate_journal',
            return_value={'observation':{'source_root':str(self.context['source'])}}))
        return stack


class RetainedInputsTests(unittest.TestCase):
    def scenario(self):
        return Records(Path(restart.__file__).resolve().parents[1],Path('/srv/storage/state'))

    def test_retained_gpu_port_contracts_operator_and_carried_budget_are_preserved(self):
        case=self.scenario()
        with case.patches(),mock.patch.dict('os.environ',{'FULLMAG_GPU_ACCESS':'disabled'}):
            previous,document,pins,absent,recovery=restart._retained_records(case.control,case.context,case.snapshot)
            arguments,kwargs,details=restart._arguments(case.context,previous,document,recovery)
        self.assertEqual(arguments['port'],3274);self.assertEqual(arguments['gpu_access'],'required')
        self.assertIsNone(arguments['script']);self.assertEqual(arguments['profile'],'dev')
        self.assertEqual(arguments['native_contract'],['fem-demag-poisson'])
        self.assertEqual(kwargs['retained_device_access'],'gpu');self.assertTrue(kwargs['capture_terminal'])
        self.assertEqual(kwargs['cold_budget_restore'],case.cold)
        self.assertNotIn('previous_config_sha256',kwargs)
        self.assertIsNone(details['previous_config_sha256'])
        self.assertEqual(kwargs['reuse_state']['state'],Path(case.pin['state_root']))
        self.assertIn(case.pin['runtime_witness_path'],pins)
        self.assertTrue(absent)

    def test_runtime_record_drift_wrong_ledger_or_recovery_refuses(self):
        for variant in ('witness','ledger','namespace','recovery','device','operator','port'):
            with self.subTest(variant=variant):
                case=self.scenario()
                if variant=='witness':case.pin['runtime_witness_sha256']='0'*64
                elif variant=='ledger':case.previous['ledger_profile']='host-ledger-v1';case.refresh()
                elif variant=='namespace':case.previous['control_namespace']='namespaces/'+'a'*32;case.refresh()
                elif variant=='recovery':case.previous['accepted_reattach']={};case.refresh()
                elif variant=='device':case.document['services']['backend']['environment']['FULLMAG_DOCKER_DEVICE_ACCESS']='cpu';case.refresh()
                elif variant=='operator':case.previous['operator_probe_environment_sha256']='0'*64;case.refresh()
                else:case.document['services']['frontend']['ports'][0]['host_ip']='0.0.0.0';case.refresh()
                with case.patches(),self.assertRaises((ValueError,RuntimeError)):
                    values=restart._retained_records(case.control,case.context,case.snapshot)
                    restart._arguments(case.context,values[0],values[1],values[4])

    def test_current_backend_cold_stop_is_not_confused_with_historical_carried_pin(self):
        case=self.scenario()
        case.records[restart.cold._paths(case.pin['backend'])[0]]=b'current-cold-stop'
        with case.patches(),self.assertRaisesRegex(ValueError,'Current-backend cold'):
            restart._retained_records(case.control,case.context,case.snapshot)

    def test_context_cannot_be_prepared_from_a_saved_dictionary(self):
        control=mock.Mock()
        with self.assertRaises(ValueError):restart.prepare_context(control,{'context':{}},{},fence=object())
        control._assert_live_operation_helper.assert_not_called()


class LiveContextTests(unittest.TestCase):
    def setUp(self):
        self.fixture=StartupScopeFixture(self)
        self.case=Records(self.fixture.case.source,self.fixture.state_root)
        self.fixture.context['plan'].update(runtime_pins=self.case.pin,source_root=str(self.case.context['source']),
            compose_project=self.case.control.project,observation={'engine_id':'engine-fixture'})
        self.fixture.native_before={'certificate_inode':[1,2,3,4,1],
            'candidate_raw':encoded({'owner_token':'8'*32})}
        self.fixture.root_rows['state']['bound_identity']={'device':101,'inode':202}
        self.prepared=self.fixture.issue()
        self.control=self.fixture.control
        for name in ('project','volume','image','namespace','namespace_registry'):
            setattr(self.control,name,getattr(self.case.control,name))
        self.operation={'receipt':{'phase':'data-volume-migration','attempt':'d'*32},
            'root':'data-volume-migration/attempts/'+'d'*32,'lease_ready':True,'daemon_pending':True}
        self.control._active_operation=self.operation
        self.control._assert_live_operation_helper=mock.Mock(return_value='e'*64)
        self.fence=SimpleNamespace(control=self.control,operation=self.operation,relocated=self.prepared['relocated'],
            request={'token':'d'*32,'volume_id':self.fixture.case.volume,'process_receipt_sha256':'f'*64},
            released=False,check=mock.Mock())
        self.stack=ExitStack();self.addCleanup(self.stack.close)
        self.stack.enter_context(self.fixture.validator_patch())
        self.scope_stack=ExitStack();self.stack.callback(self.scope_stack.close)
        self.scope_stack.enter_context(startup.startup_scope(self.prepared))
        self.stack.enter_context(self.case.patches())
        self.meta={'schema':'fullmag.terminal-observation-context.v1','proof_sha256':'9'*64,
            'request_sha256':'8'*64,'stop_attempt':self.fixture.case.stop,'stop_sha256':self.fixture.case.stop_sha}
        self.observation={'environment':{'REQUEST':'guest-relative'},'metadata':self.meta}
        self.view={'old_roots':{'state':self.fixture.state_root.parent/'old-backup'}}
        self.stack.enter_context(mock.patch.object(restart,'require_relocated',return_value=self.view))
        self.prepare=self.stack.enter_context(mock.patch.object(restart.observation,'prepare_captured_context',return_value=self.observation))
        self.revalidate=self.stack.enter_context(mock.patch.object(restart.observation,'revalidate_context'))
        self.original_read=self.case.read
        def read(control,path,*,optional=False):
            if path.endswith('/proof.json'):return b'fresh-proof'
            if path.endswith('/request.json'):return b'fresh-request'
            return self.original_read(control,path,optional=optional)
        self.meta['proof_sha256']=hashlib.sha256(b'fresh-proof').hexdigest()
        self.meta['request_sha256']=hashlib.sha256(b'fresh-request').hexdigest()
        self.stack.enter_context(mock.patch.object(restart,'_read',side_effect=read))

    def prepare_context(self):
        return restart.prepare_context(self.control,self.prepared,self.case.snapshot,fence=self.fence)

    def test_fresh_observation_uses_old_backup_under_same_fence_and_start_is_one_shot(self):
        context=self.prepare_context()
        self.prepare.assert_called_once()
        self.assertEqual(self.prepare.call_args.kwargs['store_root'],self.view['old_roots']['state']/'runs/docker-all/session-store')
        self.assertIs(self.prepare.call_args.kwargs['owned_operation'],self.operation)
        self.assertEqual(self.prepare.call_args.kwargs['attempt'],self.case.pin['attempt'])
        with self.assertRaisesRegex(ValueError,'closed successful'):restart.start_arguments(context)
        self.operation['receipt']['state']='succeeded';self.operation['daemon_pending']=False
        self.control._active_operation=None;self.fence.released=True
        args,kwargs=restart.start_arguments(context)
        self.assertIsNone(args.script);self.assertEqual(kwargs['terminal_observation'],self.observation)
        self.assertEqual(kwargs['cold_budget_restore'],self.case.cold)
        self.assertNotIn('previous_config_sha256',kwargs)
        with self.assertRaises(ValueError):restart.start_arguments(context)

    def test_revalidation_refuses_changed_control_record_and_unissued_context(self):
        context=self.prepare_context()
        self.case.records[self.case.cold['journal_relative']]=b'foreign'
        with self.assertRaisesRegex(ValueError,'record changed'):
            restart.revalidate_context(self.control,self.prepared,context,self.case.snapshot,fence=self.fence)
        clone=restart._RestartContext(self.control,self.prepared,context._scope,self.operation,self.fence,context._values)
        with self.assertRaisesRegex(ValueError,'not issued'):restart.require_context(clone)

    def started(self):
        context=self.prepare_context()
        self.operation['receipt']['state']='succeeded';self.operation['daemon_pending']=False
        self.control._active_operation=None;self.fence.released=True
        restart.start_arguments(context)
        document=deepcopy(self.case.document)
        document['services']['backend']['environment']['FULLMAG_STARTUP_ENABLED']='0'
        receipt=deepcopy(self.case.previous)
        receipt.update(attempt='2'*32,backend_container='a'*64,frontend_container='b'*64,
            source_commit=context._values['source_commit'],source_snapshot_sha256='6'*64,
            backend_build_receipt_sha256='7'*64,terminal_observation=self.meta,
            config_sha256=hashlib.sha256(restart.canonical(document)).hexdigest())
        relative='development/attempts/'+'2'*32+'/terminal.json'
        self.case.records[relative]=encoded(receipt)
        self.case.records['development/attempts/'+'2'*32+'/compose.json']=encoded(document)
        certificate={'schema':restart.host.HOST_SCHEMA,'storage_profile':'linux-native-v1',
            'restart_verified':True,'host_root':str(self.fixture.state_root),'host_device':101,'host_inode':202,
            'image_id':self.control.image,'engine_id':'engine-fixture','owner_token':'8'*32}
        self.cert_raw=encoded(certificate)
        self.stack.enter_context(mock.patch.object(restart.host,'read_owned_regular',side_effect=lambda _path:self.cert_raw))
        self.stack.enter_context(mock.patch.object(restart.host,'_readmission_certificate_inode',
            return_value=self.prepared['native_before']['certificate_inode']))
        captured={'schema':'fullmag.development-start-terminal.v1','relative':relative,
            'sha256':hashlib.sha256(encoded(receipt)).hexdigest(),'receipt':receipt}
        return context,captured,document

    def test_started_evidence_is_bound_to_exact_capture_and_fresh_in_place_certificate(self):
        context,captured,_document=self.started()
        result=restart.validate_started(self.control,self.prepared,context,captured)
        self.assertTrue(result['namespace_admitted']);self.assertFalse(result['data_migrated'])
        self.assertFalse(result['originals_retired'])
        self.assertEqual(result['development_terminal']['sha256'],captured['sha256'])

    def test_wrong_started_receipt_or_native_readiness_never_qualifies(self):
        context,captured,_document=self.started()
        for variant in ('digest','old_id','context','native','inode'):
            with self.subTest(variant=variant):
                changed=deepcopy(captured);raw=self.cert_raw
                if variant=='digest':changed['sha256']='0'*64
                elif variant=='old_id':changed['receipt']['backend_container']=self.case.pin['backend']
                elif variant=='context':changed['receipt']['cold_budget_restore']=None
                elif variant=='native':
                    certificate=json.loads(raw);certificate['restart_verified']=False;self.cert_raw=encoded(certificate)
                else:
                    with mock.patch.object(restart.host,'_readmission_certificate_inode',return_value=[1,99,3,4,1]),self.assertRaises(ValueError):
                        restart.validate_started(self.control,self.prepared,context,changed)
                    continue
                try:
                    with self.assertRaises(ValueError):restart.validate_started(self.control,self.prepared,context,changed)
                finally:self.cert_raw=raw

    def test_matching_certificate_pair_cannot_change_or_lose_the_old_owner_token(self):
        context,captured,_document=self.started()
        for token in ('9'*32,None):
            with self.subTest(token=token):
                certificate=json.loads(self.cert_raw)
                if token is None:certificate.pop('owner_token',None)
                else:certificate['owner_token']=token
                self.cert_raw=encoded(certificate)
                with self.assertRaisesRegex(ValueError,'certificate|owner'):
                    restart.validate_started(self.control,self.prepared,context,captured)

    def test_coherent_new_compose_cannot_change_the_retained_port(self):
        context,captured,document=self.started()
        document['services']['frontend']['ports'][0]['published']='3347'
        document['services']['frontend']['environment']['FULLMAG_FRONTEND_HOST_PORT']='3347'
        captured['receipt']['url']='http://127.0.0.1:3347'
        captured['receipt']['config_sha256']=hashlib.sha256(restart.canonical(document)).hexdigest()
        self.case.records['development/attempts/'+'2'*32+'/compose.json']=encoded(document)
        self.case.records[captured['relative']]=encoded(captured['receipt'])
        captured['sha256']=hashlib.sha256(self.case.records[captured['relative']]).hexdigest()
        with self.assertRaisesRegex(ValueError,'intent|port'):
            restart.validate_started(self.control,self.prepared,context,captured)

    def test_started_readback_after_scope_does_not_grant_another_start(self):
        context,captured,_document=self.started()
        evidence=restart.validate_started(self.control,self.prepared,context,captured)
        self.scope_stack.close()
        self.assertIsNone(startup.current_scope())
        self.assertEqual(restart.revalidate_started(self.control,self.prepared,context,evidence),evidence)
        with self.assertRaises(ValueError):restart.start_arguments(context)
        with self.assertRaises(ValueError):restart.validate_started(self.control,self.prepared,context,captured)
        self.case.records[captured['relative']]=b'changed runtime terminal'
        with self.assertRaises(ValueError):restart.revalidate_started(self.control,self.prepared,context,evidence)


if __name__ == '__main__':
    unittest.main()
