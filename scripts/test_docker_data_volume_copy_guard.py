"""Parent lifecycle/argv contracts with mocked Docker and no subprocess spawn."""
import copy
import hashlib
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

from scripts import docker_data_volume_copy_guard as guard


class ParentCopyFenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.source = Path(self.temp.name); (self.source/'scripts').mkdir()
        self.control = mock.Mock(project='fullmag-worktree-fixture', image='sha256:'+'a'*64, namespace='')
        self.actual = {'Image':self.control.image, 'State':{'Status':'exited', 'Running':False, 'Pid':0,
            'Dead':False,'Paused':False,'Restarting':False,'OOMKilled':False,'ExitCode':137},
            'Config':{'Labels':{'com.docker.compose.project':self.control.project,'com.docker.compose.service':'backend'}},
            'Mounts':[{'Destination':'/opt/fullmag/source','Type':'bind','RW':False,'Source':'/retained/source-alias'}]}
        self.request = {'schema':'fullmag.data-copy-fence-request.v1','token':'b'*32,'volume_id':'c'*32,
            'process_receipt_sha256':'d'*64,'source_roots':{'state':{'device':1,'inode':2},'user_data':{'device':1,'inode':3}},'components':{}}
        for name in guard.COMPONENTS:
            path = self.source/'scripts'/name; path.write_bytes(b'# private fixture\n')
            self.request['components'][name] = hashlib.sha256(path.read_bytes()).hexdigest()
        self.base = ['docker','run','--rm','-i','--memory','64m','--user','65532:65532',
            '--label','com.docker.compose.service=host-runtime-maintenance','--entrypoint','/usr/local/bin/python3',
            self.control.image,'-B','-c','old read-only helper']

    def patches(self):
        stack = __import__('contextlib').ExitStack()
        stack.enter_context(mock.patch.object(guard,'live_bind_path',return_value=self.source))
        stack.enter_context(mock.patch.object(guard,'readonly_mount',side_effect=lambda _a,target:'type=bind,src=/retained'+target+',dst='+target+',readonly'))
        stack.enter_context(mock.patch.object(guard,'_runtime_control_validation_helper',side_effect=lambda *_:list(self.base)))
        return stack

    def test_no_gpu_no_write_and_no_signal_proxy_in_scoped_helper_arguments(self):
        with self.patches():
            args = guard.copy_fence_arguments(self.control,self.actual,self.source,self.request)
        self.assertIn('--sig-proxy=false',args)
        self.assertNotIn('--gpus',args)
        mounts = [args[i+1] for i,v in enumerate(args[:-1]) if v=='--mount']
        self.assertEqual(len(mounts),4)
        self.assertTrue(all(value.endswith(',readonly') for value in mounts))
        self.assertEqual(args[-4],self.control.image)
        self.assertIn('data_volume_copy_fence_service.main()',args[-1])
        self.assertEqual(args[args.index('--memory')+1],'256m')

    def test_live_backend_is_rejected_before_any_daemon_probe(self):
        self.actual['State'].update(Status='running',Running=True,Pid=42)
        with mock.patch.object(guard,'_runtime_control_validation_helper') as helper, self.assertRaisesRegex(ValueError,'stopped'):
            guard.copy_fence_arguments(self.control,self.actual,self.source,self.request)
        helper.assert_not_called()

    def test_source_drift_is_rejected_before_any_daemon_probe(self):
        (self.source/'scripts'/guard.COMPONENTS[0]).write_text('# changed')
        with self.patches(), mock.patch.object(guard,'_runtime_control_validation_helper') as helper, \
                self.assertRaisesRegex(ValueError,'component changed'):
            guard.copy_fence_arguments(self.control,self.actual,self.source,self.request)
        helper.assert_not_called()

    def make_guard(self):
        with self.patches():
            handle = guard.CopyFence(self.control,self.actual,self.source,self.request)
        self.operation = {'receipt':{'phase':'data-volume-migration','attempt':self.request['token']},
                          'daemon_pending':False,'root':'data-volume-migration/attempts/'+self.request['token']}
        self.control._active_operation = self.operation
        self.process = mock.Mock(stdin=io.BytesIO()); self.process.poll.return_value = None
        self.process.wait.return_value = 0
        self.helper = {'Id':'e'*64,'Image':self.control.image,
            'State':{'Running':True,'StartedAt':'2026-11-12T00:00:00.000000001Z','Pid':42},
            'Config':{'Labels':{'com.docker.compose.project':self.control.project,'com.docker.compose.service':'data-volume-copy-fence'},
                      'Cmd':handle.args[-3:],'Entrypoint':['/usr/local/bin/python3'],'User':'65532:65532'},
            'HostConfig':{'ReadonlyRootfs':True,'NetworkMode':'none'},
            'Mounts':[{'RW':False,'Destination':target,'Type':'bind','Source':'/retained'+target}
                      for target in ('/state','/user-data','/host-ledger','/opt/fullmag/source','/opt/fullmag/runtime-control')]}
        self.ready = {'schema':'fullmag.data-copy-fence-event.v1','state':'held','token':self.request['token'],
            'volume_id':self.request['volume_id'],'observation':{'authentication':{
                'process_receipt_sha256':self.request['process_receipt_sha256'],'released':{'active_count':0}}}}
        return handle

    def fake_daemon(self,*_args,**_kwargs):
        return SimpleNamespace(stdout=json.dumps([self.helper]).encode())

    def test_clean_ack_is_required_to_clear_daemon_pending(self):
        handle = self.make_guard()
        released = {'schema':'fullmag.data-copy-fence-event.v1','state':'released','token':self.request['token'],'copy_result_sha256':'f'*64}
        with mock.patch.object(guard.subprocess,'Popen',return_value=self.process) as spawn, \
                mock.patch.object(guard.BuildControl,'_line',side_effect=[json.dumps(self.ready),json.dumps(released)]), \
                mock.patch.object(guard,'docker_capture',side_effect=self.fake_daemon):
            with handle:
                self.assertTrue(self.operation['daemon_pending'])
                handle.finish('f'*64)
        self.assertFalse(self.operation['daemon_pending'])
        self.assertTrue(spawn.call_args.kwargs['start_new_session'])
        self.process.terminate.assert_not_called(); self.process.kill.assert_not_called()

    def test_missing_terminal_ack_retains_the_helper_without_killing_it(self):
        handle = self.make_guard()
        with mock.patch.object(guard.subprocess,'Popen',return_value=self.process), \
                mock.patch.object(guard.BuildControl,'_line',return_value=json.dumps(self.ready)), \
                mock.patch.object(guard,'docker_capture',side_effect=self.fake_daemon), \
                self.assertRaises(guard.ControlOutcomeUnknown):
            with handle:
                pass
        self.assertTrue(self.operation['daemon_pending'])
        self.process.terminate.assert_not_called(); self.process.kill.assert_not_called()
        self.assertEqual(self.process.stdin.getvalue().count(b'\n'),1)

    def test_same_container_id_after_restart_is_not_the_same_held_fence(self):
        handle = self.make_guard()
        with mock.patch.object(guard.subprocess,'Popen',return_value=self.process), \
                mock.patch.object(guard.BuildControl,'_line',return_value=json.dumps(self.ready)), \
                mock.patch.object(guard,'docker_capture',side_effect=self.fake_daemon):
            handle.__enter__()
            self.helper['State'].update(StartedAt='2026-11-12T00:00:01.000000001Z',Pid=43)
            with self.assertRaisesRegex(guard.ControlOutcomeUnknown,'incarnation'):
                handle.check()
        self.assertTrue(self.operation['daemon_pending'])


if __name__ == '__main__':
    unittest.main()
