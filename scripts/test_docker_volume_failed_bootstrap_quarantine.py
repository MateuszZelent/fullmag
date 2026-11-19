from __future__ import annotations
import copy
import hashlib
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parent))
from docker_build_control import BuildControlError, canonical
import docker_volume_failed_bootstrap_quarantine as recovery

class QualificationTests(unittest.TestCase):
    def historical(self):
        owner = canonical({'schema_version':'runtime_service_owner.v1','state':'ready','owner_token':'old'})
        process = canonical({'schema':'fullmag.docker-process-tree.v1','state':'ready'})
        prefix='namespaces/'+'1'*32
        record={'schema':'fullmag.docker-isolated-session-snapshot.v1','previous_namespace':prefix,
                'control_pins':{prefix+'/'+recovery.OWNER:hashlib.sha256(owner).hexdigest(),
                                prefix+'/'+recovery.PROCESS:hashlib.sha256(process).hexdigest()}}
        return record, owner, process
    def test_history_requires_immutable_snapshot_pins(self):
        record, owner, process=self.historical()
        proof=recovery.historical_owner_pins(record, owner, process)
        self.assertEqual(len(proof),2)
    def test_history_refuses_merely_old_ready_owner(self):
        record, owner, process=self.historical()
        with self.assertRaises(BuildControlError):
            recovery.historical_owner_pins(record, owner+b' ', process)
    def test_history_refuses_process_drift(self):
        record, owner, process=self.historical()
        with self.assertRaises(BuildControlError):
            recovery.historical_owner_pins(record, owner, process+b' ')
    def test_replay_rejected_for_every_retired_request(self):
        receipt={'old_request_id':'old','retired_request_ids':['older','old']}
        with self.assertRaises(BuildControlError): recovery.assert_no_replay(receipt,'older')
        recovery.assert_no_replay(receipt,'new')
    def test_reservation_must_be_released(self):
        with self.assertRaises(BuildControlError):
            recovery.validate_ledger({'schema_version':'host_resource_ledger.v4','reservations':[{'state':'running'}]})
    def test_apply_requires_exact_reviewed_plan(self):
        with self.assertRaises(BuildControlError): recovery.require_plan('1'*64,{'proof':'drift'})
    def test_helper_stat_is_pinned_in_its_own_view(self):
        host={'device':2096,'inode':4496398,'uid':65534,'gid':65534,'size':23,'mode':432,'links':1}
        helper={**host,'uid':65532,'gid':65532}
        plan={'store_writer_identity':host}
        final=recovery._bind_plan(plan,helper)
        self.assertEqual(final['store_writer_identity']['uid'],65534)
        self.assertEqual(final['store_writer_helper_identity']['uid'],65532)
        with self.assertRaisesRegex(BuildControlError,'helper view'):
            recovery._bind_plan(final,{**helper,'inode':4496399})
        with self.assertRaises(BuildControlError):recovery.require_plan(recovery.digest(canonical(plan)),final)
    def test_no_confirmation_is_not_apply_authority(self):
        with self.assertRaises(BuildControlError): recovery.require_plan(None,{'proof':'ok'})


class TransactionTests(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)/'control'; self.store=Path(self.temp.name)/'store'; self.ledger=Path(self.temp.name)/'ledger'
        self.old='namespaces/'+'1'*32;self.new='namespaces/'+'2'*32
        runtime=self.root/self.old/'runtime-control/runtime-services'
        runtime.mkdir(parents=True);self.store.mkdir();(self.ledger/'ledger').mkdir(parents=True)
        for p in [self.root/'operation.lock', runtime/'OWNER.lock',runtime/'LAUNCH.lock',runtime/'STARTUP-GATE.lock',
                  self.store/'WRITER.lock',self.ledger/'ledger/WRITER.lock',self.ledger/'ledger/HOST_INVENTORY_OWNER.lock']:
            p.write_bytes(b'')
        import os
        os.link(self.root/'operation.lock',self.root/self.old/'operation.lock')
        (self.root/self.old/'active').write_bytes(b'unknown-operation\n')
        (runtime/'OWNER.json').write_bytes(b'preserved ready owner')
        (self.root/'namespaces/current.json').write_bytes(b'old-registry')
        (self.store/'WRITER.owner.json').write_text('{"released":true}')
        (self.ledger/'ledger/HOST_RESOURCE_LEDGER.json').write_text('{"reservations":[]}')
        self.plan={'recovery_id':'2'*32,'namespace':self.new,'previous_namespace':self.old,
            'control_pins':{self.old+'/active':recovery.digest(b'unknown-operation\n'),self.old+'/runtime-control/runtime-services/OWNER.json':recovery.digest(b'preserved ready owner'),
                            'namespaces/current.json':recovery.digest(b'old-registry')},
            'previous_registry_sha256':recovery.digest(b'old-registry'),
            'ledger_sha256':recovery.digest((self.ledger/'ledger/HOST_RESOURCE_LEDGER.json').read_bytes()),
            'containers':{'backend':{'id':'b'*64},'frontend':{'id':'f'*64}},
            'compose_project':'fullmag-master','control_volume':'old-volume','source_project_id':'p','source_worktree_id':'w'}
        self.plan['store_writer_identity']=recovery._writer_identity((self.store/'WRITER.lock').lstat())
        self.script=recovery.TRANSACTION.replace("P('/control')",'P('+repr(str(self.root))+')').replace("P('/store/",'P('+repr(str(self.store))+'+\'/').replace("P('/ledger/",'P('+repr(str(self.ledger))+'+\'/')
    def execute(self, commands=b'ABORT\n'):
        import subprocess
        return subprocess.run([sys.executable,'-B','-u','-c',self.script],input=canonical(self.plan)+b'\n'+commands,capture_output=True,timeout=5)
    def test_preview_takes_existing_locks_without_writes(self):
        result=self.execute()
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(result.stdout,b'LOCKED\n')
        self.assertEqual((self.root/'namespaces/current.json').read_bytes(),b'old-registry')
        self.assertFalse((self.root/self.new).exists())
    def test_publication_preserves_old_owner_active_and_global_lock_inode(self):
        import os
        result=self.execute(b'PUBLISH\nRELEASE\n')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(result.stdout,b'LOCKED\nPUBLISHED\nRELEASED\n')
        self.assertEqual((self.root/self.old/'active').read_bytes(),b'unknown-operation\n')
        self.assertEqual((self.root/self.old/'runtime-control/runtime-services/OWNER.json').read_bytes(),b'preserved ready owner')
        self.assertTrue(os.path.samefile(self.root/'operation.lock',self.root/self.new/'operation.lock'))
        self.assertTrue((self.root/'namespace-recovery'/('2'*32)/'removed-containers.json').exists())
    def test_pin_drift_refuses_publication(self):
        (self.root/self.old/'active').write_bytes(b'other-operation')
        result=self.execute(b'PUBLISH\nRELEASE\n')
        self.assertNotEqual(result.returncode,0)
        self.assertEqual((self.root/'namespaces/current.json').read_bytes(),b'old-registry')
    def test_live_native_owner_lock_refuses_publication(self):
        import fcntl
        with (self.root/self.old/'runtime-control/runtime-services/OWNER.lock').open('rb') as descriptor:
            fcntl.flock(descriptor,fcntl.LOCK_EX|fcntl.LOCK_NB)
            result=self.execute(b'PUBLISH\nRELEASE\n')
        self.assertNotEqual(result.returncode,0)
        self.assertFalse((self.root/self.new).exists())
    def test_unknown_handshake_never_publishes(self):
        result=self.execute(b'RETRY_SOLVE\n')
        self.assertNotEqual(result.returncode,0)
        self.assertEqual((self.root/'namespaces/current.json').read_bytes(),b'old-registry')
    def test_resume_after_registry_publish_preserves_same_receipt(self):
        import subprocess
        interrupted=self.execute(b'PUBLISH\n')
        self.assertNotEqual(interrupted.returncode,0)
        archive=self.root/'namespace-recovery'/('2'*32)
        original=(archive/'terminal.json').read_bytes()
        request={'plan':self.plan,'resume':True,
                 'registry_sha256':recovery.digest((self.root/'namespaces/current.json').read_bytes())}
        result=subprocess.run([sys.executable,'-B','-u','-c',self.script],
            input=canonical(request)+b'\nPUBLISH\nRELEASE\n',capture_output=True,timeout=5)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual((archive/'terminal.json').read_bytes(),original)
        self.assertEqual((archive/'previous-registry.json').read_bytes(),b'old-registry')
        self.assertTrue((archive/'removed-containers.json').exists())

    def test_store_bind_handshake_proves_host_conflict_then_helper_acquisition(self):
        import fcntl
        import subprocess
        descriptor,expected=recovery._host_store_lock(self.store)
        try:
            process=subprocess.Popen([sys.executable,'-B','-u','-c',self.script],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            process.stdin.write(canonical({'plan':self.plan,'bind_probe':True})+b'\n');process.stdin.flush()
            line=process.stdout.readline().decode().strip()
            self.assertTrue(line.startswith('STORE-BLOCKED '),line)
            observed=json.loads(line[len('STORE-BLOCKED '):])
            self.assertEqual(observed,expected)
            final=recovery._bind_plan(self.plan,observed)
            fcntl.flock(descriptor,fcntl.LOCK_UN)
            process.stdin.write(b'GO\n'+canonical(final)+b'\n');process.stdin.flush()
            self.assertEqual(process.stdout.readline(),b'LOCKED\n')
            recovery._prove_helper_store_conflict(descriptor,self.store)
            recovery._prove_helper_store_conflict(descriptor,self.store)
            process.stdin.write(b'ABORT\n');process.stdin.flush()
            self.assertEqual(process.wait(timeout=5),0,process.stderr.read())
        finally:
            import os
            os.close(descriptor)
            if process.poll() is None:
                process.stdin.close();process.wait(timeout=5)
            for stream in (process.stdin,process.stdout,process.stderr):stream.close()
        self.assertFalse((self.root/self.new).exists())
    def test_host_writer_lock_conflict_is_refused_before_helper_start(self):
        import os
        descriptor,_=recovery._host_store_lock(self.store)
        try:
            with self.assertRaisesRegex(BuildControlError,'writer lock is active'):
                recovery._host_store_lock(self.store)
        finally:os.close(descriptor)
    def test_host_writer_inode_replacement_is_refused(self):
        import os
        descriptor,_=recovery._host_store_lock(self.store)
        try:
            path=self.store/'WRITER.lock';path.rename(self.store/'old-writer.lock');path.write_bytes(b'')
            with self.assertRaisesRegex(BuildControlError,'inode changed'):
                recovery._verify_host_store_inode(descriptor,self.store)
        finally:os.close(descriptor)
    def test_fake_helper_locked_ack_without_lock_is_refused(self):
        import fcntl
        import os
        descriptor,_=recovery._host_store_lock(self.store)
        try:
            fcntl.flock(descriptor,fcntl.LOCK_UN)
            with self.assertRaisesRegex(BuildControlError,'does not block the host'):
                recovery._prove_helper_store_conflict(descriptor,self.store)
            # Failed verification must release the unexpectedly acquired lock.
            other,_=recovery._host_store_lock(self.store)
            os.close(other)
        finally:os.close(descriptor)
    def test_helper_rejects_final_plan_that_changes_original_constraints(self):
        import fcntl
        import os
        import subprocess
        descriptor,_=recovery._host_store_lock(self.store)
        process=None
        try:
            process=subprocess.Popen([sys.executable,'-B','-u','-c',self.script],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            process.stdin.write(canonical({'plan':self.plan,'bind_probe':True})+b'\n');process.stdin.flush()
            line=process.stdout.readline().decode().strip()
            self.assertTrue(line.startswith('STORE-BLOCKED '),line)
            final=recovery._bind_plan(self.plan,json.loads(line[len('STORE-BLOCKED '):]))
            final['allow_old_request_replay']=True
            fcntl.flock(descriptor,fcntl.LOCK_UN)
            process.stdin.write(b'GO\n'+canonical(final)+b'\n');process.stdin.flush()
            self.assertNotEqual(process.wait(timeout=5),0)
            self.assertIn(b'final reviewed plan differs',process.stderr.read())
            self.assertEqual((self.root/'namespaces/current.json').read_bytes(),b'old-registry')
        finally:
            os.close(descriptor)
            if process is not None:
                if process.poll() is None:process.stdin.close();process.wait(timeout=5)
                for stream in (process.stdin,process.stdout,process.stderr):stream.close()
    def test_store_bind_probe_without_host_lock_refuses(self):
        import subprocess
        result=subprocess.run([sys.executable,'-B','-u','-c',self.script],input=canonical({'plan':self.plan,'bind_probe':True})+b'\nGO\nABORT\n',capture_output=True,timeout=5)
        self.assertNotEqual(result.returncode,0)
        self.assertNotIn(b'LOCKED',result.stdout)
        self.assertFalse((self.root/self.new).exists())
    def test_live_store_writer_refuses_even_with_unheld_flock(self):
        (self.store/'WRITER.owner.json').write_text('{"released":false}')
        result=self.execute(b'PUBLISH\nRELEASE\n')
        self.assertNotEqual(result.returncode,0)
        self.assertFalse((self.root/self.new).exists())



class ResumeSurvivorTests(unittest.TestCase):
    def test_partial_removal_only_returns_exact_remaining_container(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        backend={'Id':'b'*64,'Image':'sha256:'+'1'*64,'State':{'ExitCode':0}}
        frontend={'Id':'f'*64,'Image':'sha256:'+'1'*64,'State':{'ExitCode':0}}
        plan={'compose_project':'fullmag-master','containers':{
            service:{'id':row['Id'],'image_id':row['Image'],'inspect_sha256':recovery.digest(canonical(row))}
            for service,row in [('backend',backend),('frontend',frontend)]}}
        def docker(*args,**kwargs):
            if args[0]=='ps':return SimpleNamespace(returncode=0,stderr=b'',stdout=b'')
            if args[1]=='b'*64:
                return SimpleNamespace(returncode=1,stderr=('Error: No such object: '+'b'*64+'\n').encode(),stdout=b'')
            return SimpleNamespace(returncode=0,stderr=b'',stdout=json.dumps([frontend]).encode())
        with patch.object(recovery,'docker_capture',side_effect=docker),patch('docker_volume_fresh_runtime.docker_capture',side_effect=docker),patch.object(recovery,'_validate_container'):
            self.assertEqual(set(recovery._observe_survivors(plan,allow_absent=True)),{'frontend'})
            with self.assertRaises(BuildControlError):recovery._observe_survivors(plan,allow_absent=False)
    def test_actual_lowercase_docker_cli_output_with_empty_json_is_absence(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        identifier='b'*64
        def docker(*args,**kwargs):
            if args[0]=='ps':return SimpleNamespace(returncode=0,stdout=b'',stderr=b'')
            return SimpleNamespace(returncode=1,stdout=b'[]\n',stderr=('error: no such object: '+identifier+'\n').encode())
        plan={'containers':{'backend':{'id':identifier}}}
        with patch.object(recovery,'docker_capture',side_effect=docker),patch('docker_volume_fresh_runtime.docker_capture',side_effect=docker):
            self.assertEqual(recovery._observe_survivors(plan,allow_absent=True),{})
    def test_ambiguous_stdout_is_not_absence(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        identifier='b'*64
        output=SimpleNamespace(returncode=1,stdout=b'[{"Id":"unexpected"}]\n',stderr=('error: no such object: '+identifier+'\n').encode())
        with patch.object(recovery,'docker_capture',return_value=output):
            with self.assertRaises(BuildControlError):recovery._observe_survivors({'containers':{'backend':{'id':identifier}}},allow_absent=True)
    def test_other_full_id_is_not_absence(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        output=SimpleNamespace(returncode=1,stdout=b'[]\n',stderr=('error: no such object: '+'f'*64+'\n').encode())
        with patch.object(recovery,'docker_capture',return_value=output):
            with self.assertRaises(BuildControlError):recovery._observe_survivors({'containers':{'backend':{'id':'b'*64}}},allow_absent=True)
    def test_daemon_error_is_not_proof_of_absence(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        plan={'containers':{'backend':{'id':'b'*64}}}
        with patch.object(recovery,'docker_capture',return_value=SimpleNamespace(returncode=1,stderr=b'daemon unavailable',stdout=b'')):
            with self.assertRaises(BuildControlError):recovery._observe_survivors(plan,allow_absent=True)


class ControllerCompatibilityTests(unittest.TestCase):
    def legacy_plan(self):
        profile=next(iter(recovery.CONTROLLER_COMPLETION_PROFILES.values()))
        return {'controller_sha256':profile['controller_sha256'],'transaction_sha256':profile['transaction_sha256']}
    def test_known_parser_revision_is_completion_only(self):
        proof=recovery._controller_compatibility(self.legacy_plan())
        self.assertEqual(proof['scope'],'completion-only-exact-absence')
        recovery._require_completion_absence(proof,{})
        with self.assertRaises(BuildControlError):recovery._require_completion_absence(proof,{'frontend':{'Id':'f'*64}})
    def test_compatibility_sidecar_is_immutable_and_registry_bound(self):
        import subprocess
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'namespaces').mkdir();(root/'namespaces/current.json').write_bytes(b'current-registry')
            archive=root/'namespace-recovery'/('2'*32);archive.mkdir(parents=True)
            script=recovery.COMPATIBILITY_RECEIPT_SCRIPT.replace("pathlib.Path('/control')",'pathlib.Path('+repr(str(root))+')')
            relative='namespace-recovery/'+('2'*32)+'/controller-compatibility-profile-v1.json'
            record=recovery._controller_compatibility(self.legacy_plan())
            request={'receipt_path':relative,'registry_sha256':recovery.digest(b'current-registry'),'record':record}
            def execute():return subprocess.run([sys.executable,'-B','-c',script],input=canonical(request),capture_output=True,timeout=5)
            result=execute();self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(result.stdout.decode().strip(),recovery.digest(canonical(record)+b'\n'))
            self.assertEqual(execute().returncode,0)
            original=(root/relative).read_bytes()
            request['record']={**record,'new_controller_sha256':'1'*64}
            self.assertNotEqual(execute().returncode,0)
            self.assertEqual((root/relative).read_bytes(),original)
            request['receipt_path']='namespace-recovery/'+('2'*32)+'/other.json'
            request['registry_sha256']='1'*64
            self.assertNotEqual(execute().returncode,0)
            self.assertFalse((archive/'other.json').exists())
    def test_unknown_controller_and_changed_transaction_are_refused(self):
        plan=self.legacy_plan();plan['controller_sha256']='1'*64
        with self.assertRaises(BuildControlError):recovery._controller_compatibility(plan)
        plan=self.legacy_plan();plan['transaction_sha256']='1'*64
        with self.assertRaises(BuildControlError):recovery._controller_compatibility(plan)


class HelperMountTests(unittest.TestCase):
    def helper(self):
        from types import SimpleNamespace
        control=SimpleNamespace(image='sha256:'+'1'*64,volume='control')
        row={'Id':'a'*64,'Name':'/helper','Image':control.image,'Config':{'User':'65532:65532',
             'Entrypoint':['/bin/bash'],'Cmd':['-euo','pipefail','-c','transaction']},'State':{'Running':True},
             'HostConfig':{'NetworkMode':'none','ReadonlyRootfs':True,'Privileged':False,'CapDrop':['ALL'],'CapAdd':None,
               'Mounts':[{'Type':'volume','Source':'control','Target':'/control','ReadOnly':False,'VolumeOptions':{'NoCopy':True}},
                         {'Type':'bind','Source':'/store-path','Target':'/store','ReadOnly':True},
                         {'Type':'volume','Source':'ledger','Target':'/ledger','ReadOnly':True,'VolumeOptions':{'NoCopy':True}}]}}
        row['Mounts']=[{'Type':'volume','Name':'control','Destination':'/control','RW':True},
                       {'Type':'bind','Source':'/store-path','Destination':'/store','RW':False},
                       {'Type':'volume','Name':'ledger','Destination':'/ledger','RW':False}]
        return control,row
    def authenticate(self,control,row,store_binding=None):
        from types import SimpleNamespace
        from unittest.mock import patch
        with patch.object(recovery,'docker_capture',return_value=SimpleNamespace(stdout=json.dumps([row]).encode())):
            return recovery._authenticate_helper(control,'helper','transaction',Path('/store-path'),
                                                'type=volume,src=ledger,dst=/ledger,readonly,volume-nocopy',store_binding=store_binding)
    def test_exact_raw_root_and_readonly_retained_mounts(self):
        control,row=self.helper()
        self.assertEqual(self.authenticate(control,row),'a'*64)
    def test_namespaced_control_mount_cannot_own_raw_registry_transaction(self):
        control,row=self.helper()
        row['HostConfig']['Mounts'][0]['VolumeOptions']['Subpath']='namespaces/'+'f'*32
        with self.assertRaises(BuildControlError):self.authenticate(control,row)
    def test_actual_desktop_alias_requires_matching_two_view_inode_proof(self):
        control,row=self.helper()
        alias='/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu2/281cf2742056105533c748d4d9a7bc9f43701ad4b93cc2e6f9bb330c8af04850'
        row['HostConfig']['Mounts'][1]['Source']=alias
        row['Mounts'][1]['Source']=alias
        with self.assertRaisesRegex(BuildControlError,'proof'):self.authenticate(control,row)
        metadata={'device':2096,'inode':123,'size':0,'mode':0o640,'uid':65534,'gid':65534,'links':1}
        proof={'requested_source':'/store-path','host':metadata,'helper':{**metadata,'uid':65532,'gid':65532}}
        self.assertEqual(self.authenticate(control,row,proof),'a'*64)
        proof['helper'].pop('inode')
        with self.assertRaisesRegex(BuildControlError,'proof'):self.authenticate(control,row,proof)
    def test_opaque_alias_views_must_agree(self):
        control,row=self.helper()
        alias='/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu2/'+'a'*64
        row['HostConfig']['Mounts'][1]['Source']=alias
        proof={'requested_source':'/store-path','host':{'inode':123},'helper':{'inode':123}}
        with self.assertRaises(BuildControlError):self.authenticate(control,row,proof)
    def test_runtime_store_cannot_be_writable(self):
        control,row=self.helper();row['Mounts'][1]['RW']=True
        with self.assertRaisesRegex(BuildControlError,'readonly'):self.authenticate(control,row)
    def test_writable_store_is_refused(self):
        control,row=self.helper();row['HostConfig']['Mounts'][1]['ReadOnly']=False
        with self.assertRaisesRegex(BuildControlError,'/store'):self.authenticate(control,row)
    def test_wrong_ledger_subpath_is_refused(self):
        control,row=self.helper();row['HostConfig']['Mounts'][2]['VolumeOptions']['Subpath']='other'
        with self.assertRaisesRegex(BuildControlError,'subpath'):self.authenticate(control,row)


class ShellOnlyReaderTests(unittest.TestCase):
    def test_batch_reader_needs_no_python_in_the_container(self):
        import tempfile
        from types import SimpleNamespace
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'present.json').write_bytes(b'{"present":true}\n')
            control=SimpleNamespace(path=lambda relative:str(root/relative))
            def command(_control,script):
                self.assertNotIn('python',script)
                return ['bash','-euo','pipefail','-c',script]
            with patch.object(recovery,'_read_only_control_args',side_effect=command):
                self.assertEqual(recovery._documents(control,['present.json','absent.json']),
                                 {'present.json':b'{"present":true}\n','absent.json':None})


class ReadOnlyContextTests(unittest.TestCase):
    def test_inspection_never_initializes_host_storage(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        configured={'services':{'fem-gpu-toolchain':{'build':{'args':{'FULLMAG_CUDA_BASE_IMAGE':'sha256:'+'1'*64}}}}}
        args=SimpleNamespace(repo_root=Path('/tmp'),source_root=Path('/tmp'))
        with patch('fullmag_storage.initialize_runtime',side_effect=AssertionError('must not initialize')), \
             patch('docker_development_inputs.select_checkout',return_value=Path('/tmp')), \
             patch('fullmag_storage.resolve_layout',return_value={}), \
             patch('docker_dev._compose_identity',return_value={}), \
             patch('docker_build_control.toolchain_configuration',return_value=configured), \
             patch('docker_build_control.BuildControl') as constructor:
            constructor.return_value.read.return_value={'schema':'fullmag.docker-build-operation.v1','state':'succeeded','phase':'toolchain','image_id':'sha256:'+'2'*64}
            self.assertIs(recovery._context(args)[3],constructor.return_value)


class ConsumerAndClosureTests(unittest.TestCase):
    def test_foreign_stopped_volume_consumer_is_protected(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        control=SimpleNamespace(project='fullmag-master',volume='control')
        pair={'backend':{'Id':'b'*64},'frontend':{'Id':'f'*64}}
        foreign={'Id':'a'*64,'Config':{'Labels':{}},'State':{'Running':False},
                 'Mounts':[{'Name':'control','Source':'/docker/volumes/control'}]}
        def docker(*args,**kwargs):
            data=('a'*64+'\n').encode() if args[0]=='ps' else json.dumps([foreign]).encode()
            return SimpleNamespace(stdout=data)
        with patch.object(recovery,'docker_capture',side_effect=docker):
            with self.assertRaisesRegex(BuildControlError,'foreign'):
                recovery._inventory(control,pair,Path('/state'),'ledger')
    def test_unexpected_project_helper_refused(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        control=SimpleNamespace(project='fullmag-master',volume='control')
        pair={'backend':{'Id':'b'*64},'frontend':{'Id':'f'*64}}
        foreign={'Id':'a'*64,'Config':{'Labels':{'com.docker.compose.project':'fullmag-master'}},'Mounts':[]}
        def docker(*args,**kwargs):
            data=('a'*64+'\n').encode() if args[0]=='ps' else json.dumps([foreign]).encode()
            return SimpleNamespace(stdout=data)
        with patch.object(recovery,'docker_capture',side_effect=docker):
            with self.assertRaisesRegex(BuildControlError,'helper'):
                recovery._inventory(control,pair,Path('/state'),'ledger')
    def test_active_preparation_lease_refused(self):
        from docker_volume_offline_reconcile import _validate_store_leases
        document={'schema_version':'preparation_resource_lease.v1','run_id':'run1','resource_id':'resource1',
                  'lease_token':'token1','state':'active'}
        with self.assertRaisesRegex(BuildControlError,'nonreleased'):
            _validate_store_leases('runs/run1/preparation_resource_leases/resource1/token1.json',document)
    def test_nonterminal_catalog_refused(self):
        from docker_volume_offline_reconcile import _validate_catalogs
        catalog={'schema_version':'run_catalog.v1','run_id':'run1','revision':1,
                 'tasks':[{'task_id':'task1','lifecycle':'running','artifact_ids':[]}]}
        with self.assertRaisesRegex(BuildControlError,'running'):
            _validate_catalogs([{'path':'runs/run1/run_catalog.json','document':catalog}])

if __name__=="__main__": unittest.main()
