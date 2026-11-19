"""Interpreted candidate-view topology and fixed recipe dispatch regressions."""
from pathlib import Path
import os
import subprocess
import unittest

import docker_candidate_history as history


class CandidateHistoryMountTests(unittest.TestCase):
    def fixture(self):
        targets=['/state','/user-data','/host-ledger','/run/fullmag/linux-native-host.json',
                 '/opt/fullmag/runtime-control','/state/runs/docker-all/session-store/runtime-services']
        rows=[{'Type':'volume','Name':'state-'+str(i),'Destination':name} for i,name in enumerate(targets)]
        rows.append({'Type':'volume','Name':'own-package','Destination':'/opt/fullmag/package'})
        return {'Mounts':rows,'HostConfig':{'Mounts':[{'Target':m['Destination'],'Type':'volume','VolumeOptions':{'NoCopy':True}} for m in rows]}}

    def mounts(self,actual=None,root=None,candidate='.backend-package-candidate-own'):
        return history.diagnostic_mounts(actual or self.fixture(),'own-control',
            root or 'candidate-history/attempts/'+'a'*32,candidate)

    def test_candidate_is_readonly_and_provenance_is_private_without_build_mount(self):
        mounts=self.mounts()
        self.assertIn('type=volume,src=own-package,dst=/opt/fullmag/package,readonly,volume-nocopy,volume-subpath=.development/candidates/.backend-package-candidate-own',mounts)
        backend=next(m for m in mounts if 'dst=/opt/fullmag/control/backend,' in m)
        self.assertIn('volume-subpath=candidate-history/attempts/'+'a'*32+'/backend',backend)
        self.assertIn('type=volume,src=own-control,dst=/opt/fullmag/control,readonly',mounts)
        self.assertFalse(any('dst=/build' in m for m in mounts))
        self.assertTrue(all(',readonly' in m for m in mounts if 'dst=/opt/fullmag/runtime-control' in m))

    def test_existing_runtime_alias_subpaths_are_preserved(self):
        actual=self.fixture()
        for mount in actual['HostConfig']['Mounts']:
            if mount['Target']=='/opt/fullmag/runtime-control':mount['VolumeOptions']['Subpath']='runtime-control'
            if mount['Target']=='/state/runs/docker-all/session-store/runtime-services':mount['VolumeOptions']['Subpath']='runtime-control/runtime-services'
        mounts=self.mounts(actual)
        self.assertTrue(any('dst=/opt/fullmag/runtime-control,readonly,volume-nocopy,volume-subpath=runtime-control' in m for m in mounts))
        self.assertTrue(any('dst=/state/runs/docker-all/session-store/runtime-services,readonly,volume-nocopy,volume-subpath=runtime-control/runtime-services' in m for m in mounts))
        actual['HostConfig']['Mounts'][0]['VolumeOptions']['Subpath']='../outside'
        with self.assertRaises(ValueError):self.mounts(actual)

    def test_missing_duplicated_unsafe_mounts_and_traversal_fail_closed(self):
        actual=self.fixture();actual['Mounts'].pop(0)
        with self.assertRaises(ValueError):self.mounts(actual)
        actual=self.fixture();actual['Mounts'].append(actual['Mounts'][0])
        with self.assertRaises(ValueError):self.mounts(actual)
        actual=self.fixture();actual['Mounts'][0]['Name']='source,other=value'
        with self.assertRaises(ValueError):self.mounts(actual)
        for candidate in ['../other','own','.backend-package-candidate-own/other']:
            with self.subTest(candidate=candidate),self.assertRaises(ValueError):self.mounts(candidate=candidate)
        with self.assertRaises(ValueError):self.mounts(root='candidate-history/../backend')


class CandidateHistoryStoreTests(unittest.TestCase):
    def validate(self, changes, writer):
        scope={}
        exec(history.STORE_VALIDATION,scope)
        return scope['validate_store_changes'](changes,writer)

    def test_only_released_root_writer_metadata_can_change(self):
        released={'schema':'fullmag.writer.v1','released':True}
        row={'path':'WRITER.owner.json','before':'a'*64,'after':'b'*64}
        self.assertEqual(self.validate([row],released),[row])
        self.assertEqual(self.validate([],{}),[])
        for path in ['runs/own/WRITER.owner.json','runs/own/run_catalog.json','objects/sha256/own','WRITER.lock']:
            with self.subTest(path=path),self.assertRaises(ValueError):
                self.validate([{**row,'path':path}],released)
        for writer in [{}, {**released,'released':False}, {**released,'schema':'other'}]:
            with self.assertRaises(ValueError):self.validate([row],writer)


class CandidateHistoryShellTests(unittest.TestCase):
    def dispatch(self,extra='',digest='d'*64):
        source=(Path(__file__).parent/'just_storage_shell.sh').read_text()
        body=source.split('  *"scripts/docker_candidate_history.py"*)\n',1)[1].split('\n    ;;',1)[0]
        recipe=('python "/ignored/scripts/docker_candidate_history.py" '
            "--source-root '/selected/worktree' --backend-container-id '"+'a'*64+
            "' --image-id 'sha256:"+'b'*64+"' --build-attempt '"+'c'*32+
            "' --candidate-receipt-sha256 '"+digest+"'"+extra)
        program=('set -euo pipefail\nrecipe="$RECIPE_LITERAL"\n'
            'python_cmd="/recorded/python"\nscript_dir="/registered/scripts"\n'
            'exec() { printf \'%s\\0\' "$@"; }\n'+body)
        return subprocess.run(['/bin/bash','--noprofile','--norc','-c',program],
            env={**os.environ,'RECIPE_LITERAL':recipe},capture_output=True,timeout=15)

    def test_exact_fixed_argv(self):
        result=self.dispatch();self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(result.stdout.split(b'\0')[-5:-1],
            [b'--build-attempt',b'c'*32,b'--candidate-receipt-sha256',b'd'*64])
        self.assertNotIn(b'--promote',result.stdout)

    def test_invalid_and_composite_commands_are_rejected(self):
        for extra,digest in [('', 'short'),(' --promote','d'*64),('; printf injected','d'*64),
                             (' && printf injected','d'*64),('\nprintf injected','d'*64)]:
            result=self.dispatch(extra,digest)
            self.assertEqual(result.returncode,2,result.stderr);self.assertFalse(result.stdout)


if __name__=='__main__':unittest.main()
