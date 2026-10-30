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
            log.unlink()
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
                def read_bytes(self,path):
                    return canonical(document) if path.endswith('/compose.json') else previous_raw
                def subpath(self,path):raise AssertionError('Backend is already mounted at the selected namespace')
                def write(self,*args):pass
                @contextmanager
                def operation(self,*args):yield {'receipt':{'attempt':'f'*32}}
            actual={'Id':cid,'Image':image,'State':{'Running':True,'StartedAt':'2026-10-28T01:00:00Z'},
                    'Config':{},'HostConfig':{},'Mounts':[{'Destination':'/host-ledger','Type':'volume','Name':'fullmag-dev-group-ledger-v1-test'}]}
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
                 mock.patch.object(target,'toolchain_configuration',return_value={'services':{'fem-gpu-toolchain':{'build':{'args':{'FULLMAG_CUDA_BASE_IMAGE':image}}}}}),\
                 mock.patch.object(target,'BuildControl',return_value=Control()),\
                 mock.patch.object(target,'docker_capture',side_effect=capture),\
                 mock.patch.object(target,'write_immutable'),\
                 mock.patch.object(target,'guest',side_effect=[before,before,result,after]) as call:
                outcome=target.cancel(args)
            self.assertEqual(outcome['state'],'cancelled-no-spawn')
            inputs=call.call_args_list[2].args[2]
            self.assertEqual(inputs['request_path'],'/opt/fullmag/control/cancel-failed-no-spawn/attempts/'+'f'*32+'/request.json')
            self.assertNotIn('namespaces/',inputs['result_path'])


if __name__=='__main__':unittest.main()
