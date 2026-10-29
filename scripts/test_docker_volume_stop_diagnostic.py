"""Diagnostic stop preserves Unknown and authenticates the original Ready identity."""
import ast
import base64
import copy
import json
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

import docker_volume_stop_diagnostic as stop
from docker_build_control import BuildControlError
from test_docker_volume_stop_failed import ready_owner


class DiagnosticUnknownStopTests(unittest.TestCase):
    def fixture(self):
        ready=ready_owner()
        owner={**ready,'state':'unknown','heartbeat_at':'2026-10-25T14:00:00Z',
               'children':[{**c,'status':'exited_failure' if c['role']=='preparation' else 'running'} for c in ready['children']]}
        fence_path=stop.FENCE_PARENT+'/api-failure-'+'1'*32+'.json'
        process={'schema':'fullmag.docker-process-tree.v1','state':'failed_outcome_retained',
                 'api_pid':500,'api_diagnostic_only':True,'api_failure_fence':fence_path,'runtime_pid':None,
                 'service_owner':ready,'error':'runtime service owner observation failed during supervision: runtime service owner is not ready'}
        return owner,process

    def evidence(self,owner,process):
        config={'schema_version':'runtime_service_config.v2','target_id':'docker-all',
                'store_root':'/state/runs/docker-all/session-store'}
        fence={'schema':'fullmag.api-runtime-failure-fence.v1','stage':'runtime_supervision',
               'api_pid':process['api_pid'],'api_instance_id':'instance'}
        values={'runtime_config':config,'owner':owner,'process_receipt':process,'failure_fence':fence}
        raw={k:json.dumps(v,sort_keys=True).encode() for k,v in values.items()}
        paths={'runtime-control/runtime-service/docker-all.json':raw['runtime_config'],
               'runtime-control/runtime-services/OWNER.json':raw['owner'],
               'runtime-control/runtime-service/process-tree.json':raw['process_receipt'],
               stop._runtime_relative(process['api_failure_fence']):raw['failure_fence']}
        probe={k:base64.b64encode(v).decode() for k,v in raw.items()}
        probe.update(api_failure_fence=process['api_failure_fence'],api_instance_id='instance')
        with patch.object(stop,'_read_raw',side_effect=lambda control,path,**kw:paths[path]), \
             patch('docker_volume_unclaimed_cancellation._control_raw',return_value=None):
            return stop._probe_evidence(object(),'development/attempts/'+'a'*32,probe)

    def test_host_check_keeps_unknown_and_original_ready_bytes(self):
        owner,process=self.fixture();before=copy.deepcopy((owner,process))
        result=self.evidence(owner,process)
        self.assertEqual(result['failed_owner'],owner)
        self.assertEqual(result['failed_owner']['state'],'unknown')
        self.assertEqual(result['ready_owner'],process['service_owner'])
        self.assertEqual((owner,process),before)

    def test_drift_or_unfenced_api_is_refused(self):
        for field,value in [('owner_token','other'),('pid',999),('state','ready')]:
            owner,process=self.fixture();owner[field]=value
            with self.subTest(field=field),self.assertRaises(BuildControlError):self.evidence(owner,process)
        for field,value in [('api_diagnostic_only',False),('runtime_pid',123),('api_exit_code',0),('error','different')]:
            owner,process=self.fixture();process[field]=value
            with self.subTest(field=field),self.assertRaises(BuildControlError):self.evidence(owner,process)

    def test_preview_helper_must_hold_its_exact_phase_lease(self):
        from types import SimpleNamespace
        attempt='a'*32;helper_id='b'*64
        ids={'backend':'c'*64,'frontend':'d'*64}
        control=SimpleNamespace(image='image',project='project',volume='volume',identity={})
        for preview in [True,False]:
            phase='stop-diagnostic-preview' if preview else 'stop-diagnostic'
            operation={'receipt':{'attempt':attempt,'helper_container':'fullmag-control-'+attempt,
                                 'phase':phase,'inputs':{'preview_only':preview}}}
            helper={'Id':helper_id,'Config':{'Image':'image','Labels':{
                'com.docker.compose.project':'project','com.docker.compose.service':'build-control',
                'org.fullmag.compose.project':'project'},'Cmd':['/control/'+phase+'/attempts/'+attempt+' until test -f /control/active']},
                'State':{'Running':True},'HostConfig':{'NetworkMode':'none'},
                'Mounts':[{'Destination':'/control','Type':'volume','Name':'volume'}]}
            expected=set(ids.values())|{helper_id}
            with patch.object(stop,'docker_capture',return_value=SimpleNamespace(stdout=json.dumps([helper]).encode())), \
                 patch('docker_compose_identity.validate_source_labels'), \
                 patch('docker_volume_unclaimed_cancellation._project_container_ids',return_value=expected), \
                 patch('docker_volume_unclaimed_cancellation._volume_consumer_ids',return_value=expected):
                self.assertEqual(stop._assert_group_consumers(control,operation,ids),helper_id)
                operation['receipt']['inputs']['preview_only']=not preview
                with self.assertRaises(BuildControlError):stop._assert_group_consumers(control,operation,ids)

    def test_serialized_guest_uses_the_same_identity_check(self):
        tree=ast.parse(stop._probe_script())
        branch=next(n for n in tree.body if isinstance(n,ast.If) and "owner.get('state') == 'unknown'" in ast.unparse(n.test))
        functions=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in {'require','validate_diagnostic_build'}]
        module=ast.fix_missing_locations(ast.Module(body=[*functions,branch],type_ignores=[]))
        owner,process=self.fixture();scope={'owner':owner,'process':process}
        exec(compile(module,'guest-owner-check','exec'),scope)
        self.assertEqual(owner['state'],'unknown')
        scope['owner']={**owner,'owner_token':'other'}
        with self.assertRaises(ValueError):exec(compile(module,'guest-owner-check','exec'),scope)


class DiagnosticStopShellTests(unittest.TestCase):
    def dispatch(self,extra='',resume=True,preview=True):
        source=(Path(__file__).parent/'just_storage_shell.sh').read_text()
        body=source.split('  *"scripts/docker_dev.py"*" stop-diagnostic-volume "*)\n',1)[1].split('\n    ;;',1)[0]
        recipe=('python "/ignored/scripts/docker_dev.py" --repo-root "/ignored" stop-diagnostic-volume '
                "--attempt '"+'a'*32+"' --config-sha256 '"+'b'*64+"' --source-root '/selected/worktree' --port '3203'")
        if resume:recipe+=" --resume-attempt '"+'c'*32+"'"
        if preview:recipe+=' --preview'
        recipe+=extra
        program=('set -euo pipefail\nrecipe="$RECIPE_LITERAL"\n'
                 'python_cmd="/recorded/python"\nscript_dir="/registered/scripts"\nrepo_root="/registered"\n'
                 'exec() { printf \'%s\\0\' "$@"; }\n'+body)
        return subprocess.run(['/bin/bash','--noprofile','--norc','-c',program],
            env={**os.environ,'RECIPE_LITERAL':recipe},capture_output=True,timeout=15)

    def test_exact_preview_and_mutation_argv(self):
        for preview in [True,False]:
            result=self.dispatch(preview=preview)
            self.assertEqual(result.returncode,0,result.stderr)
            argv=result.stdout.split(b'\0')[:-1]
            self.assertIn(b'stop-diagnostic-volume',argv)
            self.assertEqual(b'--preview' in argv,preview)
            self.assertEqual(argv[argv.index(b'--resume-attempt')+1],b'c'*32)
        result=self.dispatch(resume=False);self.assertEqual(result.returncode,0,result.stderr)
        self.assertNotIn(b'--resume-attempt',result.stdout)

    def test_composite_or_unknown_arguments_are_refused(self):
        for extra in ['; printf injected',' && printf injected','\nprintf injected',' --force',' --preview']:
            result=self.dispatch(extra)
            self.assertEqual(result.returncode,2,result.stderr)
            self.assertFalse(result.stdout)


if __name__=='__main__':unittest.main()
