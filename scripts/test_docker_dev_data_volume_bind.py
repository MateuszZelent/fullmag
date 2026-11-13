"""Copy-to-bind sequencing under the same live host scope; no real runtime."""
from contextlib import ExitStack
import copy
import hashlib
import json
from unittest import TestCase,main,mock

from scripts import docker_dev_data_volume_copy as copy_parent
from scripts import test_docker_dev_data_volume_copy as fixtures
from scripts import linux_data_volume_bind as root_bind


class BindParentTests(TestCase):
    def scenario(self):
        case=fixtures.CopyParentSequencingTests();case.setUp();self.addCleanup(case.doCleanups)
        return case

    def test_saved_snapshot_cannot_open_a_cutover_operation(self):
        from scripts import docker_dev_data_volume_bind as bind
        with mock.patch.object(bind,'_existing_control') as control,self.assertRaises(ValueError):
            bind.bind_copied_group({'context':{},'terminal':{}})
        control.assert_not_called()

    def test_bind_operation_retains_outer_host_scope_and_rechecks_stopped_group(self):
        from scripts import docker_dev_data_volume_bind as bind
        case=self.scenario();control=fixtures.FakeControl();control.op['receipt']['attempt']='c'*32
        context=dict(case.context,copy_request_sha256='7'*64,copy_receipt_sha256='9'*64,
                     drain={'stop_attempt':case.stop,'stop_sha256':case.stop_sha,'process_receipt_sha256':'f'*64})
        seen=[]
        def root_job(fence,source,distro,path,digest):
            self.assertEqual(case.calls,['host-held'])
            self.assertIsNone(case.control._active_operation)
            self.assertIs(control._active_operation,control.op)
            self.assertTrue(fence.inside);self.assertFalse(fence.released)
            raw=path.read_bytes();self.assertEqual(hashlib.sha256(raw).hexdigest(),digest)
            request=json.loads(raw);root_bind.validate_request(request)
            self.assertEqual(request['token'],'c'*32)
            self.assertEqual(request['copy_receipt_sha256'],'9'*64)
            self.assertEqual(request['fence_ready_sha256'],hashlib.sha256((case.op/'bind-fence-ready.json').read_bytes()).hexdigest())
            self.assertEqual(observer.call_count,2)
            self.assertIs(observer.call_args.kwargs['fence'],fence)
            seen.append(request);fence.finish('9'*64)
            return {'state':'binds-switched-not-admitted','receipt_sha256':'8'*64,'result':{'namespace_admitted':False}}
        with case.patches():
            with copy_parent.copied_group(case.source,case.volume,case.stop,case.stop_sha) as copied:
                with ExitStack() as stack:
                    loader=stack.enter_context(mock.patch.object(bind,'_load_completed',return_value=context))
                    stack.enter_context(mock.patch.object(bind,'_existing_control',return_value=control))
                    stack.enter_context(mock.patch.object(bind,'CopyFence',side_effect=fixtures.FakeFence))
                    observer=stack.enter_context(mock.patch.object(bind,'observe_stopped_group',return_value=case.snapshot))
                    stack.enter_context(mock.patch.object(bind,'run_root_bind',side_effect=root_job))
                    result=bind.bind_copied_group(copied)
                self.assertEqual(result['terminal']['receipt_sha256'],'8'*64)
                self.assertEqual(case.calls,['host-held'])
                self.assertIsNone(control._active_operation)
                self.assertGreaterEqual(loader.call_count,2)
            self.assertEqual(case.calls,['host-held','host-released'])
        self.assertEqual(len(seen),1)
        self.assertFalse(control.op['receipt']['namespace_admitted'])
        self.assertFalse(control.op['receipt']['originals_retired'])

    def test_changed_native_snapshot_refuses_before_request_or_root_spawn(self):
        from scripts import docker_dev_data_volume_bind as bind
        case=self.scenario();control=fixtures.FakeControl();control.op['receipt']['attempt']='c'*32
        context=dict(case.context,copy_request_sha256='7'*64,copy_receipt_sha256='9'*64,
                     drain={'stop_attempt':case.stop,'stop_sha256':case.stop_sha,'process_receipt_sha256':'f'*64})
        changed=copy.deepcopy(case.snapshot);changed['source_proof']={'different':True}
        with case.patches():
            with copy_parent.copied_group(case.source,case.volume,case.stop,case.stop_sha) as copied:
                with mock.patch.object(bind,'_load_completed',return_value=context), \
                     mock.patch.object(bind,'_existing_control',return_value=control), \
                     mock.patch.object(bind,'CopyFence',side_effect=fixtures.FakeFence), \
                     mock.patch.object(bind,'observe_stopped_group',side_effect=[case.snapshot,changed]) as observe, \
                     mock.patch.object(bind,'run_root_bind') as job,self.assertRaisesRegex(ValueError,'Terminal source state changed'):
                    bind.bind_copied_group(copied)
                self.assertEqual(observe.call_count,2)
                job.assert_not_called()
                self.assertFalse((case.op/'linux-bind-request.json').exists())
                self.assertEqual(case.calls,['host-held'])


class CompletedCopyLoadTests(TestCase):
    def setUp(self):
        from scripts import docker_dev_data_volume_bind as bind
        self.bind=bind;self.case=fixtures.CopyParentLoadTests();self.case.setUp()
        self.case.provision['formatter_sha256']=hashlib.sha256(
            (self.case.source/'scripts/linux_data_volume_format.py').read_bytes()).hexdigest()
        self.stack=ExitStack();self.addCleanup(self.stack.close)
        self.stack.enter_context(self.case.patches())
        self.previous=self.case.call()
        encode=fixtures.encoded;sha=fixtures.sha
        self.drain={'volume_id':self.case.linux['volume_id'],'token':'b'*32,
            'plan_sha256':self.previous['plan_sha256'],'source_roots':self.case.linux['source_roots'],
            'containers':{k:self.case.plan['runtime_pins'][k] for k in ('backend','frontend')},
            'stop_attempt':'c'*32,'stop_sha256':'d'*64,'process_receipt_sha256':'e'*64}
        self.request={'schema':copy_parent.root_copy.SCHEMA,'volume_id':self.case.linux['volume_id'],
            'storage_root':self.case.layout['storage_root'],'token':'b'*32,
            'linux_request_sha256':self.previous['linux_request_sha256'],
            'provision_result_sha256':self.previous['provision_result_sha256'],
            'drain_sha256':sha(encode(self.drain)),'fence_ready_sha256':'f'*64,
            'components':copy_parent._pins(self.case.source,copy_parent.root_copy.COMPONENTS)}
        self.terminal={'state':'copied-and-verified-not-switched','receipt_sha256':'9'*64,
            'result':{'request_sha256':sha(encode(self.request))}}
        self.scope={'context':self.previous,'terminal':self.terminal}
        self.values={'plan.json':self.case.plan,'linux-provision-request.json':self.case.linux,
            'linux-provision-result.json':self.case.provision,'linux-copy-request.json':self.request,
            'group-drained.json':self.drain}
        def read(path,expected=None):
            value=self.values[path.name];raw=encode(value)
            if expected is not None:self.assertEqual(sha(raw),expected)
            return raw,copy.deepcopy(value)
        self.stack.enter_context(mock.patch.object(bind.copy_parent,'require_live_copied_group',return_value=self.scope))
        self.stack.enter_context(mock.patch.object(bind,'select_checkout',return_value=self.case.source))
        self.stack.enter_context(mock.patch.object(bind,'compose_project_identity',return_value=self.case.identity))
        self.stack.enter_context(mock.patch.object(bind,'verify_registered_volume',return_value=None))
        self.stack.enter_context(mock.patch.object(bind.qualification,'_read',side_effect=read))
        self.validated=self.stack.enter_context(mock.patch.object(bind,'copy_terminal',return_value=self.terminal))
        self.case.sources.reset_mock();self.case.mount.reset_mock()

    def test_reloads_original_plan_request_copy_terminal_and_mount_before_continuation(self):
        loaded=self.bind._load_completed(object())
        self.assertEqual(loaded['copy_receipt_sha256'],'9'*64)
        self.assertEqual(loaded['copy_request_sha256'],self.terminal['result']['request_sha256'])
        self.validated.assert_called_once()
        self.case.sources.assert_called_once();self.case.mount.assert_called_once()

    def test_changed_original_plan_refuses_before_source_or_mount_probe(self):
        self.case.plan['source_root']='/another/checkout'
        with self.assertRaisesRegex(ValueError,'Original plan'):self.bind._load_completed(object())
        self.case.sources.assert_not_called();self.case.mount.assert_not_called()

    def test_changed_terminal_or_component_bytes_are_not_treated_as_the_live_copy(self):
        with mock.patch.object(self.bind,'copy_terminal',return_value=dict(self.terminal,receipt_sha256='0'*64)), \
                self.assertRaisesRegex(ValueError,'live copy terminal'):
            self.bind._load_completed(object())
        changed=dict(self.request['components'],**{'fullmag_data_volume.py':'0'*64})
        with mock.patch.object(self.bind.copy_parent,'_pins',return_value=changed), \
                self.assertRaisesRegex(ValueError,'component source changed'):
            self.bind._load_completed(object())
        self.case.sources.assert_not_called();self.case.mount.assert_not_called()

    def test_foreign_journal_header_refuses_before_terminal_validation_or_mount_probe(self):
        for key,value in [('volume_id','f'*32),('request_sha256','0'*64)]:
            journal={'volume_id':self.request['volume_id'],'request_sha256':self.previous['plan_sha256']}
            journal[key]=value
            with self.subTest(key=key),mock.patch.object(self.bind.qualification,'_selected_journal',
                    return_value=(self.previous['journal_path'],journal)), \
                    self.assertRaisesRegex(ValueError,'journal scope'):
                self.bind._load_completed(object())
        self.validated.assert_not_called()
        self.case.sources.assert_not_called();self.case.mount.assert_not_called()


if __name__=='__main__':main()
