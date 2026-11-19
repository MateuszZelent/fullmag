"""Regression coverage for failure-only interrupted diagnostic verification."""
import base64
import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import docker_volume_verification_interrupted as recovery
from docker_build_control import BuildControlError, canonical

TOKEN = 'a' * 32
PROJECT = 'fullmag-worktree-example'
VOLUME = 'fullmag-build-control-example'
IMAGE = 'sha256:' + 'b' * 64
FENCE = 'runtime-control/runtime-service/api-failure-' + 'c' * 32 + '.json'


def receipt():
    return {'schema':'fullmag.docker-build-operation.v1', 'phase':'verification',
        'state':'running', 'attempt':TOKEN, 'compose_project':PROJECT, 'control_volume':VOLUME,
        'helper_container':'fullmag-control-' + TOKEN, 'qualification':'source tests only',
        'runtime_qualification':'NOT VERIFIED', 'scope':'material-library-contracts',
        'container_id':'d' * 12, 'image_id':IMAGE,
        'commands':[['/usr/bin/env','CARGO_INCREMENTAL=0','CARGO_PROFILE_BACKEND_DEV_DEBUG=0',
          '/root/.cargo/bin/cargo','test','--locked','--profile','backend-dev','-p',
          'fullmag-api','--bin','fullmag-api','material_library']],
        'diagnostic_source_admission':{'schema':'fullmag.pre-owner-diagnostic-source-check.v1',
          'owner_absent':True,'process_receipt_absent':True,'native_processes':0,
          'active_reservations':0,'active_local_leases':0,'active_session':False,
          'api_health':'degraded','api_instance_id':'09cda4aa-52bd-4445-a20d-14d140977dc4',
          'fence_sha256':'e'*64},
        'inputs':{}}


def stopped(identifier):
    return {'Id':identifier, 'Image':IMAGE,
       'State':{'Running':False,'Status':'exited','Pid':0,'ExitCode':255,
          'OOMKilled':False,'Paused':False,'Restarting':False,'Dead':False,
          'StartedAt':'2026-11-18T05:05:30.083824556Z',
          'FinishedAt':'2026-11-18T06:43:26.783469002Z'},
       'Config':{'Labels':{'com.docker.compose.project':PROJECT,
                          'org.fullmag.source.worktree-id':'example'}}}


class ReceiptTests(unittest.TestCase):
    def test_retained_gpu_without_startup_script_is_eligible(self):
        environment={'FULLMAG_DOCKER_DEVICE_ACCESS':'gpu','FULLMAG_HOST_LEDGER_PROFILE':'group-ledger-v1'}
        recovery.validate_startup_intent(environment)
        for change in ({'FULLMAG_DOCKER_DEVICE_ACCESS':'cpu'},
                       {'FULLMAG_DOCKER_DEVICE_ACCESS':'auto'},
                       {'FULLMAG_STARTUP_ENABLED':'1'},
                       {'FULLMAG_STARTUP_ENABLED':'0'},
                       {'FULLMAG_STARTUP_SCRIPT':'/opt/fullmag/source/example.py'},
                       {'FULLMAG_STARTUP_PROVENANCE_SHA256':'a'*64}):
            with self.subTest(change=change),self.assertRaises(BuildControlError):
                recovery.validate_startup_intent({**environment,**change})
        with self.assertRaises(BuildControlError):
            recovery.validate_startup_intent({})

    def test_only_diagnostic_source_verification_is_eligible(self):
        recovery.validate_receipt(receipt(), TOKEN, PROJECT, VOLUME)
        for key,value in [('phase','development'),('state','succeeded'),
                          ('scope','all'),('qualification','runtime'),
                          ('attempt','f'*32),('control_volume','other')]:
            with self.subTest(key=key):
                candidate=receipt(); candidate[key]=value
                with self.assertRaises(BuildControlError):
                    recovery.validate_receipt(candidate,TOKEN,PROJECT,VOLUME)
        for key,value in [('owner_absent',False),('active_session',True),
                          ('native_processes',1),('active_reservations',1),
                          ('active_local_leases',1)]:
            candidate=receipt(); candidate['diagnostic_source_admission'][key]=value
            with self.assertRaises(BuildControlError):
                recovery.validate_receipt(candidate,TOKEN,PROJECT,VOLUME)

    def test_stopped_pair_requires_exact_external_exit_and_incarnation(self):
        original=stopped('d'*64)
        recovery.validate_stopped(original,'d'*64,IMAGE,original['State']['StartedAt'],PROJECT,'example')
        for key,value in [('Running',True),('Pid',3),('ExitCode',0),('OOMKilled',True),
                          ('Restarting',True),('Dead',True),('FinishedAt','')]:
            candidate=copy.deepcopy(original); candidate['State'][key]=value
            with self.subTest(key=key),self.assertRaises(BuildControlError):
                recovery.validate_stopped(candidate,'d'*64,IMAGE,original['State']['StartedAt'],PROJECT,'example')

    def test_failure_reason_is_exact_with_only_one_optional_final_lf(self):
        for value in [recovery.FAILURE_REASON,recovery.FAILURE_REASON+'\n']:
            recovery.validate_reason(value)
        for value in [recovery.FAILURE_REASON+'\n\n',recovery.FAILURE_REASON+'\r\n',
                      recovery.FAILURE_REASON.replace('invalid digit','timeout'),
                      'native Docker host profile initialization failed: other']:
            with self.assertRaises(BuildControlError): recovery.validate_reason(value)

    def test_guest_rejects_owner_config_ledger_and_unknown_store_content(self):
        value={'boot_id':'d90abd2d-26ca-462d-9366-4193847a4c2e',
               'control':{},'runtime':{},'ledger':{'directories':['.'],'files':{}},
               'store':{'directories':['.'],'files':{}}}
        recovery.validate_empty_namespace(value)
        for target in ['runtime','ledger','store']:
            changed=copy.deepcopy(value)
            if target=='runtime':changed[target]['runtime-control/runtime-services/OWNER.json']='a'*64
            else:changed[target]['files']['HOST_RESOURCE_LEDGER.json']='a'*64
            with self.assertRaises(BuildControlError):recovery.validate_empty_namespace(changed)

    def test_observation_mount_is_read_only_and_transaction_mount_explicit(self):
        class Control:
            volume='owned-volume'
            def helper_args(self,command,name=None):
                return ['docker','run','--memory','64m','--mount',
                        'type=volume,src=owned-volume,dst=/control,volume-nocopy',
                        '--entrypoint','/bin/bash','old-image',command]
        control=Control()
        for readonly in (True,False):
            probe,arguments=recovery._probe_args(control,IMAGE,'observe',Path('D:/owned/store'),readonly=readonly)
            control_mount=next(value for value in arguments if 'dst=/control,' in value)
            self.assertEqual('readonly' in control_mount,readonly)
            self.assertTrue(any('dst=/host-ledger,readonly,volume-nocopy,volume-subpath=private/ledger' in value
                                for value in arguments))
            self.assertEqual(probe.image,IMAGE)

    def test_guest_uses_existing_lock_and_canonical_ledger_without_lifecycle(self):
        import ast
        code=recovery._guest_code('a'*64)
        ast.parse(code)
        self.assertIn('runtime.HOST_LEDGER_ROOT',code)
        self.assertIn('fcntl.LOCK_EX|fcntl.LOCK_NB',code)
        self.assertIn('fcntl.LOCK_SH|fcntl.LOCK_NB',code)
        self.assertNotIn('initialize_host_configuration(',code)
        self.assertNotIn('docker start',code)
        self.assertNotIn('docker stop',code)

    def test_journal_mkdir_before_payload_has_no_receipt_authority(self):
        entries=['receipt.json f','build.log f','interrupted-reconciliation d']
        self.assertEqual(recovery.validate_attempt_artifacts(entries),['receipt.json','build.log'])
        with self.assertRaises(BuildControlError):
            recovery.validate_attempt_artifacts([*entries,'terminal.json f'])

    def test_helper_normalizes_observed_desktop_bind_source(self):
        import os
        from types import SimpleNamespace
        from docker_compose_identity import source_labels
        identity={'project_name':PROJECT,'project_id':'project-example',
                  'worktree_id':'example','checkout_kind':'worktree'}
        control=SimpleNamespace(project=PROJECT,volume=VOLUME,image=IMAGE,labels={},identity=identity)
        name='reconcile-example';command='observe-only'
        labels={**source_labels(identity),'com.docker.compose.project':PROJECT,
                'com.docker.compose.service':'build-control'}
        with tempfile.TemporaryDirectory() as directory:
            store=Path(directory)/'session-store';store.mkdir()
            source=store.as_posix()
            if os.name=='nt':source='/run/desktop/mnt/host/'+source[0].lower()+'/'+source[3:]
            row={'Id':'c'*64,'Name':'/'+name,'Image':IMAGE,
                 'Config':{'Image':IMAGE,'User':'65532:65532','Entrypoint':['/bin/bash'],
                           'Cmd':['-euo','pipefail','-c',command],'Labels':labels},
                 'State':{'Running':True,'Pid':123},
                 'HostConfig':{'NetworkMode':'none','ReadonlyRootfs':True,'Privileged':False,
                               'CapDrop':['ALL'],'Binds':None,'Tmpfs':None,
                               'Mounts':[{'Type':'volume','Source':VOLUME,'Target':'/control',
                                          'ReadOnly':False,'VolumeOptions':{'NoCopy':True}},
                                         {'Type':'bind','Source':source,'Target':'/store','ReadOnly':True},
                                         {'Type':'volume','Source':VOLUME,'Target':'/host-ledger',
                                          'ReadOnly':True,'VolumeOptions':{'NoCopy':True,'Subpath':'private/ledger'}}]}}
            def validate(value):
                with patch.object(recovery,'docker_capture',return_value=SimpleNamespace(stdout=json.dumps([value]).encode())):
                    return recovery._validate_helper(control,name,command,store)
            self.assertEqual(validate(row),'c'*64)
            for target,key,value in [('/store','Source',source+'-foreign'),('/store','ReadOnly',False),
                                     ('/host-ledger','VolumeOptions',{'NoCopy':True,'Subpath':'foreign'})]:
                altered=copy.deepcopy(row)
                next(m for m in altered['HostConfig']['Mounts'] if m['Target']==target)[key]=value
                with self.subTest(target=target,key=key),self.assertRaises(BuildControlError):validate(altered)

    def test_generated_guest_handshake_accepts_real_commit_lf(self):
        import ast
        import subprocess
        import sys
        code=recovery._guest_code('a'*64)
        statement=next(node for node in ast.parse(code).body if isinstance(node,ast.If)
                       and 'Host did not revalidate Docker state' in ast.get_source_segment(code,node))
        fragment='import sys\n'+ast.get_source_segment(code,statement)+'\nprint("HANDSHAKE-ACCEPTED")\n'
        for raw,expected in [(b'COMMIT\n',0),(b'COMMIT\\n',1)]:
            result=subprocess.run([sys.executable,'-B','-c',fragment],input=raw,
                                  stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10)
            with self.subTest(raw=raw):
                self.assertEqual(result.returncode,expected,result.stderr.decode())
                self.assertEqual(b'HANDSHAKE-ACCEPTED' in result.stdout,expected==0)

    def test_unknown_commands_are_not_source_test_authority(self):
        candidate=receipt(); candidate['commands']=[['/bin/bash','-c','anything']]
        with self.assertRaises(BuildControlError):recovery.validate_receipt(candidate,TOKEN,PROJECT,VOLUME)


class TransactionTests(unittest.TestCase):
    def fixture(self, root):
        original=canonical(receipt())+b'\n'
        records={'active':(TOKEN+'\n').encode(),
                 'verification/attempts/'+TOKEN+'/receipt.json':original,
                 'verification/attempts/'+TOKEN+'/build.log':b'preserved log\n',
                 'verification/current.json':b'previous-current\n',
                 'verification/verified.json':b'previous-verified\n',
                 FENCE:b'original fence'}
        for name,raw in records.items():
            path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(raw)
        payload=recovery.transaction_payload(TOKEN,records,receipt(),{'schema':recovery.SCHEMA,
                   'boot_id':'d90abd2d-26ca-462d-9366-4193847a4c2e','finished_at':123.0})
        return records,payload

    def test_commit_preserves_proof_logs_fence_and_verified(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);records,payload=self.fixture(root);observed=[]
            recovery.commit_locked(root,payload,lambda:observed.append('checked'))
            self.assertTrue(observed)
            self.assertFalse((root/'active').exists())
            result=json.loads((root/('verification/attempts/'+TOKEN+'/terminal.json')).read_bytes())
            self.assertEqual(result['state'],'failed-confirmed')
            self.assertEqual(result['verification_outcome'],'interrupted')
            self.assertEqual(result['runtime_qualification'],'NOT VERIFIED')
            for name in [FENCE,'verification/verified.json','verification/attempts/'+TOKEN+'/build.log']:
                self.assertEqual((root/name).read_bytes(),records[name])
            archive=root/('verification/attempts/'+TOKEN+'/interrupted-reconciliation/original/receipt.json')
            self.assertEqual(archive.read_bytes(),records['verification/attempts/'+TOKEN+'/receipt.json'])

    def test_compare_and_swap_failure_does_not_release_active(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);records,payload=self.fixture(root)
            (root/FENCE).write_bytes(b'changed')
            with self.assertRaises(RuntimeError):recovery.commit_locked(root,payload,lambda:None)
            self.assertEqual((root/'active').read_bytes(),records['active'])
            self.assertFalse((root/('verification/attempts/'+TOKEN+'/terminal.json')).exists())

    def test_revalidation_refusal_keeps_all_control_records(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);records,payload=self.fixture(root)
            def refuse():raise RuntimeError('new consumer')
            with self.assertRaises(RuntimeError):recovery.commit_locked(root,payload,refuse)
            for name,raw in records.items():self.assertEqual((root/name).read_bytes(),raw)

    def test_replay_after_partial_publication_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);records,payload=self.fixture(root)
            def interrupt(stage):
                if stage=='receipt-published':raise RuntimeError('observer interrupted')
            with self.assertRaises(RuntimeError):
                recovery.commit_locked(root,payload,lambda:None,interrupt)
            self.assertTrue((root/'active').exists())
            recovery.commit_locked(root,payload,lambda:None)
            recovery.commit_locked(root,payload,lambda:None)
            self.assertFalse((root/'active').exists())

    def test_atomic_publication_crash_without_cleanup_keeps_single_link(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);records,payload=self.fixture(root)
            with patch.object(recovery,'_sync_directory',side_effect=RuntimeError('crash after publication')):
                with patch.object(Path,'unlink',return_value=None):
                    with self.assertRaises(RuntimeError):
                        recovery.commit_locked(root,payload,lambda:None)
            published=root/('verification/attempts/'+TOKEN+'/interrupted-reconciliation/payload.json')
            self.assertTrue(published.exists())
            self.assertEqual(published.stat().st_nlink,1)
            recovery.commit_locked(root,payload,lambda:None)
            self.assertFalse((root/'active').exists())

    def journal_observation(self, root):
        journal=root/('verification/attempts/'+TOKEN+'/interrupted-reconciliation')
        if not journal.exists():return {'directories':[],'files':{}}
        files={};directories=[]
        for path in [journal,*journal.rglob('*')]:
            relative=path.relative_to(journal).as_posix()
            if path.is_dir():directories.append(relative)
            else:files[relative]=base64.b64encode(path.read_bytes()).decode()
        return {'directories':sorted(directories),'files':files}

    def observe_and_apply(self, root, payload):
        attempt=root/('verification/attempts/'+TOKEN)
        entries=[path.name+(' d' if path.is_dir() else ' f') for path in attempt.iterdir()]
        prepared=(attempt/'interrupted-reconciliation/payload.json').exists()
        recovery.validate_attempt_artifacts(entries,prepared)
        def revalidate():recovery.validate_journal(payload,self.journal_observation(root))
        revalidate()
        recovery.commit_locked(root,payload,revalidate)

    def test_mkdir_before_payload_reobserves_and_replays_same_plan(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);records,payload=self.fixture(root)
            def mkdir_then_interrupt(path,raw,immutable,temporary_root):
                path.parent.mkdir(parents=True,exist_ok=True)
                raise RuntimeError('crash after journal mkdir')
            with patch.object(recovery,'_publish',side_effect=mkdir_then_interrupt):
                with self.assertRaises(RuntimeError):recovery.commit_locked(root,payload,lambda:None)
            journal=root/('verification/attempts/'+TOKEN+'/interrupted-reconciliation')
            self.assertTrue(journal.is_dir());self.assertFalse((journal/'payload.json').exists())
            self.observe_and_apply(root,payload)
            self.assertFalse((root/'active').exists())

    def test_before_terminal_rename_keeps_internal_temp_and_replays(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);records,payload=self.fixture(root)
            replace=recovery.os.replace
            def interrupt_terminal(source,destination):
                if Path(destination).name=='terminal.json':raise RuntimeError('crash before terminal rename')
                return replace(source,destination)
            with patch.object(recovery.os,'replace',side_effect=interrupt_terminal):
                with self.assertRaises(RuntimeError):recovery.commit_locked(root,payload,lambda:None)
            attempt=root/('verification/attempts/'+TOKEN)
            self.assertFalse(list(attempt.glob('.verification-reconcile-*')))
            self.assertTrue(list((attempt/'interrupted-reconciliation/temporary').iterdir()))
            self.observe_and_apply(root,payload)
            self.assertFalse((root/'active').exists())

    def test_partial_temp_is_preserved_by_hash_and_never_used_as_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);records,payload=self.fixture(root)
            journal=root/('verification/attempts/'+TOKEN+'/interrupted-reconciliation')
            temporary=journal/'temporary';temporary.mkdir(parents=True)
            payload_raw=canonical(payload)+b'\n'
            partial=payload_raw[:37]
            (temporary/recovery._temporary_name(journal/'payload.json',payload_raw)).write_bytes(partial)
            self.observe_and_apply(root,payload)
            retained=temporary/('retained-'+hashlib.sha256(partial).hexdigest())
            self.assertEqual(retained.read_bytes(),partial)
            self.assertFalse((root/'active').exists())
            changed=self.journal_observation(root)
            changed['files'][retained.relative_to(journal).as_posix()]=base64.b64encode(b'forged').decode()
            with self.assertRaises(RuntimeError):recovery.validate_journal(payload,changed)

    def test_other_active_token_and_preexisting_terminal_refuse(self):
        for kind in ['active','terminal']:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                root=Path(directory);records,payload=self.fixture(root)
                path=root/('active' if kind=='active' else 'verification/attempts/'+TOKEN+'/terminal.json')
                path.write_bytes(b'unrelated')
                with self.assertRaises(RuntimeError):recovery.commit_locked(root,payload,lambda:None)

    def test_transaction_writes_only_selected_verification_and_active(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);records,payload=self.fixture(root)
            self.assertEqual(set(payload),{'schema','attempt','pins','original','final','proof'})
            self.assertTrue(all(name.startswith('verification/') or name in ['active',FENCE]
                                for name in payload['pins']))
            recovery.commit_locked(root,payload,lambda:None)
            self.assertFalse(any((root/name).exists() for name in ['runtime-control/runtime-services/OWNER.json',
                     'runtime-control/runtime-service/docker-all.json','private/ledger/ledger/HOST_RESOURCE_LEDGER.json']))


if __name__=='__main__': unittest.main()
