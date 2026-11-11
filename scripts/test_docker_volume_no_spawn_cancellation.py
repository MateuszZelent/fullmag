"""Regression checks for the managed wrapper of native WorkerNoSpawn."""
from copy import deepcopy
from contextlib import contextmanager
import json
import hashlib
import os
from pathlib import Path
import subprocess
import stat
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

from docker_build_control import BuildControlError, canonical
import docker_volume_no_spawn_cancellation as target


def fixture():
    identity={'store_id':'sha256:'+'1'*64,'run_id':'run-a','task_id':'task-a',
              'resource_id':'cpu-a','lease_token':'lease-a',
              'owner':{'kind':'solver','attempt_id':'attempt-a','ownership_epoch':1}}
    owner={'state':'failed','target_id':'docker-all'}
    probe={'schema':target.PROBE_SCHEMA,'owner':owner,'owner_sha256':'2'*64,
           'config_sha256':'3'*64,'claim':{'run_id':'run-a'},'lease':{'state':'active'},
           'reservation':{'identity':identity,'state':'committed','worker_launch_gate':{'state':'pending'}},
           'task':{'lifecycle':'preparing'},'other_active_reservations':[],
           'process_receipt_sha256':'4'*64,'native_processes_absent':True,
           'native_binary_sha256':'5'*64}
    request={'schema_version':target.NATIVE_SCHEMA,'request_id':'12345678-1234-4234-8234-123456789abc',
             'config_sha256':probe['config_sha256'],'owner_sha256':probe['owner_sha256'],
             'expected_owner':owner,'claim_sha256':target.sha(canonical(probe['claim'])),
             'lease_sha256':target.sha(canonical(probe['lease'])),
             'reservation_sha256':target.sha(canonical(probe['reservation'])),
             'identity':identity,'reason':'Cancel one confirmed unspawned attempt'}
    return request,probe


class RequestTests(unittest.TestCase):
    def test_exact_request_is_accepted_without_mutation(self):
        request,probe=fixture();before=deepcopy(probe)
        target.validate_request(request,probe,'4'*64)
        self.assertEqual(probe,before)

    def test_drift_or_live_work_blocks_before_native_invocation(self):
        for key in ('owner','config','claim','lease','reservation','gate','other','process','native'):
            with self.subTest(key=key):
                request,probe=fixture()
                if key=='owner':probe['owner_sha256']='6'*64
                elif key=='config':probe['config_sha256']='6'*64
                elif key in ('claim','lease','reservation'):probe[key]['changed']=True
                elif key=='gate':probe['reservation']['worker_launch_gate']={'state':'consumed','token':'a'}
                elif key=='other':probe['other_active_reservations']=[{'identity':'foreign'}]
                elif key=='process':probe['process_receipt_sha256']='6'*64
                else:probe['native_processes_absent']=False
                with self.assertRaises(BuildControlError):target.validate_request(request,probe,'4'*64)

    def test_native_request_is_strict_and_portable(self):
        for field,value in [('request_id','not-a-uuid'),('reason',''),('claim_sha256','bad'),
                            ('schema_version','other')]:
            with self.subTest(field=field):
                request,probe=fixture();request[field]=value
                with self.assertRaises(BuildControlError):target.validate_request(request,probe,'4'*64)
        request,probe=fixture();request['unknown']=True
        with self.assertRaises(BuildControlError):target.validate_request(request,probe,'4'*64)

    def test_terminal_result_requires_both_releases_and_closed_gate(self):
        request,probe=fixture()
        probe['lease']['state']='released';probe['task']['lifecycle']='cancelled'
        probe['reservation'].update(state='released',worker_launch_gate={'state':'closed'},release_proof_sha256='a'*64)
        result={'schema_version':target.NATIVE_SCHEMA,'request_id':request['request_id'],
                'status':'cancelled_no_spawn','run_id':'run-a','task_id':'task-a','release_proof_sha256':'a'*64}
        target.validate_result(request,result,probe)
        for key in ('lease','reservation','gate','task','proof','scope'):
            with self.subTest(key=key):
                p=deepcopy(probe);r=deepcopy(result)
                if key in ('lease','reservation'):p[key]['state']='active'
                elif key=='gate':p['reservation']['worker_launch_gate']={'state':'pending'}
                elif key=='task':p['task']['lifecycle']='stopping'
                elif key=='proof':r['release_proof_sha256']='b'*64
                else:r['run_id']='other'
                with self.assertRaises(BuildControlError):target.validate_result(request,r,p)


def authority_fixture():
    source=Path('/selected');attempt='a'*32;cid='c'*64;image='sha256:'+'b'*64
    class Control:
        project='fullmag-test';volume='control';namespace='namespaces/'+'d'*32
        identity={'project_id':'project','worktree_id':'worktree'}
        def subpath(self,value):return self.namespace+'/'+value
        def read_bytes(self,path,**kwargs):
            if path not in self.records and kwargs.get('optional'):return None
            return self.records[path]
    control=Control()
    compose={'name':control.project,'services':{'backend':{'image':image,'volumes':[
        {'type':'bind','source':str(source),'target':'/opt/fullmag/source','read_only':True},
        {'type':'bind','source':'/storage/runtime','target':'/state'},
        {'type':'bind','source':'/storage/results','target':'/user-data'},
        {'type':'volume','source':'control','target':'/opt/fullmag/control','volume':{'subpath':control.namespace}},
        {'type':'volume','source':'control','target':'/host-ledger','volume':{'subpath':control.subpath('private/ledger')}},
    ]}},'volumes':{'control':{'name':'control'}}}
    config=target.sha(canonical(compose))
    previous={'schema':'fullmag.docker-build-operation.v1','phase':'development','state':'failed-confirmed',
              'attempt':attempt,'compose_project':control.project,'control_volume':control.volume,
              'control_namespace':control.namespace,'state_root':'/storage/runtime','finished_at':2.0,
              'inputs':{'source_root':str(source),'image_id':image,'source_project_id':'project','source_worktree_id':'worktree'}}
    witness={'schema':'fullmag.docker-build-operation.v1','phase':'iteration','state':'succeeded','attempt':'e'*32,
             'compose_project':control.project,'control_volume':control.volume,'control_namespace':control.namespace,
             'config_sha256':config,'state_root':previous['state_root'],'backend_container':cid,'frontend_container':'f'*64,
             'source_commit':'1'*40,'source_digest':'2'*64,'source_snapshot_sha256':'3'*64,
             'backend_started_at':'2026-11-11T15:39:35.464703989Z',
             'backend_build_receipt_sha256':'4'*64,'started_at':3.0,'finished_at':4.0,'ui_mode':'gui',
             'inputs':{'attempt':attempt,'config_sha256':config,'source_root':str(source),'image_id':image}}
    path='iteration/attempts/'+witness['attempt']+'/terminal.json'
    raw=canonical(previous);wr=canonical(witness)
    # A failed DEV never becomes verified: retain the earlier unrelated success.
    old_verified=deepcopy(previous)
    old_verified.update(state='succeeded',attempt='8'*32,config_sha256='7'*64,backend_container='6'*64)
    control.records={'development/current.json':raw,'development/verified.json':canonical(old_verified),
        'development/attempts/'+attempt+'/terminal.json':raw,
        'development/attempts/'+attempt+'/compose.json':canonical(compose),
        path:wr,path.replace('terminal.json','receipt.json'):wr,'iteration/verified.json':wr}
    args=SimpleNamespace(backend_container_id=cid,image_id=image,runtime_witness=path,runtime_witness_sha256=target.sha(wr))
    return control,previous,compose,source,args,witness


class DevelopmentAuthorityTests(unittest.TestCase):
    def test_early_failed_development_uses_existing_exact_recovery_validators_without_writes(self):
        control,previous,compose,source,args,_=authority_fixture();before=deepcopy(control.records)
        pins,witness=target.development_authority(control,canonical(previous),canonical(compose),source,args)
        self.assertEqual(control.records,before)
        self.assertEqual(witness,{'path':args.runtime_witness,'sha256':args.runtime_witness_sha256,
                                  'backend_started_at':'2026-11-11T15:39:35.464703989Z'})
        self.assertIn('resume/verified.json',pins)
        self.assertIn('iteration/verified.json',pins)
        self.assertIn(args.runtime_witness.replace('terminal.json','receipt.json'),pins)
        self.assertIn('development/verified.json',pins)
        self.assertNotIn('config_sha256',previous)
        self.assertNotEqual(pins['development/verified.json'],canonical(previous))
        self.assertEqual(pins['development/verified.json'],before['development/verified.json'])

    def test_runtime_incarnation_must_match_selected_witness(self):
        control,previous,compose,source,args,_=authority_fixture()
        _,witness=target.development_authority(control,canonical(previous),canonical(compose),source,args)
        actual={'State':{'StartedAt':witness['backend_started_at']}}
        target.validate_runtime_incarnation(actual,witness)
        actual['State']['StartedAt']='2026-11-11T16:39:35.464703989Z'
        with self.assertRaisesRegex(BuildControlError,'witness incarnation'):
            target.validate_runtime_incarnation(actual,witness)
        target.validate_runtime_incarnation(actual,None)

    def test_recovery_witness_without_incarnation_is_rejected(self):
        control,previous,compose,source,args,witness=authority_fixture()
        del witness['backend_started_at'];raw=canonical(witness)
        for path in (args.runtime_witness,args.runtime_witness.replace('terminal.json','receipt.json'),'iteration/verified.json'):
            control.records[path]=raw
        args.runtime_witness_sha256=target.sha(raw)
        with self.assertRaisesRegex(BuildControlError,'backend incarnation'):
            target.development_authority(control,canonical(previous),canonical(compose),source,args)

    def test_runtime_witness_cli_pins_are_paired_and_confined(self):
        for path,digest in ((None,'0'*64),('iteration/attempts/'+'e'*32+'/terminal.json',None),
                            ('../terminal.json','0'*64),('resume/attempts/'+'e'*32+'/terminal.json','BAD')):
            with self.subTest(path=path,digest=digest),self.assertRaises(ValueError):
                target.runtime_witness_pin(SimpleNamespace(runtime_witness=path,runtime_witness_sha256=digest))

    def test_wrong_or_missing_recovery_authority_fails_closed(self):
        for mutation in ('missing','digest','receipt','verified','container','image','source','namespace','project',
                         'worktree','config','null-config','unknown','future','prior-source','stopped','mount'):
            with self.subTest(mutation=mutation):
                control,previous,compose,source,args,witness=authority_fixture()
                if mutation=='missing':args.runtime_witness=args.runtime_witness_sha256=None
                elif mutation=='digest':args.runtime_witness_sha256='0'*64
                elif mutation=='receipt':control.records[args.runtime_witness.replace('terminal.json','receipt.json')]=b'{}'
                elif mutation=='verified':control.records['iteration/verified.json']=b'{}'
                elif mutation=='worktree':previous['inputs']['source_worktree_id']='foreign'
                elif mutation=='config':previous['config_sha256']='0'*64
                elif mutation=='null-config':previous['config_sha256']=None
                elif mutation=='unknown':previous['state']='outcome-unknown'
                elif mutation=='mount':compose['services']['backend']['volumes'][0]['read_only']=False
                else:
                    if mutation=='container':witness['backend_container']='0'*64
                    elif mutation=='image':witness['inputs']['image_id']='sha256:'+'0'*64
                    elif mutation=='source':witness['inputs']['source_root']='/foreign'
                    elif mutation=='namespace':witness['control_namespace']='foreign'
                    elif mutation=='project':witness['compose_project']='foreign'
                    elif mutation=='future':witness['started_at']=1.0
                    elif mutation=='prior-source':previous['source_digest']='0'*64
                    else:witness['idle_backend_stopped']=True
                    wr=canonical(witness)
                    for path in (args.runtime_witness,args.runtime_witness.replace('terminal.json','receipt.json'),'iteration/verified.json'):control.records[path]=wr
                    args.runtime_witness_sha256=target.sha(wr)
                raw=canonical(previous)
                for path in ('development/current.json','development/attempts/'+previous['attempt']+'/terminal.json'):control.records[path]=raw
                with self.assertRaises((ValueError,BuildControlError)):
                    target.development_authority(control,raw,canonical(compose),source,args)

    def test_explicit_superseded_resume_is_not_latest_runtime_authority(self):
        control,previous,compose,source,args,witness=authority_fixture()
        older=deepcopy(witness);older.update(phase='resume',attempt='9'*32,started_at=2.2,finished_at=2.5)
        path='resume/attempts/'+older['attempt']+'/terminal.json';raw=canonical(older)
        control.records.update({path:raw,path.replace('terminal.json','receipt.json'):raw,'resume/verified.json':raw})
        args.runtime_witness=path;args.runtime_witness_sha256=target.sha(raw)
        with self.assertRaisesRegex(BuildControlError,'latest verified'):
            target.development_authority(control,canonical(previous),canonical(compose),source,args)

    def test_every_recovery_read_is_cas_pinned_including_absent_resume(self):
        for changed in ('development/verified.json','iteration/verified.json','resume/verified.json','witness','receipt'):
            with self.subTest(changed=changed):
                control,previous,compose,source,args,_=authority_fixture()
                pins,_=target.development_authority(control,canonical(previous),canonical(compose),source,args)
                path=args.runtime_witness if changed=='witness' else args.runtime_witness.replace('terminal.json','receipt.json') if changed=='receipt' else changed
                control.records[path]=b'{}'
                with self.assertRaisesRegex(BuildControlError,'CAS changed'):target.validate_authority_pins(control,pins)

    def test_succeeded_authority_still_requires_its_own_verified_record(self):
        control,previous,compose,source,args,_=authority_fixture()
        previous.update(state='succeeded',config_sha256=target.sha(canonical(compose)),backend_container=args.backend_container_id)
        raw=canonical(previous)
        control.records['development/attempts/'+previous['attempt']+'/terminal.json']=raw
        args.runtime_witness=args.runtime_witness_sha256=None
        with self.assertRaisesRegex(BuildControlError,'retained development authority'):
            target.development_authority(control,raw,canonical(compose),source,args)

    def test_succeeded_authority_remains_compatible_without_witness(self):
        control,previous,compose,source,args,_=authority_fixture()
        previous.update(state='succeeded',config_sha256=target.sha(canonical(compose)),backend_container=args.backend_container_id)
        raw=canonical(previous)
        for path in ('development/current.json','development/verified.json','development/attempts/'+previous['attempt']+'/terminal.json'):control.records[path]=raw
        args.runtime_witness=args.runtime_witness_sha256=None
        _,witness=target.development_authority(control,raw,canonical(compose),source,args)
        self.assertIsNone(witness)



class ShellRouteTests(unittest.TestCase):
    def test_fixed_route_keeps_argv_without_host_build_profile_or_shell_evaluation(self):
        root=Path(__file__).resolve().parent.parent
        with tempfile.TemporaryDirectory() as folder:
            folder=Path(folder);fake=folder/'python';log=folder/'argv.json'
            fake.write_text('#!'+sys.executable+'\nimport json,pathlib,sys\n'
                            'if "-c" in sys.argv:sys.exit(0)\n'
                            'pathlib.Path('+repr(str(log))+').write_text(json.dumps(sys.argv[1:]))\n')
            fake.chmod(0o755)
            env=dict(os.environ,FULLMAG_STORAGE_PYTHON=str(fake))
            source='/tmp/source; never-evaluate'
            command=('python3 "'+str(root/'scripts/docker_volume_no_spawn_cancellation.py')+'" '
                     "--source-root '"+source+"' --backend-container-id '"+'a'*64+"' "
                     "--image-id 'sha256:"+'b'*64+"' --process-receipt-sha256 '"+'c'*64+"' "
                     "--request '/tmp/request.json' --request-sha256 '"+'d'*64+"' --apply")
            result=subprocess.run(['bash',str(root/'scripts/just_storage_shell.sh'),command],
                                  env=env,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            argv=json.loads(log.read_text())
            self.assertEqual(argv[:2],['-B',str(root/'scripts/docker_volume_no_spawn_cancellation.py')])
            self.assertEqual(argv[argv.index('--source-root')+1],source)
            self.assertEqual(argv[-1],'--apply')
            reconcile=command+" --reconcile-loader-failure '"+'e'*32+"' --failed-receipt-sha256 '"+'f'*64+"'"
            result=subprocess.run(['bash',str(root/'scripts/just_storage_shell.sh'),reconcile],
                                  env=env,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(json.loads(log.read_text())[-4:],
                             ['--reconcile-loader-failure','e'*32,'--failed-receipt-sha256','f'*64])
            witness="iteration/attempts/"+'9'*32+"/terminal.json"
            with_witness=reconcile+" --runtime-witness '"+witness+"' --runtime-witness-sha256 '"+'8'*64+"'"
            result=subprocess.run(['bash',str(root/'scripts/just_storage_shell.sh'),with_witness],env=env,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(json.loads(log.read_text())[-4:],["--runtime-witness",witness,"--runtime-witness-sha256",'8'*64])
            preview=command.removesuffix(' --apply')+" --runtime-witness '"+witness+"' --runtime-witness-sha256 '"+'8'*64+"'"
            result=subprocess.run(['bash',str(root/'scripts/just_storage_shell.sh'),preview],env=env,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertNotIn('--apply',json.loads(log.read_text()))
            self.assertEqual(json.loads(log.read_text())[-4:],["--runtime-witness",witness,"--runtime-witness-sha256",'8'*64])
            for invalid in (command+" --runtime-witness '"+witness+"'",with_witness+'; true',with_witness.replace(witness,'../terminal.json')):
                log.unlink(missing_ok=True)
                result=subprocess.run(['bash',str(root/'scripts/just_storage_shell.sh'),invalid],env=env,capture_output=True,text=True)
                self.assertEqual(result.returncode,2)
                self.assertFalse(log.exists())
            log.unlink(missing_ok=True)
            result=subprocess.run(['bash',str(root/'scripts/just_storage_shell.sh'),command+'; true'],
                                  env=env,capture_output=True,text=True)
            self.assertEqual(result.returncode,2)
            self.assertFalse(log.exists())


class BinaryPinTests(unittest.TestCase):
    def test_published_hardlink_is_hashable_but_symlink_or_writable_file_is_not(self):
        scope={'os':os,'stat':stat,'hashlib':hashlib}
        exec(target.BINARY_HASH,scope)
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);original=root/'original';binary=root/'native'
            original.write_bytes(b'published ELF stand-in');original.chmod(0o555)
            os.link(original,binary)
            self.assertEqual(scope['binary_sha'](binary),hashlib.sha256(binary.read_bytes()).hexdigest())
            link=root/'link';link.symlink_to(binary)
            with self.assertRaises(OSError):scope['binary_sha'](link)
            binary.chmod(0o755)
            with self.assertRaises(RuntimeError):scope['binary_sha'](binary)


class NativeEnvironmentTests(unittest.TestCase):
    def test_exec_prepares_image_cpu_abi_before_loader_and_native_environment(self):
        with mock.patch.dict(os.environ,{'LD_LIBRARY_PATH':'/package/lib'},clear=True):
            def configure():os.environ['LD_LIBRARY_PATH']+=':/usr/local/cuda/compat'
            runtime=SimpleNamespace(process_environment=lambda paths,service:dict(os.environ))
            scope={'runtime_service':runtime}
            exec(target.NATIVE_ENVIRONMENT,scope)
            with mock.patch.dict(sys.modules,{'entrypoint':SimpleNamespace(_configure_device_access=configure)}),\
                 mock.patch('subprocess.run',return_value=SimpleNamespace(returncode=0,stdout=b'libcuda => /usr/local/cuda/compat/libcuda.so.1',stderr=b'')) as run:
                environment=scope['native_environment'](object(),Path('/package/bin/native'))
            self.assertEqual(environment['LD_LIBRARY_PATH'],'/package/lib:/usr/local/cuda/compat')
            self.assertEqual(run.call_args.args[0],['/usr/bin/ldd','/package/bin/native'])
            self.assertEqual(run.call_args.kwargs['env'],environment)

    def test_missing_loader_dependency_blocks_without_running_native_operator(self):
        scope={'runtime_service':SimpleNamespace(process_environment=lambda paths,service:{})}
        exec(target.NATIVE_ENVIRONMENT,scope)
        for code,output in [(0,b'libcuda.so.1 => not found'),(1,b'loader error')]:
            with self.subTest(code=code),\
                 mock.patch.dict(sys.modules,{'entrypoint':SimpleNamespace(_configure_device_access=lambda:None)}),\
                 mock.patch('subprocess.run',return_value=SimpleNamespace(returncode=code,stdout=output,stderr=b'')) as run:
                with self.assertRaisesRegex(RuntimeError,'native loader preflight failed'):
                    scope['native_environment'](object(),Path('/package/bin/native'))
                self.assertEqual(run.call_count,1)
                self.assertEqual(run.call_args.args[0][0],'/usr/bin/ldd')


class NamespacedApplyTests(unittest.TestCase):
    def test_apply_uses_backend_namespace_root_once(self):
        request,before=fixture();after=deepcopy(before)
        after['lease']['state']='released';after['task']['lifecycle']='cancelled'
        after['reservation'].update(state='released',worker_launch_gate={'state':'closed'},release_proof_sha256='a'*64)
        result={'schema_version':target.NATIVE_SCHEMA,'request_id':request['request_id'],
                'status':'cancelled_no_spawn','run_id':'run-a','task_id':'task-a','release_proof_sha256':'a'*64}
        with tempfile.TemporaryDirectory() as folder:
            folder=Path(folder);request_file=folder/'request.json';raw=canonical(request)+b'\n';request_file.write_bytes(raw)
            cid='a'*64;image='sha256:'+'b'*64;attempt='c'*32
            document={'services':{'backend':{}}};config_sha=target.sha(canonical(document))
            previous={'attempt':attempt,'state':'succeeded','inputs':{'source_root':str(folder),'image_id':image},
                      'compose_project':'fullmag-worktree-test','config_sha256':config_sha,'backend_container':cid}
            previous_raw=canonical(previous)
            class Control:
                project='fullmag-worktree-test';volume='control';namespace='namespaces/'+'d'*32
                namespace_registry_sha256='e'*64
                def read_bytes(self,path,**kwargs):
                    return canonical(document) if path.endswith('/compose.json') else previous_raw
                def subpath(self,path):raise AssertionError('Backend is already mounted at the selected namespace')
                def write(self,*args):pass
                @contextmanager
                def operation(self,*args):yield {'receipt':{'attempt':'f'*32}}
            actual={'Id':cid,'Image':image,'State':{'Running':True,'StartedAt':'2026-10-28T01:00:00Z'},
                    'Config':{},'HostConfig':{},'Mounts':[{'Destination':'/host-ledger','Type':'volume','Name':'control'}]}
            def capture(*args,**kwargs):
                return SimpleNamespace(stdout=json.dumps([{'Config':{}}] if args[0]=='image' else [actual]).encode())
            args=SimpleNamespace(repo_root=folder,source_root=folder,request=request_file,request_sha256=target.sha(raw),
                                 backend_container_id=cid,image_id=image,process_receipt_sha256='4'*64,apply=True)
            with mock.patch('docker_development_inputs.select_checkout',return_value=folder),\
                 mock.patch('docker_dev_host.require_host'),\
                 mock.patch('docker_compose_identity.compose_project_identity',return_value={'source_root':str(folder)}),\
                 mock.patch('docker_compose_identity.validate_source_labels'),\
                 mock.patch('fullmag_storage.resolve_layout',return_value={}),\
                 mock.patch('docker_volume_dev._validate_retained_service'),\
                 mock.patch('docker_group_ledger.retained_profile',return_value={'volume_name':'control','ledger_subpath':'private/ledger'}),\
                 mock.patch('docker_group_ledger.validate_container') as ledger_attestation,\
                 mock.patch.object(target,'toolchain_configuration',return_value={'services':{'fem-gpu-toolchain':{'build':{'args':{'FULLMAG_CUDA_BASE_IMAGE':image}}}}}),\
                 mock.patch.object(target,'BuildControl',return_value=Control()),\
                 mock.patch.object(target,'docker_capture',side_effect=capture),\
                 mock.patch.object(target,'write_immutable'),\
                 mock.patch.object(target,'guest',side_effect=[before,before,result,after]) as call:
                outcome=target.cancel(args)
            self.assertEqual(outcome['state'],'cancelled-no-spawn')
            self.assertEqual(ledger_attestation.call_count, 3)
            inputs=call.call_args_list[2].args[2]
            self.assertEqual(inputs['request_path'],'/opt/fullmag/control/cancel-failed-no-spawn/attempts/'+'f'*32+'/request.json')
            self.assertNotIn('namespaces/',inputs['result_path'])


if __name__=='__main__':unittest.main()
