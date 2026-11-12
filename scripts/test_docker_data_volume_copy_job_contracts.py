"""Exact root-copy argv and terminal receipt contracts; no WSL/Docker/mounts."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

from scripts import docker_data_volume_copy_job as job
from scripts import test_linux_data_volume_copy as fixtures
from scripts import test_docker_data_volume_copy_job as lifecycle
from scripts.test_fullmag_data_volume_linux_request import valid_request
from scripts.fullmag_data_volume_journal import append_started,append_terminal


class CopyCommandContracts(unittest.TestCase):
    def setUp(self):
        self.f=fixtures.CopyContextTests();self.f.setUp()
        self.source=Path(job.__file__).resolve().parents[1]
        self.identity={'project_name':'fullmag-worktree-fixture','project_id':'project','worktree_id':'worktree'}
        self.f.plan.update(source_root=str(self.source),project_id='project',worktree_id='worktree',
            compose_project=self.identity['project_name'],provision_request={'wsl_distro':'Ubuntu2'})
        self.image='sha256:'+'a'*64;self.f.plan['runtime_pins']['image_id']=self.image
        operation={'receipt':{'phase':'data-volume-migration','attempt':self.f.request['token']},'daemon_pending':True}
        control=SimpleNamespace(project=self.identity['project_name'],image=self.image,_active_operation=operation)
        self.fence=SimpleNamespace(operation=operation,control=control,
            request={'token':self.f.request['token'],'volume_id':self.f.request['volume_id'],
              'source_roots':{k:{n:v[n] for n in ('device','inode')} for k,v in self.f.linux['source_roots'].items()}},
            ready=self.f.ready,released=False)

    def patches(self):
        from contextlib import ExitStack
        stack=ExitStack()
        stack.enter_context(mock.patch.object(job.qualification,'_read',side_effect=self.f.read))
        stack.enter_context(mock.patch.object(job.storage,'resolve_layout',return_value={'storage_root':self.f.request['storage_root']}))
        stack.enter_context(mock.patch.object(job,'compose_project_identity',return_value=self.identity))
        self.wsl=stack.enter_context(mock.patch.object(job,'_wsl_executable',return_value='/mnt/c/Windows/System32/wsl.exe'))
        return stack

    def call(self,distro='Ubuntu2'):
        return job.prepare_command(self.fence,self.source,distro,self.f.path,'f'*64)

    def test_argv_is_literal_and_bound_to_current_components_and_scope(self):
        with self.patches():argv,op,request=self.call()
        self.assertEqual(argv[:8],['/mnt/c/Windows/System32/wsl.exe','--distribution','Ubuntu2',
            '--user','root','--exec','/usr/bin/python3','-B'])
        self.assertEqual(argv[8:], [str(self.source/'scripts/linux_data_volume_copy.py'),
            '--request',str(self.f.path),'--request-sha256','f'*64])
        self.assertEqual(op,self.f.op);self.assertEqual(request,self.f.request)

    def test_another_distro_or_injected_option_does_not_reach_root_executable(self):
        for distro in ('OtherDistro','Ubuntu2; touch sentinel','Ubuntu2 --user root'):
            with self.patches(),self.subTest(distro=distro),self.assertRaises(ValueError):self.call(distro)
            self.wsl.assert_not_called()

    def test_foreign_scope_or_ready_ack_is_refused_before_root_argv(self):
        changes=[(self.f.plan,'worktree_id','foreign'),(self.f.linux,'volume_id','e'*32),
                 (self.f.ready,'state','released')]
        # The live acknowledgement is separate from the persisted test value.
        original_ready=copy.deepcopy(self.fence.ready)
        self.fence.ready=original_ready
        for target,key,value in changes:
            old=target[key];target[key]=value
            try:
                with self.patches(),self.subTest(key=key),self.assertRaises(ValueError):self.call()
                self.wsl.assert_not_called()
            finally:target[key]=old

    def test_component_hash_drift_is_rejected_before_any_root_execution(self):
        self.f.request['components']['fullmag_data_volume_fs.py']='0'*64
        with self.patches(),self.assertRaisesRegex(ValueError,'component source changed'):self.call()
        self.wsl.assert_not_called()


class CopyTerminalContracts(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.op=Path(self.temp.name)
        self.linux=valid_request();self.req_sha='d'*64
        self.request={'volume_id':self.linux['volume_id'],'token':'b'*32,
            'linux_request_sha256':self.write('linux-provision-request.json',self.linux)}
        target=Path(self.linux['mount_root']);archive=target/'migration'/self.linux['volume_id']
        self.success={'schema':'fullmag.data-volume-linux-copy-result.v1','state':'copied-and-verified-not-switched',
            'volume_id':self.request['volume_id'],'token':self.request['token'],'request_sha256':self.req_sha,
            'filesystem_uuid':self.linux['filesystem_uuid'],'data_sha256':'1'*64,'manifest_sha256':'2'*64,'archive_sha256':'3'*64,
            'manifest_path':str(archive/'source-manifest.json'),'archive_path':str(archive/'originals.pax'),
            'copied_roots':{k:str(target/'payload'/Path(v['canonical_root']).relative_to(self.linux['storage_root'])) for k,v in self.linux['source_roots'].items()},
            'namespace_admitted':False,'originals_retired':False}
        self.failure={'schema':'fullmag.data-volume-linux-copy-failure.v1','state':'failed-confirmed',
            'volume_id':self.request['volume_id'],'token':self.request['token'],'request_sha256':self.req_sha,
            'error_type':'OSError','originals_and_partial_copy_retained':True}
        self.journal=fixtures.journal_to_copy(self.request['volume_id'],'a'*64,'b'*64,'c'*64)

    def write(self,name,value):
        raw=(json.dumps(value,sort_keys=True)+'\n').encode();(self.op/name).write_bytes(raw)
        return hashlib.sha256(raw).hexdigest()

    def terminal(self,value,*,failure=False,state=None):
        receipt=self.write('linux-copy-failed.json' if failure else 'linux-copy-result.json',value)
        journal=append_terminal(append_started(self.journal,'copy-verified',self.req_sha),
            state or ('failed-confirmed' if failure else 'succeeded'),receipt)
        self.write('journal.json',journal)
        return receipt

    def call(self,code):return job.validate_terminal(self.op,self.request,self.req_sha,code)

    def test_exact_success_requires_zero_exit_and_matching_full_journal_receipt(self):
        sha=self.terminal(self.success)
        self.assertEqual(self.call(0)['receipt_sha256'],sha)
        for code in (None,False,1):
            with self.subTest(code=code),self.assertRaises(ValueError):self.call(code)

    def test_only_confirmed_root_failure_with_nonzero_exit_is_terminal(self):
        sha=self.terminal(self.failure,failure=True)
        self.assertEqual(self.call(1)['receipt_sha256'],sha)
        self.assertEqual(self.call(-15)['state'],'failed-confirmed')
        with self.assertRaises(ValueError):self.call(0)

    def test_unknown_or_late_partial_publication_cannot_release(self):
        self.failure['state']='outcome-unknown-resources-retained'
        self.terminal(self.failure,failure=True,state=self.failure['state'])
        with self.assertRaises(ValueError):self.call(1)
        self.terminal(self.success)
        with self.assertRaises(ValueError):self.call(0)

    def test_an_early_result_file_without_terminal_journal_is_not_completion(self):
        self.write('linux-copy-result.json',self.success)
        self.write('journal.json',append_started(self.journal,'copy-verified',self.req_sha))
        with self.assertRaises(ValueError):self.call(0)

    def test_replaced_result_bytes_or_foreign_copied_path_are_refused(self):
        self.terminal(self.success)
        changed=dict(self.success,token='e'*32);self.write('linux-copy-result.json',changed)
        with self.assertRaisesRegex(ValueError,'SHA'):self.call(0)
        changed=copy.deepcopy(self.success);changed['copied_roots']['state']='/foreign/data'
        self.terminal(changed)
        with self.assertRaisesRegex(ValueError,'paths'):self.call(0)


class CopyDiagnosticInterruptContracts(unittest.TestCase):
    def check_interrupted_diagnostic(self,*,during_spawn):
        fixture=lifecycle.Scenario(self)
        first_error=RuntimeError('initial metadata observation failed') if during_spawn else OSError('initial poll failed')
        process=lifecycle.FakeProcess(fixture.events,[None,0] if during_spawn else [first_error,None,0])
        if during_spawn:fixture.fence.control.write.side_effect=[first_error,None]
        caught=None
        with fixture.patched_runtime(process,lifecycle.success_terminal()), \
                mock.patch.object(job,'print',side_effect=KeyboardInterrupt()):
            try:job.run_root_copy(fixture.fence,fixture.source,fixture.distro,fixture.request_path,fixture.request_sha256,poll_interval=.01)
            except BaseException as error:caught=error
        self.assertIs(caught,first_error)
        self.assertTrue(process.waited)
        self.assertEqual(fixture.fence.finish_calls,[lifecycle.SUCCESS_SHA256])
        self.assertFalse(fixture.operation['daemon_pending'])
        self.assertFalse(process.terminated or process.killed)

    def test_second_interrupt_during_prior_error_diagnostic_cannot_unwind_live_copy(self):
        self.check_interrupted_diagnostic(during_spawn=True)

    def test_second_interrupt_during_poll_error_diagnostic_cannot_unwind_live_copy(self):
        self.check_interrupted_diagnostic(during_spawn=False)


if __name__=='__main__':unittest.main()
