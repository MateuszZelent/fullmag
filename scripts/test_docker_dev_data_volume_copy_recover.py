"""Host recovery grants continuation only after a fresh guarded terminal."""
from contextlib import ExitStack,contextmanager
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from scripts import docker_dev_data_volume_copy_recover as parent
from scripts import docker_dev_data_volume_copy as copy_parent
from scripts.test_docker_dev_data_volume_copy import FakeControl,FakeFence
from scripts import test_linux_data_volume_copy as copy_fixtures
from scripts.test_linux_data_volume_copy import digest
from scripts.fullmag_data_volume_journal import append_started,append_terminal


class FailedScopeTests(unittest.TestCase):
    def fixture(self):
        f=copy_fixtures.CopyContextTests();f.setUp()
        failure={'schema':'fullmag.data-volume-linux-copy-failure.v1','state':'failed-confirmed',
            'volume_id':f.request['volume_id'],'token':f.request['token'],'request_sha256':'f'*64,
            'error_type':'ValueError','originals_and_partial_copy_retained':True}
        f.evidence['linux-copy-started.json']={'schema':'fullmag.data-volume-copy-started.v1',
            'volume_id':f.request['volume_id'],'token':f.request['token'],'request_sha256':'f'*64}
        f.expected['linux-copy-started.json']=None
        raw=(json.dumps(failure,sort_keys=True)+'\n').encode();failure_sha=digest(raw)
        journal=append_terminal(append_started(f.journal,'copy-verified','f'*64),'failed-confirmed',failure_sha)
        journal_path=f.op/'recovery'/('7'*32)/'journal.json'
        journal_raw=(json.dumps(journal,sort_keys=True)+'\n').encode();journal_sha=digest(journal_raw)
        context={'source':Path(parent.__file__).resolve().parents[1],'layout':{'storage_root':f.request['storage_root'],'worktree_id':'fixture'},
            'identity':{},'operation_root':f.op,'plan':f.plan,'plan_sha256':digest(f.plan_raw),
            'linux':f.linux,'provision':f.provision,'linux_request_sha256':f.request['linux_request_sha256'],
            'provision_result_sha256':f.request['provision_result_sha256']}
        def read(path,expected=None):
            if path==journal_path:
                self.assertEqual(expected,journal_sha);return journal_raw,copy.deepcopy(journal)
            if path==f.op/'linux-copy-failed.json':
                self.assertEqual(expected,failure_sha);return raw,copy.deepcopy(failure)
            return f.read(path,expected)
        return f,context,failure,journal_path,journal,journal_sha,failure_sha,read

    def test_unknown_failure_cannot_be_used_to_requalify_a_copy(self):
        f,context,failure,path,journal,journal_sha,failure_sha,read=self.fixture()
        for field,value in [('state','outcome-unknown-resources-retained'),('token','9'*32),
                            ('request_sha256','0'*64),('originals_and_partial_copy_retained',False)]:
            old=failure[field];failure[field]=value
            try:
                with mock.patch.object(parent.copy_parent,'_load_base_source',return_value=context), \
                     mock.patch.object(parent.qualification,'_read',side_effect=read), \
                     mock.patch.object(parent.qualification,'_selected_journal',return_value=(path,journal)), \
                     mock.patch.object(parent.root_copy,'_mounted_root') as mounted, \
                     self.assertRaises(ValueError):
                    parent._load_failed(context['source'],f.request['volume_id'],'f'*64,failure_sha,journal_sha)
                mounted.assert_not_called()
            finally:failure[field]=old

    def test_exact_failed_scope_keeps_original_drain_and_never_enters_mount_mutation(self):
        f,context,failure,path,journal,journal_sha,failure_sha,read=self.fixture()
        with mock.patch.object(parent.copy_parent,'_load_base_source',return_value=context), \
             mock.patch.object(parent.qualification,'_read',side_effect=read), \
             mock.patch.object(parent.qualification,'_selected_journal',return_value=(path,journal)), \
             mock.patch.object(parent.root_copy,'_source_roots'),mock.patch.object(parent.root_copy,'_mounted_root'):
            result=parent._load_failed(context['source'],f.request['volume_id'],'f'*64,failure_sha,journal_sha)
        self.assertEqual(result['drain'],f.drain)
        self.assertEqual(result['prefix']['events'],journal['events'][:8])
        self.assertEqual(result['failed_journal_path'],path)

    def test_later_bind_or_prior_recovery_intent_refuses_before_root_probe(self):
        f,context,failure,path,journal,journal_sha,failure_sha,read=self.fixture()
        for name in ('linux-bind-request.json','copy-recovery-prepared.json'):
            with mock.patch.object(parent.copy_parent,'_load_base_source',return_value=context), \
                 mock.patch.object(parent.qualification,'_read',side_effect=read), \
                 mock.patch.object(parent.qualification,'_selected_journal',return_value=(path,journal)), \
                 mock.patch.object(parent.os.path,'lexists',side_effect=lambda p:Path(p).name==name), \
                 mock.patch.object(parent.root_copy,'_mounted_root') as mounted,self.assertRaisesRegex(ValueError,'never replay'):
                parent._load_failed(context['source'],f.request['volume_id'],'f'*64,failure_sha,journal_sha)
            mounted.assert_not_called()


class RecoveryContinuationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        op=Path(self.temp.name)
        self.source=Path(parent.__file__).resolve().parents[1];self.control=FakeControl()
        self.context={'source':self.source,'layout':{},'identity':{},'operation_root':op,
            'linux':{'volume_id':'1'*32,'mount_root':'/mnt/retained-copy',
                'source_roots':{'state':{'device':1,'inode':2},'user_data':{'device':1,'inode':3}}},
            'plan':{'runtime_pins':{'image_id':self.control.image},'provision_request':{'wsl_distro':'Ubuntu2'}},
            'drain':{'stop_attempt':'d'*32,'stop_sha256':'e'*64,'process_receipt_sha256':'9'*64}}
        self.terminal={'state':'copied-and-verified-not-switched','receipt_sha256':'a'*64,
            'result':{'schema':'fullmag.data-volume-linux-copy-result.v2'}}
        self.snapshot={'process_receipt_sha256':'9'*64,'source_proof':{'immutable':True},'actual':{'backend':{}}}
        self.fences=[]
    def patches(self,*,fail=False,probe_refusal=False):
        stack=ExitStack()
        stack.enter_context(mock.patch.object(parent,'_load_failed',return_value=self.context))
        stack.enter_context(mock.patch.object(parent.storage,'build_lock',return_value=ExitStack()))
        stack.enter_context(mock.patch.object(parent.copy_parent,'_existing_control',return_value=self.control))
        stack.enter_context(mock.patch.object(parent,'_confirmed_prior_client'))
        self.observer=stack.enter_context(mock.patch.object(parent,'observe_stopped_group',return_value=self.snapshot))
        stack.enter_context(mock.patch.object(parent.copy_parent,'_pins',side_effect=lambda _s,n:{p:'f'*64 for p in n}))
        def prepare_probe(*args):
            self.assertEqual(self.fences,[])
            self.assertIsNotNone(self.control._active_operation)
            if probe_refusal:raise ValueError('private manifest already exists')
            return {'readiness':'only'}
        self.probe=stack.enter_context(mock.patch.object(parent,'_prepare_probe',side_effect=prepare_probe))
        self.publish=stack.enter_context(mock.patch.object(parent,'_prepare',return_value=(self.context['operation_root'],'c'*64)))
        def fence(*args):
            value=FakeFence(*args);self.fences.append(value);return value
        stack.enter_context(mock.patch.object(parent,'CopyFence',side_effect=fence))
        def job(held,*args):
            self.assertTrue(held.inside)
            self.assertIs(self.control._active_operation,held.operation)
            held.finish(self.terminal['receipt_sha256'])
            if fail:raise RuntimeError('confirmed failed recovery')
            return self.terminal
        self.job=stack.enter_context(mock.patch.object(parent.recovery_job,'run_root_recovery',side_effect=job))
        return stack
    def call(self):return parent.recover_copied_group(self.source,'1'*32,'2'*64,'3'*64,'4'*64)
    def test_new_genuine_scope_is_live_only_after_ack_and_inside_original_host_context(self):
        with self.patches():
            with self.call() as scope:
                self.assertIs(copy_parent.require_live_copied_group(scope),scope)
                self.assertEqual(scope['terminal'],self.terminal)
                self.assertTrue(self.fences[0].released)
                self.assertIsNone(self.control._active_operation)
            with self.assertRaises(ValueError):copy_parent.require_live_copied_group(scope)
        self.job.assert_called_once()
        self.assertEqual(self.observer.call_count,2)
        self.assertTrue(all(c.kwargs['extra_consumer_roots']==(Path('/mnt/retained-copy'),) for c in self.observer.call_args_list))
    def test_root_probe_refusal_precedes_native_guard_selector_and_copy_client(self):
        with self.patches(probe_refusal=True),mock.patch.object(copy_parent,'_CopiedGroupScope') as mint:
            with self.assertRaisesRegex(ValueError,'private manifest'):
                with self.call():self.fail('refused readiness yielded a capability')
        self.assertEqual(self.fences,[])
        self.assertEqual(self.observer.call_count,1)
        self.publish.assert_not_called();self.job.assert_not_called();mint.assert_not_called()

    def test_confirmed_failed_recovery_does_not_issue_a_continuation(self):
        with self.patches(fail=True),mock.patch.object(copy_parent,'_CopiedGroupScope') as mint:
            with self.assertRaisesRegex(RuntimeError,'confirmed failed recovery'):
                with self.call():self.fail('failure yielded a copied-group capability')
        mint.assert_not_called();self.job.assert_called_once()


if __name__=='__main__':unittest.main()
