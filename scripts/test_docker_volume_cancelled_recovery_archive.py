"""A resumed cancellation reads the immutable parent archive without rewriting it."""
import hashlib
import ast
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import docker_volume_cancelled_recovery as recovery
from docker_build_control import BuildControlError
from test_docker_volume_stop_failed import ready_owner


class ResumedArchiveTests(unittest.TestCase):
    def test_absent_saved_budget_uses_only_authenticated_compose_limits(self):
        from docker_build_control import canonical
        compose={'services':{'backend':{'cpus':8,'mem_limit':64*1024**3}}}
        terminal={'state':'succeeded','attempt':'a'*32,'config_sha256':hashlib.sha256(canonical(compose)).hexdigest()}
        raw=json.dumps(terminal).encode()
        def read(control,path,**kw):return None if path=='backend/resource-budget.json' else raw
        with patch.object(recovery,'_read_raw',side_effect=read):
            budget=recovery._saved_resource_budget(None,compose,cancellation_terminal=terminal)
            self.assertEqual(budget['source'],'retained-compose')
            self.assertEqual(budget['budget'],{'cpus':8,'memory_bytes':64*1024**3,'memory_swap_bytes':128*1024**3})
            with self.assertRaises(BuildControlError):
                recovery._saved_resource_budget(None,compose,cancellation_terminal={**terminal,'config_sha256':'0'*64})

    def test_current_budget_renderer_refuses_changed_resolver_limits(self):
        import docker_volume_resources as resources
        pinned={'services':{'backend':{'cpus':8,'mem_limit':64*1024**3},
                            'frontend':{'cpus':4,'mem_limit':16*1024**3}}}
        settings={'FULLMAG_DEV_BACKEND_CPUS':8,'FULLMAG_DEV_BACKEND_MEMORY_GIB':64,
                  'FULLMAG_DEV_FRONTEND_CPUS':4,'FULLMAG_DEV_FRONTEND_MEMORY_GIB':16}
        control=SimpleNamespace(project='project',read=lambda *args,**kw:None)
        with patch.object(recovery,'docker_capture',return_value=SimpleNamespace(stdout=json.dumps(pinned).encode())), \
             patch('docker_dev_defaults.configured_group_budget',return_value=settings), \
             patch.object(resources,'_docker_capacity',return_value={'NCPU':32,'MemTotal':256*1024**3}):
            self.assertEqual(recovery._validate_rendered_budget(control,Path('/source'),pinned)['backend']['cpus'],8)
            settings['FULLMAG_DEV_BACKEND_MEMORY_GIB']=32
            with self.assertRaises(BuildControlError):
                recovery._validate_rendered_budget(control,Path('/source'),pinned)

    def test_private_ledger_snapshot_preserves_attested_subpath(self):
        import copy
        import docker_group_ledger as ledger
        import docker_volume_container_recovery as native_recovery
        from bootstrap_docker_toolchain import control_volume_name
        from test_docker_group_ledger import DAEMON,PROJECT,inspect_document
        volume=control_volume_name(PROJECT);subpath='namespaces/'+'a'*32+'/private/ledger'
        profile=ledger.profile(DAEMON,PROJECT,volume,'sha256:'+'1'*64,ledger_subpath=subpath)
        backend=inspect_document(profile)
        backend['HostConfig']['Mounts']=[{'Type':'volume','Source':volume,'Target':'/host-ledger','VolumeOptions':{'Subpath':subpath}}]
        compose={'name':PROJECT,'services':{'backend':profile['backend']},'volumes':{'group-ledger':profile['compose_volume']}}
        mount,_=native_recovery._ledger_snapshot_mount(SimpleNamespace(project=PROJECT),backend,compose)
        self.assertIn('volume-subpath='+subpath,mount)
        wrong=copy.deepcopy(backend)
        wrong['HostConfig']['Mounts'][0]['VolumeOptions']['Subpath']='private/other'
        with self.assertRaises(BuildControlError):
            native_recovery._ledger_snapshot_mount(SimpleNamespace(project=PROJECT),wrong,compose)

    def test_original_failed_cancellation_owner_is_terminal_and_exact(self):
        ready=ready_owner()
        failed={**ready,'state':'failed','heartbeat_at':'later',
                'children':[{**child,'status':'exited_failure' if child['role']=='compute' else 'exited_success'} for child in ready['children']]}
        process={'schema':'fullmag.docker-process-tree.v1','state':'shutdown_unknown',
                 'service_owner':ready,'api_diagnostic_only':True,'api_exit_code':-15,
                 'error':'runtime service owner observation failed during supervision: runtime service owner is not ready'}
        request={'expected_owner':failed}
        self.assertEqual(recovery._validate_failed_cancellation_owner(failed,process,request),failed)
        for altered in ({**failed,'state':'unknown'}, {**failed,'build_snapshot':'0'*64},
                        {**failed,'children':ready['children']}):
            with self.subTest(owner=altered),self.assertRaises(BuildControlError):
                recovery._validate_failed_cancellation_owner(altered,process,request)
        for field,value in [('api_diagnostic_only',False),('api_exit_code',None),('error','other'),('runtime_pid',123)]:
            with self.subTest(field=field),self.assertRaises(BuildControlError):
                recovery._validate_failed_cancellation_owner(failed,{**process,field:value},request)

    def test_resumed_parent_archive_requires_exact_link(self):
        parent={'schema':'fullmag.docker-build-operation.v1','state':'failed-confirmed',
                'phase':'development','attempt':'a'*32,'compose_project':'project',
                'control_volume':'volume','control_namespace':'ns',
                'inputs':{'source_root':'source','unclaimed_cancellation':{'request_id':'request'}},
                'unclaimed_cancellation_preflight':{'prior_attempt':'original'}}
        raw=json.dumps(parent).encode();before=b'{"prior_attempt":"original"}\n'
        terminal={**parent,'attempt':'b'*32,'state':'succeeded',
                  'unclaimed_cancellation_resume':{'failed_attempt':'a'*32,
                    'failed_terminal_sha256':hashlib.sha256(raw).hexdigest(),
                    'preflight_sha256':hashlib.sha256(before).hexdigest()}}
        control=SimpleNamespace(project='project',volume='volume',namespace='ns')
        def read(_control,path,**kw):
            if path.endswith('/terminal.json'):return raw
            return before
        with patch.object(recovery,'_read_raw',side_effect=read):
            self.assertEqual(recovery._cancellation_archive_attempt(control,'b'*32,terminal),'a'*32)
            for field,value in [('failed_terminal_sha256','0'*64),('preflight_sha256','0'*64),('failed_attempt','b'*32)]:
                invalid={**terminal,'unclaimed_cancellation_resume':{**terminal['unclaimed_cancellation_resume'],field:value}}
                with self.subTest(field=field),self.assertRaises(BuildControlError):
                    recovery._cancellation_archive_attempt(control,'b'*32,invalid)

    def test_non_resumed_keeps_own_archive(self):
        self.assertEqual(recovery._cancellation_archive_attempt(None,'a'*32,{}),'a'*32)

    def test_recovery_pins_layout_before_lifecycle_mutations(self):
        tree=ast.parse(Path(recovery.__file__).read_text())
        function=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='recover_cancelled')
        calls=[n for n in ast.walk(function) if isinstance(n,ast.Call)]
        pins=[n.lineno for n in calls if isinstance(n.func,ast.Attribute) and n.func.attr=='_pin_private_group_storage']
        starts=[n.lineno for n in calls if isinstance(n.func,ast.Attribute) and n.func.attr=='start']
        self.assertEqual(len(pins),1)
        self.assertLess(pins[0],min(starts))

    def test_failed_owner_start_uses_existing_config_rotation_without_native_recovery(self):
        import docker_volume_dev as volume_dev
        ready=ready_owner()
        failed={**ready,'state':'failed','children':[{**c,'status':'exited_failure'} for c in ready['children']]}
        process={'schema':'fullmag.docker-process-tree.v1','state':'shutdown_unknown',
                 'service_owner':ready,'api_diagnostic_only':True,'api_exit_code':-15,
                 'error':'runtime service owner observation failed during supervision: runtime service owner is not ready'}
        request={'request_id':'request','expected_owner':failed}
        request_raw=json.dumps(request).encode()
        native={'owner':failed,'process':process,'config_sha256':'c'*64,
                'owner_sha256':'o'*64,'process_sha256':'p'*64,'launch_sha256':'l'*64,
                'config_raw':b'config','owner_raw':b'owner','process_raw':b'process','launch_raw':b'launch'}
        values={'runtime-control/runtime-service/docker-all.json':b'config',
                'runtime-control/runtime-services/OWNER.json':b'owner',
                'runtime-control/runtime-service/process-tree.json':b'process',
                'runtime-control/runtime-services/LAUNCH.json':b'launch',
                'backend/runtime-service/unclaimed-cancellation/requests/request.json':request_raw}
        operation={'root':'operation','receipt':{'inputs':{'previous_config_sha256':'c'*64},'private_group_storage':'group-volume-v1'}}
        result={'request_sha256':hashlib.sha256(request_raw).hexdigest(),'native_result':{},
                'maintenance_receipt_sha256':'m'*64,'admission_sha256':'a'*64}
        control=SimpleNamespace(write=lambda *args:None)
        kwargs=dict(native=native,state=Path('/state'),
                    cancellation_terminal={'private_group_storage':'group-volume-v1'},request=request,
                    result=result,run_pins=[],removed_record={'state':'exact-maintenance-pair-removed'},
                    operator_probe={},prepared={'prepared':True},image='image',immutable_pins={})
        def start(args,**options):
            self.assertIsNone(args.script)
            self.assertFalse(args.fresh_state)
            self.assertEqual(options['previous_config_sha256'],'c'*64)
            self.assertFalse(any(k in options for k in ('maintenance','recovery_metadata','recovery_environment')))
            options['operation']['receipt']['state']='succeeded'
        with patch.object(recovery,'_read_raw',side_effect=lambda control,path,**kw:values[path]), \
             patch.object(recovery,'_retained_run_pins',return_value=[]), \
             patch.object(recovery,'_assert_consumers'), \
             patch('docker_volume_unclaimed_cancellation._operation_helper_id',return_value='helper'), \
             patch.object(volume_dev,'_session_host',return_value=SimpleNamespace(OWNER_NAME='owner')), \
             patch.object(volume_dev,'_certificate_path',return_value=Path('/state/cert')), \
             patch.object(volume_dev,'start',side_effect=start) as launched:
            recovery._start_cancelled_failed_owner(SimpleNamespace(script='forbidden',fresh_state=True),control,operation,**kwargs)
            launched.assert_called_once()
            launched.reset_mock()
            values['runtime-control/runtime-services/OWNER.json']=b'changed'
            with self.assertRaises(BuildControlError):
                recovery._start_cancelled_failed_owner(SimpleNamespace(),control,operation,**kwargs)
            launched.assert_not_called()

    def test_existing_configuration_rotation_retains_results_and_rejects_stale_pin(self):
        import tempfile
        from dataclasses import replace
        from test_docker_group_ledger import load_service
        service=load_service()
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            run=root/'runs'/'retained';run.mkdir(parents=True)
            (run/'result.bin').write_bytes(b'preserved scientific result')
            current={'host_execution':{'runtime_generation_sha256':'1'*64}}
            expected={'host_execution':{'runtime_generation_sha256':'2'*64}}
            paths=replace(service.RuntimePaths(),config=root/'docker-all.json')
            service._atomic_json(paths.config,current,'test configuration')
            original=paths.config.read_bytes();pin=hashlib.sha256(original).hexdigest()
            with self.assertRaises(service.RuntimeServiceError):
                service._rotate_configuration_generation(paths,current,expected,'0'*64)
            service._rotate_configuration_generation(paths,current,expected,pin)
            self.assertEqual(json.loads(paths.config.read_text()),expected)
            self.assertEqual((root/f'docker-all.previous-{pin}.json').read_bytes(),original)
            self.assertEqual((run/'result.bin').read_bytes(),b'preserved scientific result')
            self.assertEqual([p.name for p in run.iterdir()],['result.bin'])


if __name__=='__main__':unittest.main()
