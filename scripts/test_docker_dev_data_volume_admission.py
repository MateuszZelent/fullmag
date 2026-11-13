"""Admission parent sequencing with real live-copy scope and simulated Docker."""
from contextlib import ExitStack
import copy
import hashlib
import json
from unittest import TestCase,main,mock

from scripts import docker_dev_data_volume_copy as copy_parent
from scripts import test_docker_dev_data_volume_copy as fixtures


class AdmissionParentTests(TestCase):
    def scenario(self):
        case=fixtures.CopyParentSequencingTests();case.setUp();self.addCleanup(case.doCleanups)
        return case

    def test_saved_copy_snapshot_cannot_create_an_admission_operation(self):
        from scripts import docker_dev_data_volume_admission as parent
        with mock.patch.object(parent,'_existing_control') as control,self.assertRaises(ValueError):
            parent.prepare_bound_group({'context':{},'terminal':{}},{'context':{},'terminal':{}})
        control.assert_not_called()

    def test_operation_uses_old_view_fence_under_original_host_scope(self):
        from scripts import docker_dev_data_volume_admission as parent
        case=self.scenario();control=fixtures.FakeControl();control.op['receipt']['attempt']='c'*32
        context=dict(case.context,copy_receipt_sha256='9'*64,
            drain={'stop_attempt':case.stop,'stop_sha256':case.stop_sha,'process_receipt_sha256':'f'*64})
        bound={'context':context,'terminal':{'receipt_sha256':'8'*64,'result':{'request_sha256':'7'*64}}}
        relocated=object()
        class Fence(fixtures.FakeFence):
            def __init__(self,*args,relocated=None):super().__init__(*args);self.relocated=relocated
        native_before={'new_files':{'certificate':b'captured-before-root'}}
        def job(fence,source,distro,path,digest,*,retain_native_snapshot=False):
            self.assertTrue(retain_native_snapshot)
            self.assertEqual(case.calls,['host-held']);self.assertIsNone(case.control._active_operation)
            self.assertIs(control._active_operation,control.op);self.assertIs(fence.relocated,relocated)
            self.assertTrue(fence.inside);self.assertFalse(fence.released)
            request=json.loads(path.read_bytes());self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(),digest)
            parent.root_admission.validate_request(request)
            self.assertEqual(request['bind_receipt_sha256'],'8'*64);self.assertEqual(request['bind_request_sha256'],'7'*64)
            self.assertEqual(request['token'],'c'*32)
            self.assertEqual(request['fence_ready_sha256'],hashlib.sha256((case.op/'admission-fence-ready.json').read_bytes()).hexdigest())
            fence.finish('9'*64)
            return ({'state':'admission-prepared-not-admitted','receipt_sha256':'6'*64,
                'result':{'namespace_admitted':False,'data_migrated':False,'originals_retired':False}},native_before)
        with case.patches(),copy_parent.copied_group(case.source,case.volume,case.stop,case.stop_sha) as copied:
            with ExitStack() as stack:
                stack.enter_context(mock.patch.object(parent,'_load_bound',return_value=(context,relocated)))
                stack.enter_context(mock.patch.object(parent,'_check_bound'))
                stack.enter_context(mock.patch.object(parent,'_existing_control',return_value=control))
                stack.enter_context(mock.patch.object(parent,'CopyFence',side_effect=Fence))
                observer=stack.enter_context(mock.patch.object(parent,'observe_stopped_group',return_value=case.snapshot))
                stack.enter_context(mock.patch.object(parent,'run_root_admission',side_effect=job))
                result=parent.prepare_bound_group(copied,bound)
                self.assertIs(parent.require_prepared_group(result),result)
                with self.assertRaises(ValueError):parent.require_prepared_group(dict(result))
                original=result['terminal']['state'];result['terminal']['state']='changed'
                with self.assertRaises(ValueError):parent.require_prepared_group(result)
                result['terminal']['state']=original
                result['native_before']['new_files']['certificate']=b'changed'
                with self.assertRaises(ValueError):parent.require_prepared_group(result)
                self.assertEqual(native_before['new_files']['certificate'],b'captured-before-root')
                result['native_before']['new_files']['certificate']=b'captured-before-root'
                forged=parent._PreparedGroup(copied,context,bound['terminal'],result['terminal'],relocated,native_before)
                with self.assertRaises(ValueError):parent.require_prepared_group(forged)
                with self.assertRaisesRegex(ValueError,'already prepared'):parent.prepare_bound_group(copied,bound)
            self.assertEqual(result['terminal']['receipt_sha256'],'6'*64);self.assertEqual(case.calls,['host-held'])
            self.assertIsNone(control._active_operation);self.assertEqual(observer.call_count,2)
            self.assertTrue(all(call.kwargs['relocated'] is relocated for call in observer.call_args_list))
        self.assertEqual(case.calls,['host-held','host-released'])
        self.assertFalse(control.op['receipt']['namespace_admitted']);self.assertFalse(control.op['receipt']['data_migrated'])
        with self.assertRaises(ValueError):parent.require_prepared_group(result)

    def test_changed_stopped_proof_refuses_before_root_request_or_spawn(self):
        from scripts import docker_dev_data_volume_admission as parent
        case=self.scenario();control=fixtures.FakeControl();context=dict(case.context,copy_receipt_sha256='9'*64,
            drain={'stop_attempt':case.stop,'stop_sha256':case.stop_sha,'process_receipt_sha256':'f'*64})
        bound={'context':context,'terminal':{'receipt_sha256':'8'*64,'result':{'request_sha256':'7'*64}}}
        changed=copy.deepcopy(case.snapshot);changed['source_proof']={'changed':True}
        class Fence(fixtures.FakeFence):
            def __init__(self,*args,relocated=None):super().__init__(*args);self.relocated=relocated
        with case.patches(),copy_parent.copied_group(case.source,case.volume,case.stop,case.stop_sha) as copied:
            with mock.patch.object(parent,'_load_bound',return_value=(context,object())), \
                 mock.patch.object(parent,'_check_bound'),mock.patch.object(parent,'_existing_control',return_value=control), \
                 mock.patch.object(parent,'CopyFence',side_effect=Fence), \
                 mock.patch.object(parent,'observe_stopped_group',side_effect=[case.snapshot,changed]), \
                 mock.patch.object(parent,'run_root_admission') as job,self.assertRaisesRegex(ValueError,'Terminal source'):
                parent.prepare_bound_group(copied,bound)
            job.assert_not_called();self.assertFalse((case.op/'linux-admission-request.json').exists())


class AdmissionParentLoadTests(TestCase):
    def setUp(self):
        from scripts import docker_dev_data_volume_admission as parent
        from scripts.test_linux_data_volume_admission import AdmissionLoadScenario
        self.parent=parent;self.case=AdmissionLoadScenario(self)
        case=self.case
        self.context={'source':case.source,'layout':{'storage_root':case.linux['storage_root']},'identity':{},
            'operation_root':case.op,'linux':case.linux,'plan':case.plan,'copy_request':case.copy_request,
            'copy_receipt_sha256':case.copy_sha,'copy_request_sha256':case.copy_request_sha,'drain':case.copy.drain}
        self.copied={'context':self.context,'terminal':{'receipt_sha256':case.copy_sha}}
        self.bound={'context':self.context,'terminal':{'receipt_sha256':case.bind_sha,'result':case.bind_result}}
        self.relocated=object();self.stack=ExitStack();self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch.object(parent.copy_parent,'require_live_copied_group',return_value=self.copied))
        self.maker=self.stack.enter_context(mock.patch.object(parent.bind_parent,'relocated_copied_group',return_value=self.relocated))
        self.stack.enter_context(mock.patch.object(parent,'_check_bound'))
        self.stack.enter_context(mock.patch.object(parent.qualification,'_read',side_effect=case.read))

    def test_reload_compares_extra_bound_fields_to_immutable_copy_and_drain(self):
        context,relocated=self.parent._load_bound(self.copied,self.bound)
        self.assertIs(relocated,self.relocated);self.assertEqual(context,self.context)
        self.maker.assert_called_once_with(self.copied,self.bound)

    def test_forged_extra_drain_or_copy_sha_refuses_before_any_control_operation(self):
        for key,value in [('drain',{'forged':True}),('copy_request_sha256','9'*64),('copy_receipt_sha256','8'*64)]:
            original=self.context[key];self.context[key]=value
            try:
                with self.subTest(key=key),mock.patch.object(self.parent,'_existing_control') as control, \
                        self.assertRaisesRegex(ValueError,'immutable copy/drain'):
                    self.parent._load_bound(self.copied,self.bound)
                control.assert_not_called()
            finally:self.context[key]=original

    def test_existing_admission_artifacts_refuse_replay(self):
        with mock.patch.object(self.parent.os.path,'lexists',return_value=True),self.assertRaisesRegex(ValueError,'previous artifacts'):
            self.parent._load_bound(self.copied,self.bound)

    def test_bound_operation_root_cannot_move_to_another_storage_scope(self):
        self.context['operation_root']=self.context['operation_root'].parent/'other'
        with self.assertRaisesRegex(ValueError,'selected storage scope'):
            self.parent._load_bound(self.copied,self.bound)


if __name__=='__main__':main()
