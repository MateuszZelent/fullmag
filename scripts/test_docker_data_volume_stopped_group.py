"""Snapshot authentication with fake daemon/native records; no host operations."""
from contextlib import ExitStack
import copy
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

from scripts import docker_data_volume_stopped_group as snapshot


class StoppedCopySourceTests(unittest.TestCase):
    def setUp(self):
        self.source=Path('/selected/worktree')
        self.control=mock.Mock(project='fullmag-worktree-fixture',volume='fixture-control',image='sha256:'+'f'*64)
        self.operation={'receipt':{'phase':'data-volume-migration','attempt':'e'*32},'helper_container_id':'c'*64}
        self.control._active_operation=self.operation
        self.roots={'state':Path('/srv/storage/state'),'user_data':Path('/srv/storage/user')}
        self.pins={'attempt':'1'*32,'config_sha256':'2'*64,'state_root':str(self.roots['state']),
            'backend':'a'*64,'frontend':'b'*64,'image_id':self.control.image,
            'runtime_witness_path':'iteration/attempts/'+'3'*32+'/terminal.json','runtime_witness_sha256':'4'*64}
        self.actuals=[]
        for service,key in [('backend','a'),('frontend','b')]:
            mounts=[{'Type':'bind','Source':str(self.source),'Destination':'/opt/fullmag/source','RW':False}]
            if service=='backend':mounts += [
                {'Type':'bind','Source':str(self.roots['state']),'Destination':'/state','RW':True},
                {'Type':'bind','Source':str(self.roots['user_data']),'Destination':'/user-data','RW':True}]
            self.actuals.append({'Id':key*64,'Image':self.control.image,
                'Config':{'Labels':{'com.docker.compose.project':self.control.project,'com.docker.compose.service':service}},
                'HostConfig':{'NanoCpus':40000000000},'Mounts':mounts,
                'State':{'Status':'exited','Running':False,'Pid':0,'StartedAt':'2026-11-12T01:00:00Z',
                         'Dead':False,'Paused':False,'Restarting':False,'OOMKilled':False}})
        self.actuals.append({'Id':'c'*64,'Config':{'Labels':{'com.docker.compose.project':self.control.project}},'Mounts':[]})
        self.plan={'source_root':str(self.source),'compose_project':self.control.project,'volume_id':'9'*32,
            'runtime_pins':self.pins,'observation':{'datasets':{},'services':{
              service:{'fingerprint':snapshot.fingerprint(a),'started_at':a['State']['StartedAt']}
              for service,a in zip(('backend','frontend'),self.actuals[:2])}}}
        self.stop='5'*32;self.stop_sha='6'*64;self.process_sha='7'*64

    def daemon(self,*args):
        if args[0]=='ps':return SimpleNamespace(stdout=('\n'.join(a['Id'] for a in self.actuals)+'\n').encode())
        self.assertEqual(args[0],'inspect')
        return SimpleNamespace(stdout=json.dumps(self.actuals).encode())

    def patches(self):
        stack=ExitStack()
        stack.enter_context(mock.patch.object(snapshot,'_original_roots',return_value=self.roots))
        stack.enter_context(mock.patch.object(snapshot,'docker_capture',side_effect=self.daemon))
        stack.enter_context(mock.patch.object(snapshot,'_migration_bind_identity',side_effect=lambda v,*_:(Path(v),None)))
        stack.enter_context(mock.patch.object(snapshot,'_control_bytes',return_value=json.dumps({'process_receipt_sha256':self.process_sha}).encode()))
        stack.enter_context(mock.patch.object(snapshot,'_store_reader',return_value=mock.Mock()))
        self.proof=stack.enter_context(mock.patch.object(snapshot,'build_captured_proof',return_value={'operation_sha256':self.stop_sha}))
        self.validate=stack.enter_context(mock.patch.object(snapshot,'validate_empty_stop'))
        return stack

    def call(self,**kwargs):
        return snapshot.observe_stopped_group(self.control,self.source,self.plan,self.stop,self.stop_sha,**kwargs)

    def test_only_exact_stopped_pair_and_live_lease_reach_native_stop_validation(self):
        with self.patches():result=self.call()
        self.assertEqual(result['process_receipt_sha256'],self.process_sha)
        self.assertEqual(set(result['actual']),{'backend','frontend'})
        self.assertEqual(self.validate.call_args.kwargs['stop_pin'],(self.stop,self.stop_sha))
        self.assertEqual(self.validate.call_args.kwargs['attempt'],self.pins['attempt'])
        self.assertGreaterEqual(self.control._assert_live_operation_helper.call_count,2)
        self.control.write.assert_not_called()

    def test_restart_or_configuration_drift_refuses_before_native_reads(self):
        for target,key,value in [(self.actuals[0]['State'],'StartedAt','changed'),
                                 (self.actuals[0]['State'],'Running',True),
                                 (self.actuals[0]['State'],'Pid',False),
                                 (self.actuals[0]['HostConfig'],'NanoCpus',1)]:
            old=target[key];target[key]=value
            try:
                with self.patches(),self.assertRaisesRegex(ValueError,'incarnation'):self.call()
                self.proof.assert_not_called()
            finally:target[key]=old

    def add_consumer(self,source=None,own_group=False):
        other={'Id':'d'*64,'Config':{'Labels':{'com.docker.compose.project':self.control.project if own_group else 'foreign'}},
               'Mounts':[],'State':{'Status':'exited','Pid':0,'Running':False}}
        if source:other['Mounts']=[{'Type':'bind','Source':source,'Destination':'/data','RW':False}]
        self.actuals.append(other);return other

    def test_even_stopped_readonly_dataset_references_block_copy(self):
        self.add_consumer(str(self.roots['state']/'results'))
        with self.patches(),self.assertRaisesRegex(ValueError,'dataset-bind-reference'):self.call()
        self.proof.assert_not_called()

    def test_control_volume_or_extra_group_reference_is_not_implicitly_owned(self):
        other=self.add_consumer(own_group=True)
        with self.patches(),self.assertRaisesRegex(ValueError,'additional-group-resource'):self.call()
        other['Config']['Labels']['com.docker.compose.project']='foreign'
        other['Mounts']=[{'Type':'volume','Name':self.control.volume,'Destination':'/data'}]
        with self.patches(),self.assertRaisesRegex(ValueError,'control-volume-reference'):self.call()

    def test_unproved_foreign_bind_refuses_but_proven_disjoint_stopped_windows_bind_can_pass(self):
        self.add_consumer('C:/gone/foreign')
        def physical(v,*_):
            if v.startswith('C:'):raise ValueError('unproved ancestor')
            return Path(v),None
        with self.patches(),mock.patch.object(snapshot,'_migration_bind_identity',side_effect=physical),self.assertRaisesRegex(ValueError,'unproven-bind-identity'):self.call()
        def qualified(v,*_):
            if v.startswith('C:'):return None,{'fixed_filesystem_proved':True}
            return Path(v),None
        with self.patches(),mock.patch.object(snapshot,'_migration_bind_identity',side_effect=qualified):result=self.call()
        self.assertEqual(len(result['stopped_windows_bind_proofs']),1)

    def test_fence_is_rechecked_and_only_its_exact_helper_is_exempt(self):
        self.add_consumer(own_group=True)
        fence=SimpleNamespace(control=self.control,operation=self.operation,
            request={'volume_id':self.plan['volume_id'],'token':self.operation['receipt']['attempt']},
            identifier='d'*64,check=mock.Mock())
        with self.patches():self.call(fence=fence)
        self.assertEqual(fence.check.call_count,2)
        fence.operation=copy.deepcopy(self.operation)
        with self.patches(),self.assertRaisesRegex(ValueError,'Foreign live copy fence'):self.call(fence=fence)

    def test_failed_native_capture_does_not_get_substituted_by_a_new_proof(self):
        with self.patches(),mock.patch.object(snapshot,'validate_empty_stop',side_effect=ValueError('stop CAS changed')),self.assertRaisesRegex(ValueError,'CAS'):
            self.call()
        self.assertEqual(self.proof.call_count,1)


if __name__=='__main__':unittest.main()
