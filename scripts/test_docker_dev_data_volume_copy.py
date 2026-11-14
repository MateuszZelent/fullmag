"""Parent copy sequencing with real small journal files and simulated runtime."""
from contextlib import contextmanager,ExitStack
from contextvars import copy_context
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest import mock

from scripts import docker_dev_data_volume_copy as parent
from scripts.test_fullmag_data_volume_linux_request import valid_request
from scripts.fullmag_data_volume_journal import new_journal,append_started,append_terminal


def encoded(v):return (json.dumps(v,sort_keys=True)+'\n').encode()
def sha(v):return hashlib.sha256(v).hexdigest()


class CopyParentLoadTests(unittest.TestCase):
    def setUp(self):
        self.source=Path(parent.__file__).resolve().parents[1];self.linux=valid_request()
        self.identity={'project_name':'fullmag-worktree-fixture','project_id':'project','worktree_id':'worktree'}
        self.layout={'storage_root':self.linux['storage_root']}
        self.op=Path(self.layout['storage_root'])/'migrations/data-volumes'/self.linux['volume_id']
        self.pins={'attempt':'1'*32,'config_sha256':'2'*64,'backend':'3'*64,'frontend':'4'*64,
            'image_id':'sha256:'+'5'*64,'state_root':self.linux['source_roots']['state']['canonical_root'],
            'runtime_witness_path':'iteration/attempts/'+'6'*32+'/terminal.json','runtime_witness_sha256':'7'*64}
        self.plan={'schema':'fullmag.data-volume-plan.v1','volume_id':self.linux['volume_id'],
            'storage_root':self.layout['storage_root'],'source_root':str(self.source),
            'project_id':'project','worktree_id':'worktree','compose_project':self.identity['project_name'],
            'runtime_pins':self.pins,'mount_root':self.linux['mount_root'],
            'observation':{'datasets':copy.deepcopy(self.linux['source_roots'])}}
        self.provision={'schema':'fullmag.data-volume-linux-provision-result.v1','state':'mounted-not-data-migrated',
            'volume_id':self.linux['volume_id'],'filesystem_uuid':self.linux['filesystem_uuid'],
            'linux_request_sha256':sha(encoded(self.linux)),'namespace_admitted':False}

    def patches(self):
        stack=ExitStack()
        stack.enter_context(mock.patch.object(parent,'select_checkout',return_value=self.source))
        stack.enter_context(mock.patch.object(parent,'validate_host_path'))
        stack.enter_context(mock.patch.object(parent.storage,'resolve_layout',return_value=self.layout))
        stack.enter_context(mock.patch.object(parent,'compose_project_identity',return_value=self.identity))
        stack.enter_context(mock.patch.object(parent,'verify_registered_volume',return_value=None))
        values={'plan.json':self.plan,'linux-provision-request.json':self.linux,'linux-provision-result.json':self.provision}
        stack.enter_context(mock.patch.object(parent.qualification,'_read',side_effect=lambda p,*_:(encoded(values[p.name]),copy.deepcopy(values[p.name]))))
        journal=new_journal(self.linux['volume_id'],sha(encoded(self.plan)))
        for phase in ('image-created','image-attached','ext4-mounted'):
            receipt=sha(encoded(self.provision)) if phase=='ext4-mounted' else 'b'*64
            journal=append_terminal(append_started(journal,phase,'a'*64),'succeeded',receipt)
        stack.enter_context(mock.patch.object(parent.qualification,'_selected_journal',return_value=(self.op/'journal.json',journal)))
        self.sources=stack.enter_context(mock.patch.object(parent.root_copy,'_source_roots'))
        self.mount=stack.enter_context(mock.patch.object(parent.root_copy,'_mounted_root'))
        return stack

    def call(self):return parent._load_source(self.source,self.linux['volume_id'])

    def test_readonly_preflight_requires_exact_completed_formatter_scope(self):
        with self.patches():context=self.call()
        self.assertEqual(context['linux_request_sha256'],sha(encoded(self.linux)))
        self.assertEqual(context['operation_root'],self.op)
        self.mount.assert_called_once();self.sources.assert_called_once()

    def test_foreign_plan_or_admitted_result_is_rejected_before_mount_probe(self):
        for target,key,value in [(self.plan,'source_root','/foreign/worktree'),
                                 (self.provision,'namespace_admitted',True),
                                 (self.provision,'linux_request_sha256','0'*64)]:
            old=target[key];target[key]=value
            try:
                with self.patches(),self.assertRaises(ValueError):self.call()
                self.mount.assert_not_called()
            finally:target[key]=old

    def test_prior_copy_artifact_is_not_replayed(self):
        with self.patches(),mock.patch.object(parent.os.path,'lexists',side_effect=lambda p:Path(p).name=='linux-copy-client.stdout'), \
                self.assertRaisesRegex(ValueError,'never replay'):self.call()
        self.mount.assert_not_called()

    def test_missing_or_foreign_control_volume_refuses_before_any_helper(self):
        with mock.patch.object(parent,'control_volume_name',return_value='fixture-control'), \
                mock.patch.object(parent,'docker_capture',return_value=SimpleNamespace(stdout=b'[]')), \
                mock.patch.object(parent,'BuildControl') as control,self.assertRaisesRegex(ValueError,'existing control'):
            parent._existing_control(self.identity,self.pins['image_id'])
        control.assert_not_called()


class FakeControl:
    def __init__(self):
        self.image='sha256:'+'5'*64;self._active_operation=None;self.inputs=None
        self.op={'receipt':{'phase':'data-volume-migration','attempt':'b'*32},
                 'root':'data-volume-migration/attempts/'+'b'*32,'daemon_pending':False}
    @contextmanager
    def operation(self,phase,inputs):
        assert phase=='data-volume-migration'
        self.inputs=inputs;self._active_operation=self.op
        try:yield self.op
        finally:self._active_operation=None


class FakeFence:
    def __init__(self,control,actual,source,request):
        self.control=control;self.operation=control._active_operation;self.request=request
        self.released=False;self.identifier='c'*64;self.ready={'schema':'held-fixture','token':request['token']}
        self.inside=False
    def __enter__(self):
        self.inside=True;self.operation['daemon_pending']=True;return self
    def __exit__(self,*args):
        self.inside=False
        if args[0] is None:assert self.released
    def finish(self,_sha):self.released=True;self.operation['daemon_pending']=False


class CopyParentSequencingTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.op=Path(self.temp.name);self.source=Path(parent.__file__).resolve().parents[1]
        linux=valid_request();self.volume=linux['volume_id'];self.stop='d'*32;self.stop_sha='e'*64
        self.context={'source':self.source,'layout':{'storage_root':linux['storage_root']},'identity':{},
            'operation_root':self.op,'plan':{'runtime_pins':{'image_id':'sha256:'+'5'*64,'backend':'3'*64,'frontend':'4'*64},
            'provision_request':{'wsl_distro':'Ubuntu2'}},'plan_sha256':'a'*64,'linux':linux,
            'linux_request_sha256':'1'*64,'provision_result_sha256':'2'*64,'journal_path':self.op/'journal.json'}
        journal=new_journal(self.volume,'a'*64)
        for phase in ('image-created','image-attached','ext4-mounted'):
            journal=append_terminal(append_started(journal,phase,'a'*64),'succeeded','2'*64)
        self.context['journal']=journal;(self.op/'journal.json').write_text(json.dumps(journal))
        self.control=FakeControl();self.calls=[]
        self.snapshot={'actual':{'backend':{}},'source_proof':{'native_capture':'retained'},
            'process_receipt_sha256':'f'*64,'consumers':[]}

    def patches(self):
        stack=ExitStack()
        stack.enter_context(mock.patch.object(parent,'_load_source',return_value=self.context))
        stack.enter_context(mock.patch.object(parent,'_existing_control',return_value=self.control))
        stack.enter_context(mock.patch.object(parent,'CopyFence',side_effect=FakeFence))
        fmt=sha((self.source/'scripts/linux_data_volume_format.py').read_bytes())
        original=parent.qualification._read
        def read(path,*args):
            if path.name=='linux-provision-result.json':return b'{}',{'formatter_sha256':fmt}
            return original(path,*args)
        stack.enter_context(mock.patch.object(parent.qualification,'_read',side_effect=read))
        @contextmanager
        def host_lock(_layout):
            self.calls.append('host-held')
            try:yield
            finally:self.calls.append('host-released')
        stack.enter_context(mock.patch.object(parent.storage,'build_lock',side_effect=host_lock))
        self.observe=stack.enter_context(mock.patch.object(parent,'observe_stopped_group',return_value=self.snapshot))
        self.job=stack.enter_context(mock.patch.object(parent,'run_root_copy',side_effect=self.copy_job))
        return stack

    def copy_job(self,fence,source,distro,path,request_sha):
        self.assertTrue(fence.inside);self.assertFalse(fence.released)
        self.assertEqual(self.calls,['host-held'])
        raw=path.read_bytes();self.assertEqual(sha(raw),request_sha);request=json.loads(raw)
        parent.root_copy.validate_request(request)
        current=json.loads((self.op/'journal.json').read_text())
        self.assertEqual(current['events'][-1]['phase'],'group-drained')
        self.assertEqual(current['events'][-1]['state'],'succeeded')
        self.assertEqual(sha((self.op/'copy-fence-ready.json').read_bytes()),request['fence_ready_sha256'])
        self.assertEqual(request['token'],self.control.op['receipt']['attempt'])
        self.assertEqual(source,self.source);self.assertEqual(distro,'Ubuntu2')
        self.assertEqual(self.observe.call_count,2);self.assertIs(self.observe.call_args.kwargs['fence'],fence)
        result={'state':'copied-and-verified-not-switched','receipt_sha256':'9'*64,'result':{'originals_retired':False}}
        fence.finish(result['receipt_sha256']);return result

    def call(self):return parent.copy_data_volume(self.source,self.volume,self.stop,self.stop_sha)

    def test_root_job_begins_only_after_guarded_snapshot_and_closed_request(self):
        with self.patches():terminal=self.call()
        self.assertEqual(terminal['state'],'copied-and-verified-not-switched')
        self.assertEqual(self.calls,['host-held','host-released'])
        self.assertEqual(self.control.op['receipt']['state'],'succeeded')
        self.assertFalse(self.control.op['receipt']['data_migrated'])
        self.assertFalse(self.control.op['receipt']['originals_retired'])

    def test_continuation_keeps_host_lock_but_closes_copy_control_operation(self):
        with self.patches():
            with parent.copied_group(self.source,self.volume,self.stop,self.stop_sha) as copied:
                self.assertEqual(self.calls,['host-held'])
                self.assertIsNone(self.control._active_operation)
                self.assertIs(copied['context'],self.context)
                self.assertEqual(copied['terminal']['receipt_sha256'],'9'*64)
                self.assertEqual(self.control.op['receipt']['state'],'succeeded')
            self.assertEqual(self.calls,['host-held','host-released'])

    def test_only_live_original_copy_scope_in_creator_process_can_continue(self):
        with self.patches():
            with parent.copied_group(self.source,self.volume,self.stop,self.stop_sha) as copied:
                self.assertIs(parent.require_live_copied_group(copied),copied)
                with self.assertRaises(ValueError):parent.require_live_copied_group(dict(copied))
                creator=os.getpid()
                with mock.patch.object(parent.os,'getpid',return_value=creator+1),self.assertRaises(ValueError):
                    parent.require_live_copied_group(copied)
                inherited=copy_context();failures=[]
                def other_thread():
                    try:inherited.run(parent.require_live_copied_group,copied)
                    except ValueError as error:failures.append(error)
                thread=threading.Thread(target=other_thread);thread.start();thread.join(timeout=5)
                self.assertFalse(thread.is_alive());self.assertEqual(len(failures),1)
            with self.assertRaises(ValueError):parent.require_live_copied_group(copied)

    def test_mutating_a_live_scope_invalidates_its_original_bound_inputs(self):
        with self.patches():
            with parent.copied_group(self.source,self.volume,self.stop,self.stop_sha) as copied:
                copied['terminal']['receipt_sha256']='0'*64
                with self.assertRaises(ValueError):parent.require_live_copied_group(copied)

    @unittest.skipUnless(os.name=='posix','POSIX flock contract')
    def test_other_process_cannot_enter_until_continuation_finishes_even_on_error(self):
        actual_lock=parent.storage.build_lock
        storage_root=self.op/'storage';(storage_root/'locks').mkdir(parents=True)
        lock_layout={'storage_root':str(storage_root),'worktree_id':'fixture'}
        probe=[sys.executable,'-B','-c',
            'import fcntl,sys; f=open(sys.argv[1],"a+b"); '
            'fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)',str(storage_root/'locks/fixture.lock')]
        @contextmanager
        def tracked_lock(_layout):
            with actual_lock(lock_layout):
                self.calls.append('host-held')
                try:yield
                finally:self.calls.append('host-released')
        with self.patches(),mock.patch.object(parent.storage,'build_lock',side_effect=tracked_lock):
            with self.assertRaisesRegex(RuntimeError,'cutover refused'):
                with parent.copied_group(self.source,self.volume,self.stop,self.stop_sha):
                    blocked=subprocess.run(probe,capture_output=True,text=True,timeout=10)
                    self.assertNotEqual(blocked.returncode,0)
                    self.assertIn('BlockingIOError',blocked.stderr)
                    self.assertIsNone(self.control._active_operation)
                    raise RuntimeError('cutover refused')
        free=subprocess.run(probe,capture_output=True,text=True,timeout=10)
        self.assertEqual(free.returncode,0,free.stderr)
        self.assertEqual(self.calls,['host-held','host-released'])

    def test_native_snapshot_failure_cannot_launch_root_or_publish_a_drain(self):
        with self.patches(),mock.patch.object(parent,'observe_stopped_group',side_effect=ValueError('stop changed')),self.assertRaisesRegex(ValueError,'stop changed'):
            self.call()
        self.job.assert_not_called();self.assertFalse((self.op/'group-drained.json').exists())

    def test_state_changed_while_acquiring_fences_refuses_before_root_job(self):
        changed=copy.deepcopy(self.snapshot);changed['source_proof']={'native_capture':'changed'}
        with self.patches(),mock.patch.object(parent,'observe_stopped_group',side_effect=[self.snapshot,changed]),self.assertRaisesRegex(ValueError,'Terminal source state changed'):
            self.call()
        self.job.assert_not_called();self.assertTrue(self.control.op['daemon_pending'])
        self.assertFalse((self.op/'linux-copy-request.json').exists())


if __name__=='__main__':unittest.main()
