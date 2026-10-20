"""Interpreted lifecycle regressions; all Docker/HTTP/fence operations are fake."""
import copy
from contextlib import closing
import io
import json
from pathlib import Path
import queue
import sqlite3
import tempfile
import sys
import types
import hashlib
import os
import unittest
from unittest.mock import patch

from local_runner import coordinator_lifecycle as lifecycle
from local_runner import container_client as client
from local_runner import boris_transition as transition
from local_runner.service import ServicePaths, request_stop
from test_local_runner_container_client import FakeDocker, IMAGE, CONTAINER_ID


class FakeFence:
    def __init__(self,events,fail=None):self.events=events;self.fail=fail;self.armed=False;events.append('acquired')
    def check(self):
        self.events.append('held')
        if self.fail=='check':raise client.ContainerClientError('synthetic EOF')
        return dict(state='HELD',nonce='e'*32,pid=12)
    def arm(self):
        self.armed=True;self.events.append('armed')
        if self.fail=='arm':raise client.ContainerClientError('synthetic ARM ACK lost')
        return dict(state='ARMED',nonce='e'*32,pid=12)
    def close_before_stop(self):
        if not self.armed:self.events.append('released')
    def confirm_destroyed(self):
        self.events.append('destroyed')
        if self.fail=='destroy':raise client.ContainerClientError('synthetic live exec')


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.storage=Path(self.tmp.name)/'storage';self.storage.mkdir()
        self.layout=dict(storage_root=str(self.storage),build_root=str(self.storage/'builds'/'fixture'))
        client.configure(self.layout,IMAGE,'alice')
        catalog=dict(schema='fullmag.runner-build-config.v1',operator='alice',profiles={'fem-cpu-release':{'preserved':'unchanged'}})
        (self.storage/'index'/'local-runner-build-config.json').write_text(json.dumps(catalog))
        self.baseline=[transition._read_bytes(self.storage/'index'/name) for name in transition.NAMES]
        with closing(sqlite3.connect(self.storage/'index'/'runner-jobs.sqlite')) as db, db:
            db.execute('CREATE TABLE jobs (job_id TEXT,state TEXT,profile TEXT,operation TEXT,owner TEXT,source_digest TEXT,sequence INTEGER,lease_token TEXT)')
            db.execute('PRAGMA user_version=1');db.execute("INSERT INTO jobs VALUES ('queued-job','queued','fem-cpu-release','build','alice','digest',1,NULL)")
        request_stop(ServicePaths.from_storage(self.storage),requested_by='alice')
        self.docker=FakeDocker(self.storage);self.docker.container_id=CONTAINER_ID;self.docker.inspection=self.docker._inspection(running=True)
        self.health=dict(ok=True,active_jobs=[],legacy_jobs=[],stop_requested=True,accepting_jobs=False,worker_alive=False,worker_error=None,coordinator=dict(state='stopped'))
        self.events=[];self.fence=None
        def factory(identifier,sources):
            self.assertEqual(identifier,CONTAINER_ID);self.fence=FakeFence(self.events);return self.fence
        self.factory=factory
        self.arguments=dict(expected_container_id=CONTAINER_ID,expected_image_id=IMAGE,expected_public_sha256=transition._sha(self.baseline[1]),expected_catalog_sha256=transition._sha(self.baseline[2]),expected_source_hashes={name:'a'*64 for name in lifecycle.SOURCE_FILES},docker_call=self.docker,health_call=lambda *args:copy.deepcopy(self.health),fence_factory=self.factory)

    def run_stop(self,**kwargs):
        return lifecycle.quiesce_and_stop(self.layout,'alice',**{**self.arguments,**kwargs})

    def receipt(self):return json.loads(next((self.storage/'builds').rglob('terminal-receipt.json')).read_text())
    def assert_no_stop(self):self.assertFalse(any(c[0] in ('stop','kill','rm','start','create') for c in self.docker.calls))

    def test_stop_only_exact_container_after_held_and_arm_then_exit(self):
        original=self.docker.__call__
        def docker(arguments):
            if arguments[0]=='stop':
                self.assertEqual(self.events[-1],'armed');self.assertEqual(arguments,['stop','--time','10',CONTAINER_ID]);self.events.append('stop')
            return original(arguments)
        result=self.run_stop(docker_call=docker)
        self.assertEqual(result['status'],'SUCCEEDED_EXITED_PAUSED_ONLY')
        self.assertTrue(result['exec_destroyed']);self.assertIn('destroyed',self.events)
        self.assertFalse(result['host_locks_claim_fence']);self.assertNotIn('released',self.events)
        self.assertEqual([transition._read_bytes(self.storage/'index'/name) for name in transition.NAMES],self.baseline)
        self.assertEqual(result['initial_guard']['queue'],result['final_guard']['queue'])
        self.assertFalse(any(c[0] in ('rm','kill','start','create') for c in self.docker.calls))

    def test_public_recovery_checkpoint_precedes_arm_and_stop(self):
        case=self
        class CheckedFence(FakeFence):
            def arm(self):
                record=case.receipt();case.assertEqual(record['status'],'ARM_REQUESTED')
                case.assertEqual(record['container_id'],CONTAINER_ID);case.assertEqual(record['held_ack']['nonce'],'e'*32)
                return super().arm()
        def factory(*args):return CheckedFence(self.events)
        def docker(arguments):
            if arguments[0]=='stop':
                record=self.receipt();self.assertEqual(record['status'],'STOP_REQUESTED_NOT_CONFIRMED')
                self.assertEqual(record['armed_ack']['state'],'ARMED');self.assertTrue(record['producer_sha256'])
            return self.docker(arguments)
        self.run_stop(fence_factory=factory,docker_call=docker)
        self.assertNotIn('token',self.receipt())

    def test_active_health_refuses_before_fence_and_stop(self):
        self.health['active_jobs']=[{'job_id':'active'}]
        with self.assertRaises(client.ContainerClientError):self.run_stop()
        self.assertEqual(self.events,[]);self.assert_no_stop()
        self.assertEqual(self.receipt()['status'],'REFUSED_BEFORE_STOP')

    def test_active_db_lease_refuses_even_empty_health(self):
        with closing(sqlite3.connect(self.storage/'index'/'runner-jobs.sqlite')) as db, db:db.execute("UPDATE jobs SET state='running',lease_token='private-lease'")
        with self.assertRaisesRegex(client.ContainerClientError,'lease'):self.run_stop()
        self.assertEqual(self.events,[]);self.assert_no_stop()
        self.assertNotIn('private-lease',json.dumps(self.receipt()))

    def test_terminal_blocked_job_without_lease_is_safe(self):
        with closing(sqlite3.connect(self.storage/'index'/'runner-jobs.sqlite')) as db, db:db.execute("UPDATE jobs SET state='blocked'")
        self.assertEqual(self.run_stop()['status'],'SUCCEEDED_EXITED_PAUSED_ONLY')

    def test_resume_between_guards_aborts_and_releases_only_owned_fence(self):
        calls=0
        def health(*args):
            nonlocal calls
            calls+=1
            if calls==2:self.health['accepting_jobs']=True
            return copy.deepcopy(self.health)
        with self.assertRaises(client.ContainerClientError):self.run_stop(health_call=health)
        self.assertIn('released',self.events);self.assert_no_stop()

    def test_private_config_cas_detects_concurrent_changes(self):
        def factory(*args):
            secret=json.loads(self.baseline[0]);secret['token']='z'*64
            (self.storage/'index'/transition.NAMES[0]).write_text(json.dumps(secret))
            return FakeFence(self.events)
        with self.assertRaisesRegex(client.ContainerClientError,'Private config pair'):self.run_stop(fence_factory=factory)
        self.assertIn('released',self.events);self.assert_no_stop()
        self.assertNotIn('z'*64,json.dumps(self.receipt()))

    def test_missing_pause_marker_refuses(self):
        ServicePaths.from_storage(self.storage).stop_request_path.unlink()
        with self.assertRaisesRegex(client.ContainerClientError,'pause marker'):self.run_stop()
        self.assert_no_stop()

    def test_false_held_ack_aborts_before_stop(self):
        def factory(*args):return FakeFence(self.events,'check')
        with self.assertRaisesRegex(client.ContainerClientError,'EOF'):self.run_stop(fence_factory=factory)
        self.assertIn('released',self.events);self.assert_no_stop()

    def test_arm_ack_loss_quarantines_fence_without_stop(self):
        def factory(*args):return FakeFence(self.events,'arm')
        with self.assertRaisesRegex(client.ContainerClientError,'ARM ACK'):self.run_stop(fence_factory=factory)
        self.assertNotIn('released',self.events);self.assert_no_stop()
        self.assertEqual(self.receipt()['status'],'ARM_UNCONFIRMED_FENCE_QUARANTINED')

    def test_stop_timeout_retains_armed_fence_and_records_exact_identity(self):
        def docker(arguments):
            if arguments[0]=='stop':raise client.ContainerClientError('synthetic timeout')
            return self.docker(arguments)
        with self.assertRaisesRegex(client.ContainerClientError,'timeout'):self.run_stop(docker_call=docker)
        self.assertNotIn('released',self.events)
        self.assertEqual(self.receipt()['status'],'STOP_UNCONFIRMED_FENCE_QUARANTINED')
        self.assertEqual(self.receipt()['container_id'],CONTAINER_ID)

    def test_early_exec_eof_does_not_count_as_container_exit(self):
        def docker(arguments):
            if arguments[0]=='stop':return CONTAINER_ID
            return self.docker(arguments)
        with self.assertRaisesRegex(client.ContainerClientError,'exit not confirmed'):self.run_stop(docker_call=docker)
        self.assertEqual(self.receipt()['status'],'STOP_UNCONFIRMED_FENCE_QUARANTINED')

    def test_exited_container_requires_exec_destroyed_confirmation(self):
        def factory(*args):return FakeFence(self.events,'destroy')
        with self.assertRaisesRegex(client.ContainerClientError,'live exec'):self.run_stop(fence_factory=factory)
        self.assertEqual(self.receipt()['status'],'EXITED_RECOVERY_REQUIRED')
        self.assertNotIn('released',self.events)

    def test_active_renamed_fullmag_worker_blocks_stop(self):
        worker=dict(Id='c'*64,Name='/renamed',State=dict(Running=True,Status='running'),Config=dict(Labels={'owner':'fullmag-local-runner'}))
        def docker(arguments):
            if arguments[0]=='ps':return CONTAINER_ID+'\n'+worker['Id']
            if arguments==['inspect',CONTAINER_ID,worker['Id']]:return json.dumps([self.docker.inspection,worker])
            return self.docker(arguments)
        with self.assertRaisesRegex(client.ContainerClientError,'worker'):self.run_stop(docker_call=docker)
        self.assert_no_stop();self.assertEqual(self.events,[])

    def test_worker_cannot_hide_behind_buildkit_name(self):
        worker=dict(Id='c'*64,Name='/buildx_buildkit_fullmag',State=dict(Running=True,Status='running'),Config=dict(Labels={'owner':'fullmag-local-runner'}))
        def docker(arguments):
            if arguments[0]=='ps':return CONTAINER_ID+'\n'+worker['Id']
            if arguments==['inspect',CONTAINER_ID,worker['Id']]:return json.dumps([self.docker.inspection,worker])
            return self.docker(arguments)
        with self.assertRaisesRegex(client.ContainerClientError,'worker'):self.run_stop(docker_call=docker)
        self.assert_no_stop()

    def test_null_queue_state_refuses(self):
        with closing(sqlite3.connect(self.storage/'index'/'runner-jobs.sqlite')) as db, db:db.execute('UPDATE jobs SET state=NULL')
        with self.assertRaisesRegex(client.ContainerClientError,'lease'):self.run_stop()
        self.assert_no_stop()

    def test_incomplete_inventory_refuses(self):
        def docker(arguments):
            if arguments[0]=='ps':return CONTAINER_ID+'\n'+'c'*64
            return self.docker(arguments)
        with self.assertRaisesRegex(client.ContainerClientError,'inventory'):self.run_stop(docker_call=docker)
        self.assert_no_stop()

    def test_foreign_container_or_image_refuses_before_fence(self):
        self.docker.inspection['Image']='sha256:'+'f'*64
        with self.assertRaisesRegex(client.ContainerClientError,'image mismatch'):self.run_stop()
        self.assert_no_stop();self.assertEqual(self.events,[])

    def test_nonblocking_host_lock_failure_does_not_wait_or_spawn(self):
        def refuse(path,key,blocking):
            self.assertFalse(blocking);raise lifecycle.StorageError('busy')
        with patch.object(lifecycle,'file_lock',side_effect=refuse),self.assertRaises(lifecycle.StorageError):self.run_stop()
        self.assertEqual(self.events,[]);self.assert_no_stop()

    def test_paused_marker_restored_after_api_is_confirmed_destroyed(self):
        def docker(arguments):
            if arguments[0]=='stop':ServicePaths.from_storage(self.storage).stop_request_path.unlink()
            return self.docker(arguments)
        self.run_stop(docker_call=docker)
        self.assertTrue(ServicePaths.from_storage(self.storage).stop_request_path.exists())
        self.assertIn('destroyed',self.events)


class FenceProtocolTests(unittest.TestCase):
    def fence(self,raw=None):
        fence=lifecycle.LinuxFence.__new__(lifecycle.LinuxFence);fence.nonce='e'*32;fence.armed=False;fence.messages=queue.Queue()
        class Process:
            stdin=io.BytesIO()
            def poll(self):return None
        fence.process=Process()
        if raw is not None:fence.messages.put(raw)
        return fence

    def test_exact_held_ack_is_required(self):
        fence=self.fence(json.dumps(dict(state='HELD',nonce='e'*32,pid=9)).encode())
        self.assertEqual(fence.check()['pid'],9)
        self.assertTrue(fence.process.stdin.getvalue().endswith(b'\n'))
        for state,nonce,pid in [('BUSY','e'*32,9),('HELD','f'*32,9),('HELD','e'*32,False)]:
            with self.subTest(state=state,nonce=nonce,pid=pid),self.assertRaises(client.ContainerClientError):
                self.fence(json.dumps(dict(state=state,nonce=nonce,pid=pid)).encode()).check()

    def test_eof_and_timeout_fail_closed(self):
        with self.assertRaisesRegex(client.ContainerClientError,'EOF'):self.fence(b'').check()
        with patch.object(lifecycle,'HANDSHAKE_SECONDS',0.001),self.assertRaisesRegex(client.ContainerClientError,'timed out'):self.fence().check()

    def test_arm_sent_marks_possible_hold_before_ack(self):
        fence=self.fence(b'')
        with self.assertRaises(client.ContainerClientError):fence.arm()
        self.assertTrue(fence.armed)
        self.assertIn(b'ARM',fence.process.stdin.getvalue())

    def test_reviewed_claim_routes_require_lock_ancestry(self):
        root=Path(lifecycle.__file__).parent
        lifecycle._claim_contract((root/'build_executor.py').read_text(),'execute_build')
        lifecycle._claim_contract((root/'coordinator.py').read_text(),'execute_once')
        with self.assertRaisesRegex(ValueError,'outside'):
            lifecycle._claim_contract("def execute_build():\n queue.claim('worker')\n",'execute_build')
        with self.assertRaisesRegex(ValueError,'Unexpected'):
            lifecycle._claim_contract("def execute_build():\n pass\n",'execute_build')

    def test_remote_runtime_eof_releases_unarmed_but_quarantines_armed(self):
        class Quarantine(BaseException):pass
        root=Path(lifecycle.__file__).parents[1]
        with tempfile.TemporaryDirectory() as directory:
            private=Path(directory);sources=private/'scripts'
            hashes={}
            for name in lifecycle.SOURCE_FILES:
                data=(root/name).read_bytes();target=sources/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
                hashes[name]=hashlib.sha256(data).hexdigest()
            lock=private/'coordinator.lock';lock.write_bytes(b'0')
            for armed in (False,True):
                with self.subTest(armed=armed):
                    initial=json.dumps(dict(nonce='e'*32,sources=hashes))+'\n'
                    if armed:initial+=json.dumps(dict(nonce='e'*32,operation='ARM'))+'\n'
                    stdin=types.SimpleNamespace(buffer=io.BytesIO(initial.encode()));out=io.StringIO();fds=[];closed=[];flocks=[]
                    real_open=os.open;real_close=os.close
                    def opened(*args):
                        fd=real_open(*args);fds.append(fd);return fd
                    def close(fd):closed.append(fd);return real_close(fd)
                    fcntl=types.SimpleNamespace(LOCK_EX=2,LOCK_NB=4,flock=lambda fd,flags:flocks.append((fd,flags)))
                    code=lifecycle.REMOTE.replace('/opt/runner/scripts',sources.as_posix()).replace('/storage/locks/local-runner-coordinator.lock',lock.as_posix())
                    try:
                        with patch.dict(sys.modules,fcntl=fcntl),patch.object(sys,'stdin',stdin),patch.object(sys,'stdout',out),patch('select.select',return_value=([stdin.buffer],[],[])),patch.object(os,'O_NOFOLLOW',0,create=True),patch.object(os,'open',side_effect=opened),patch.object(os,'close',side_effect=close),patch('time.sleep',side_effect=Quarantine):
                            with self.assertRaises(Quarantine if armed else ValueError):exec(code,{})
                        messages=[json.loads(line) for line in out.getvalue().splitlines()]
                        self.assertEqual(messages[0]['state'],'HELD');self.assertEqual(flocks[0][1],6)
                        if armed:
                            self.assertEqual(messages[1]['state'],'ARMED');self.assertEqual(closed,[])
                        else:self.assertEqual(closed,fds)
                    finally:
                        for fd in fds:
                            if fd not in closed:real_close(fd)

    def test_remote_program_is_interpreted_and_armed_eof_quarantines(self):
        compile(lifecycle.REMOTE,'<fixed-fence>','exec')
        self.assertIn('fcntl.LOCK_EX|fcntl.LOCK_NB',lifecycle.REMOTE)
        self.assertIn("if locals().get('armed',False)",lifecycle.REMOTE)
        self.assertNotIn('docker',lifecycle.REMOTE)
        self.assertNotIn('/control/config.json',lifecycle.REMOTE)


class LifecycleCliTests(unittest.TestCase):
    def call(self, entries):
        import local_runner_cli
        arguments=['container-quiesce','--expected-container-id',CONTAINER_ID,
                   '--expected-image-id',IMAGE,'--expected-public-sha256','a'*64,
                   '--expected-catalog-sha256','b'*64]
        for entry in entries:arguments+=['--reviewed-source-sha256',entry]
        layout={'storage_root':str(Path(tempfile.gettempdir())/'absent-lifecycle-cli-storage')}
        with patch.object(local_runner_cli,'resolve_layout',return_value=layout), \
             patch.object(local_runner_cli.getpass,'getuser',return_value='alice'), \
             patch.object(lifecycle,'quiesce_and_stop',return_value={'status':'fixture'}) as stop, \
             patch('sys.stdout',new_callable=io.StringIO),patch('sys.stderr',new_callable=io.StringIO):
            code=local_runner_cli.main(arguments)
        return code,stop,layout

    def test_cli_routes_all_explicit_identity_and_source_pins(self):
        sources={name:'c'*64 for name in lifecycle.SOURCE_FILES}
        code,stop,layout=self.call([name+'='+value for name,value in sources.items()])
        self.assertEqual(code,0)
        stop.assert_called_once_with(layout,'alice',expected_container_id=CONTAINER_ID,
            expected_image_id=IMAGE,expected_public_sha256='a'*64,
            expected_catalog_sha256='b'*64,expected_source_hashes=sources)

    def test_cli_duplicate_pin_refuses_before_lifecycle(self):
        code,stop,_=self.call(['fullmag_storage.py='+'c'*64]*2)
        self.assertEqual(code,2);stop.assert_not_called()

    def test_cli_malformed_pin_refuses_before_lifecycle(self):
        code,stop,_=self.call(['fullmag_storage.py'])
        self.assertEqual(code,2);stop.assert_not_called()


if __name__=='__main__':unittest.main()
