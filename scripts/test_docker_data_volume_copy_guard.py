"""Mocked Docker lifecycle and real isolated source-import regressions."""
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import py_compile
import subprocess
import sys
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

    def _isolated_bootstrap(self, scripts, contents):
        for name in guard.COMPONENTS:
            (scripts/name).write_bytes(contents.get(name, b'\n'))
        self.request['components'] = {
            name: hashlib.sha256((scripts/name).read_bytes()).hexdigest()
            for name in guard.COMPONENTS
        }
        with self.patches(), mock.patch.object(guard,'_COPY_FENCE_SOURCE_ROOT',str(scripts)):
            args = guard.copy_fence_arguments(self.control,self.actual,self.source,self.request)
        bootstrap = args[-1]
        self.assertIn(repr(str(scripts)), bootstrap)
        self.assertNotIn('sys.path.insert',bootstrap)
        self.assertNotIn('runtime_service',guard.COMPONENTS)
        return bootstrap

    def _relocated_fixture(self):
        from scripts.test_docker_data_volume_relocated import RelocatedGroupTests
        fixture = RelocatedGroupTests('test_verified_live_view_distinguishes_old_roots_from_canonical_declarations')
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        view = fixture.issue()
        source = fixture.case.source_root
        scripts = source/'scripts'; scripts.mkdir()
        components = {}
        for name in guard.COMPONENTS:
            path = scripts/name; path.write_bytes(b'# relocated copy-fence fixture\n')
            components[name] = hashlib.sha256(path.read_bytes()).hexdigest()
        request = {
            'schema':'fullmag.data-copy-fence-request.v1',
            'token':'b'*32,
            'volume_id':fixture.case.linux['volume_id'],
            'process_receipt_sha256':'d'*64,
            'source_roots':{role:{key:value[key] for key in ('device','inode')}
                            for role,value in fixture.case.source_roots.items()},
            'components':components,
        }
        old_image = self.control.image
        self.control.image = fixture.case.plan['runtime_pins']['image_id']
        self.control.project = fixture.case.plan['compose_project']
        self.actual['Config']['Labels']['com.docker.compose.project'] = self.control.project
        self.base[self.base.index(old_image)] = self.control.image
        self.actual['Id'] = fixture.case.plan['runtime_pins']['backend']
        self.actual['Image'] = fixture.case.plan['runtime_pins']['image_id']
        return fixture,view,source,request

    def test_no_gpu_no_write_and_no_signal_proxy_in_scoped_helper_arguments(self):
        with self.patches():
            args = guard.copy_fence_arguments(self.control,self.actual,self.source,self.request)
        self.assertIn('--sig-proxy=false',args)
        self.assertNotIn('--gpus',args)
        mounts = [args[i+1] for i,v in enumerate(args[:-1]) if v=='--mount']
        self.assertEqual(len(mounts),4)
        self.assertTrue(all(value.endswith(',readonly') for value in mounts))
        self.assertEqual(args[-4],self.control.image)
        self.assertIn("importlib.import_module('data_volume_copy_fence_service')",args[-1])
        self.assertIn('service.main()',args[-1])
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

    def test_live_relocated_view_overrides_only_state_and_user_data_mounts(self):
        fixture,view,source,request = self._relocated_fixture()
        self.source = source
        runtime_control_mount = 'type=volume,source=runtime-control,dst=/opt/fullmag/runtime-control'
        base = self.base[:self.base.index('--entrypoint')] + ['--mount',runtime_control_mount] + \
            self.base[self.base.index('--entrypoint'):]
        with self.patches(), mock.patch.object(guard,'live_bind_path',return_value=source), \
                mock.patch.object(guard,'_runtime_control_validation_helper',return_value=base):
            args = guard.copy_fence_arguments(
                self.control,self.actual,source,request,relocated=view)

        mounts = [args[index+1] for index,value in enumerate(args[:-1]) if value == '--mount']
        by_target = {value.split('dst=',1)[1].split(',',1)[0]:value for value in mounts}
        rows = fixture.result['switch']['roots']
        self.assertEqual(by_target['/state'],
            'type=bind,src='+rows['state']['backup_root']+',dst=/state,readonly')
        self.assertEqual(by_target['/user-data'],
            'type=bind,src='+rows['user_data']['backup_root']+',dst=/user-data,readonly')
        self.assertEqual(by_target['/host-ledger'],
            'type=bind,src=/retained/host-ledger,dst=/host-ledger,readonly')
        self.assertEqual(by_target['/opt/fullmag/runtime-control'],runtime_control_mount)
        self.assertEqual(args[args.index('--user')+1],'65532:65532')

    def test_raw_override_dictionary_is_rejected_by_the_real_live_view_gate(self):
        fixture,view,source,request = self._relocated_fixture()
        with mock.patch.object(guard,'_runtime_control_validation_helper') as helper, \
                mock.patch.object(guard.subprocess,'Popen') as spawn, \
                self.assertRaisesRegex(ValueError,'authenticated live relocated view'):
            guard.CopyFence(
                self.control,self.actual,source,request,
                relocated={'/state':Path('/fake/state'),'/user-data':Path('/fake/user-data')})
        helper.assert_not_called()
        spawn.assert_not_called()

    def test_escaped_relocated_context_is_rejected_before_helper_construction(self):
        fixture,view,source,request = self._relocated_fixture()
        fixture.copied._live = False
        with self.patches(), mock.patch.object(guard,'live_bind_path',return_value=source), \
                mock.patch.object(guard,'_runtime_control_validation_helper') as helper, \
                self.assertRaisesRegex(ValueError,'original live copied-group host scope'):
            guard.copy_fence_arguments(self.control,self.actual,source,request,relocated=view)
        helper.assert_not_called()

    def test_enter_rechecks_relocated_scope_before_spawning_client(self):
        fixture,view,source,request = self._relocated_fixture()
        self.source = source
        with self.patches(), mock.patch.object(guard,'live_bind_path',return_value=source):
            handle = guard.CopyFence(self.control,self.actual,source,request,relocated=view)
        operation = {'receipt':{'phase':'data-volume-migration','attempt':request['token']},
                     'daemon_pending':False,'root':'fixture-operation'}
        self.control._active_operation = operation
        fixture.copied._live = False
        with mock.patch.object(guard.subprocess,'Popen') as spawn, \
                self.assertRaisesRegex(ValueError,'original live copied-group host scope'):
            handle.__enter__()
        spawn.assert_not_called()
        self.assertFalse(operation['daemon_pending'])

    def test_check_rechecks_relocated_scope_before_other_runtime_observation(self):
        fixture,view,source,request = self._relocated_fixture()
        self.source = source
        with self.patches(), mock.patch.object(guard,'live_bind_path',return_value=source):
            handle = guard.CopyFence(self.control,self.actual,source,request,relocated=view)
        handle.operation = {'root':'fixture-operation'}
        fixture.copied._live = False
        with mock.patch.object(guard,'docker_capture') as inspect, \
                self.assertRaisesRegex(ValueError,'original live copied-group host scope'):
            handle.check()
        inspect.assert_not_called()

    def test_isolated_bootstrap_executes_verified_dependency_bytes_not_timestamp_valid_pyc(self):
        with tempfile.TemporaryDirectory(prefix='fullmag-copy-fence-pyc-') as temporary:
            base = Path(temporary); scripts = self.source/'scripts'
            good_sentinel = base/'sentinel-good'; evil_sentinel = base/'sentinel-evil'
            good_dependency = (
                "from pathlib import Path\n"
                f"Path({str(good_sentinel)!r}).write_text(__file__ + '|' + str(__cached__))\n"
                "def run():\n    return None\n"
            ).encode()
            evil_dependency = (
                "from pathlib import Path\n"
                f"Path({str(evil_sentinel)!r}).write_text(__file__ + '|' + str(__cached__))\n"
                "def run():\n    return None\n"
            ).encode()
            self.assertEqual(len(good_dependency), len(evil_dependency))
            service = (
                "from data_volume_copy_fences import run\n"
                "def main():\n    return run()\n"
            ).encode()
            bootstrap = self._isolated_bootstrap(scripts, {
                'data_volume_copy_fence_service.py': service,
                'data_volume_copy_fences.py': good_dependency,
            })

            dependency_path = scripts/'data_volume_copy_fences.py'
            dependency_path.write_bytes(evil_dependency)
            fixed_mtime_ns = 1_700_000_000_000_000_000
            os.utime(dependency_path, ns=(fixed_mtime_ns, fixed_mtime_ns))
            py_compile.compile(str(dependency_path), doraise=True)
            dependency_path.write_bytes(good_dependency)
            os.utime(dependency_path, ns=(fixed_mtime_ns, fixed_mtime_ns))

            ordinary = subprocess.run(
                [sys.executable,'-I','-B','-c',
                 'import sys; sys.path.insert(0, sys.argv[1]); '
                 'import data_volume_copy_fence_service as service; service.main()',str(scripts)],
                cwd=base,capture_output=True,text=True,timeout=10)
            self.assertEqual(ordinary.returncode,0,ordinary.stderr)
            self.assertTrue(evil_sentinel.exists(), 'ordinary -B import did not exercise the poisoned pyc control')
            self.assertFalse(good_sentinel.exists())
            evil_sentinel.unlink()

            verified = subprocess.run(
                [sys.executable,'-I','-B','-c',bootstrap],
                cwd=base,capture_output=True,text=True,timeout=10)
            self.assertEqual(verified.returncode,0,verified.stderr)
            self.assertTrue(good_sentinel.exists(), 'copy-fence bootstrap did not execute the pinned source')
            self.assertEqual(good_sentinel.read_text(),str(scripts/'data_volume_copy_fences.py')+'|None')
            self.assertFalse(evil_sentinel.exists(), 'copy-fence bootstrap executed poisoned pyc bytes')

    def test_isolated_bootstrap_rejects_entrypoint_drift_before_module_side_effect(self):
        with tempfile.TemporaryDirectory(prefix='fullmag-copy-fence-entry-drift-') as temporary:
            base = Path(temporary); scripts = self.source/'scripts'
            sentinel = base/'entrypoint-imported'
            pinned_entrypoint = b"def main():\n    return None\n"
            bootstrap = self._isolated_bootstrap(scripts, {
                'data_volume_copy_fence_service.py': pinned_entrypoint,
            })
            drifted_entrypoint = (
                "from pathlib import Path\n"
                f"Path({str(sentinel)!r}).touch()\n"
                "def main():\n    return None\n"
            ).encode()
            (scripts/'data_volume_copy_fence_service.py').write_bytes(drifted_entrypoint)

            result = subprocess.run(
                [sys.executable,'-I','-B','-c',bootstrap],
                cwd=base,capture_output=True,text=True,timeout=10)

            self.assertNotEqual(result.returncode,0)
            self.assertIn('source changed',result.stderr)
            self.assertFalse(sentinel.exists(), 'drifted entrypoint ran before the source pin check')

    def test_real_service_import_graph_excludes_unpinned_stdlib_lookalike(self):
        scripts=self.source/'scripts';sentinel=self.source/'unverified-shlex-executed'
        original=Path(guard.__file__).parent
        bootstrap=self._isolated_bootstrap(scripts,{name:(original/name).read_bytes() for name in guard.COMPONENTS})
        (scripts/'shlex.py').write_text(
            'from pathlib import Path\n'+f'Path({str(sentinel)!r}).touch()\n'+
            "raise RuntimeError('unverified checkout dependency executed')\n")
        self.assertTrue(bootstrap.endswith('service.main()\n'))
        # Exercise the real serve/import graph. Only image runtime identity,
        # fixed container-path recheck, and the eventual lock body are simulated.
        prelude=("import types,sys,io\n"
            "image=types.ModuleType('runtime_service')\n"
            "image.__file__='/opt/fullmag/runtime_service.py'\n"
            "image.canonical_paths=lambda:None\n"
            "sys.modules['runtime_service']=image\n")
        invoke=("assert 'shlex' not in sys.modules\n"
            "service._verify_components=lambda request:None\n"
            "service._serve_context=lambda *args:print('real-helpers-imported')\n"
            f"service.serve({self.request!r},io.BytesIO(),io.StringIO())\n")
        result=subprocess.run([sys.executable,'-I','-B','-c',
            prelude+bootstrap.removesuffix('service.main()\n')+invoke],
            cwd=self.source,capture_output=True,text=True,timeout=10)
        self.assertFalse(sentinel.exists(),'real serve() imported an unpinned checkout dependency')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn('real-helpers-imported',result.stdout)

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
