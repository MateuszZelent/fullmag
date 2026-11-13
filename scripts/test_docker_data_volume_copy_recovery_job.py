"""Retained-copy supervision must preserve the existing fence protocol."""
import unittest
from contextlib import ExitStack
import copy,json
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
from scripts import docker_data_volume_copy_recovery_job as job
from scripts import test_linux_data_volume_copy_recovery as root_fixtures
from scripts import docker_data_volume_copy_job as supervisor
from scripts.test_docker_data_volume_copy_job import Scenario,FakeProcess,success_terminal


class RecoverySupervisionTests(unittest.TestCase):
    def test_confirmed_recovery_acknowledges_only_its_new_qualified_copy(self):
        fixture=Scenario(self)
        process=FakeProcess(fixture.events,[None,0])
        terminal=success_terminal();terminal['result']['schema']='fullmag.data-volume-linux-copy-result.v2'
        with fixture.patched_runtime(process,terminal) as runtime:
            actual=supervisor.run_prepared_root('copy-recovery',fixture.fence,fixture.argv,
                fixture.operation_root,fixture.request,fixture.request_sha256,
                supervisor.validate_terminal,poll_interval=.001)
        self.assertEqual(actual,terminal)
        self.assertEqual(runtime.popen.call_count,1)
        self.assertTrue(process.waited)
        self.assertFalse(process.terminated or process.killed)
        self.assertEqual(fixture.fence.finish_calls,[terminal['receipt_sha256']])
        self.assertIs(fixture.operation['data_copy-recovery_root_process'],process)


class RecoveryJobContracts(unittest.TestCase):
    def fixture(self,probe=False):
        cls=root_fixtures.RootRecoveryProbeTests if probe else root_fixtures.RootRecoveryTests
        f=cls();self.addCleanup(f.doCleanups);f.setUp();return f

    def command_patches(self,f,*,probe=False):
        source=Path(job.__file__).resolve().parents[1]
        identity={'project_name':'fullmag-worktree-fixture','project_id':'project','worktree_id':'fixture'}
        image='sha256:'+'a'*64
        plan=dict(f.plan,source_root=str(source),project_id='project',compose_project=identity['project_name'],
            provision_request={'wsl_distro':'Ubuntu2'},runtime_pins=dict(f.plan['runtime_pins'],image_id=image))
        operation={'root':'data-volume-migration/attempts/'+f.token,
            'receipt':{'phase':'data-volume-migration','attempt':f.token},'daemon_pending':not probe}
        control=SimpleNamespace(_active_operation=operation,project=identity['project_name'],image=image,
            _assert_live_operation_helper=mock.Mock(),write=mock.Mock())
        ready=root_fixtures.stage.qualification._read(f.attempt/'fence-ready.json')[1] if not probe else None
        fence=SimpleNamespace(control=control,operation=operation,released=False,ready=ready,
            request={'token':f.token,'volume_id':f.volume,'source_roots':{
                r:{k:p[k] for k in ('device','inode')} for r,p in f.linux['source_roots'].items()}})
        stack=ExitStack()
        stack.enter_context(mock.patch.object(job.storage,'resolve_layout',return_value={'storage_root':str(f.source)}))
        stack.enter_context(mock.patch.object(job,'compose_project_identity',return_value=identity))
        stack.enter_context(mock.patch.object(job,'load_plan',return_value=(b'plan',plan,None)))
        self.wsl=stack.enter_context(mock.patch.object(job,'_wsl_executable',return_value='/mnt/c/Windows/System32/wsl.exe'))
        return stack,source,control,fence

    def test_literal_argv_uses_distinct_probe_and_recovery_authority(self):
        for probe in (False,True):
            with self.subTest(probe=probe):
                f=self.fixture(probe);patches,source,control,fence=self.command_patches(f,probe=probe)
                with patches:
                    if probe:argv,attempt,request=job.prepare_probe_command(control,source,'Ubuntu2',f.probe_path,f.probe_sha)
                    else:argv,attempt,request=job.prepare_command(fence,source,'Ubuntu2',f.request_path,f.request_sha)
                stage='probe-copy-recovery' if probe else 'recover-copy'
                self.assertEqual(argv[:10],['/mnt/c/Windows/System32/wsl.exe','--distribution','Ubuntu2',
                    '--user','root','--exec','/usr/bin/python3','-I','-B','-c'])
                self.assertIn("STAGE = "+repr(stage),argv[10])
                self.assertEqual(json.loads(argv[14]),request['components'])
                self.assertEqual(attempt,f.attempt)

    def test_history_or_ready_drift_refuses_before_root_argv(self):
        for name in ('linux-copy-started.json','copy-fence-ready.json'):
            f=self.fixture();patches,source,control,fence=self.command_patches(f)
            (f.op/name).write_text('{}')
            with patches,self.assertRaises(ValueError):job.prepare_command(fence,source,'Ubuntu2',f.request_path,f.request_sha)
            self.wsl.assert_not_called()

    def test_v2_root_terminal_authenticates_recovery_and_kept_failure(self):
        f=self.fixture();result=root_fixtures.stage.recover_verified(f.request_path,f.request_sha)
        terminal=job.validate_terminal(f.attempt,f.recovery,f.request_sha,0)
        self.assertEqual(terminal['result'],result)
        self.assertEqual(supervisor.validate_terminal(f.op,f.original_request,f.original_sha,0),terminal)
        with self.assertRaises(ValueError):job.validate_terminal(f.attempt,f.recovery,f.request_sha,1)
        (f.attempt/'copy-recovery-started.json').write_text('{}')
        with self.assertRaises(ValueError):job.validate_terminal(f.attempt,f.recovery,f.request_sha,0)

    def test_nonzero_confirmed_recovery_failure_is_terminal_but_never_success(self):
        f=self.fixture();(f.payload/'user/chunk').write_bytes(b'drift')
        with self.assertRaises(ValueError):root_fixtures.stage.recover_verified(f.request_path,f.request_sha)
        self.assertEqual(job.validate_terminal(f.attempt,f.recovery,f.request_sha,1)['state'],'failed-confirmed')
        with self.assertRaises(ValueError):job.validate_terminal(f.attempt,f.recovery,f.request_sha,0)

    def test_probe_records_actual_terminal_without_selector_change_or_native_guard(self):
        for code in (0,1):
            with self.subTest(exit_code=code):
                f=self.fixture(probe=True);patches,source,control,fence=self.command_patches(f,probe=True)
                before=(f.op/'active-attempt.json').read_bytes()
                result=root_fixtures.stage.probe_recovery(f.probe_path,f.probe_sha)
                output=json.dumps(result).encode() if code==0 else b''
                class Process:
                    waited=False
                    def communicate(self):return output,b'' if code==0 else b'private manifest exists'
                    def wait(self):self.waited=True;return code
                process=Process()
                with patches,mock.patch.object(job.subprocess,'Popen',return_value=process) as spawn:
                    if code==0:self.assertEqual(job.run_root_probe(control,source,'Ubuntu2',f.probe_path,f.probe_sha),result)
                    else:
                        with self.assertRaisesRegex(ValueError,'selector unchanged'):
                            job.run_root_probe(control,source,'Ubuntu2',f.probe_path,f.probe_sha)
                self.assertTrue(process.waited);spawn.assert_called_once();control.write.assert_called_once()
                self.assertEqual((f.op/'active-attempt.json').read_bytes(),before)
                self.assertFalse(control._active_operation['daemon_pending'])
                self.assertEqual(json.loads((f.attempt/'probe-observation.json').read_bytes())['exit_code'],code)
                self.assertFalse((f.attempt/'fence-ready.json').exists())

    def test_readonly_observation_fault_waits_same_process_before_unwind(self):
        class Process:
            calls=0;waited=False
            def communicate(self):
                self.calls+=1
                if self.calls==1:raise OSError('observer fault')
                return b'{}',b''
            def wait(self):self.waited=True;return 0
        process=Process()
        with self.assertRaisesRegex(OSError,'observer fault'):job._observe_readonly_probe(process)
        self.assertTrue(process.waited);self.assertEqual(process.calls,2)


if __name__=='__main__':unittest.main()
