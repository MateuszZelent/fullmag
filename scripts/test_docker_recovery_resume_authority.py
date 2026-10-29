"""Explicit resume authority and fixed-argv regressions; no Docker or compilation."""
import copy
import hashlib
import os
from pathlib import Path
import subprocess
import types
import unittest
from unittest.mock import patch
import docker_dev_recovery_build as repair
from docker_build_control import canonical

class ResumeAuthorityTests(unittest.TestCase):
    def setUp(self):
        self.control=types.SimpleNamespace(project='own',volume='control')
        self.args=types.SimpleNamespace(resume_attempt='a'*32,resume_terminal_sha256=None,
            backend_container_id='b'*64,image_id='sha256:'+'c'*64)
        self.source=Path('/selected');self.parent_root='development/attempts/'+'d'*32
        self.resume_root='resume/attempts/'+'a'*32
        self.document={'name':'own','services':{'backend':{'image':self.args.image_id}}}
        cfg=hashlib.sha256(canonical(self.document)).hexdigest()
        self.profile={'volume_names':{'build':'build','package':'package','control':'control'}}
        common={'schema':'fullmag.docker-build-operation.v1','compose_project':'own','control_volume':'control',
            'config_sha256':cfg,'backend_container':'b'*64,'frontend_container':'e'*64,
            'backend_volumes':self.profile['volume_names'],'frontend_volume':'front','state_root':'/state'}
        parent={**common,'phase':'development','state':'failed-confirmed','attempt':'d'*32,
            'inputs':{'source_root':str(self.source),'image_id':self.args.image_id}}
        package={'state':'succeeded'};package_sha=hashlib.sha256(canonical(package)+b'\n').hexdigest()
        provenance={'state':'succeeded','build_receipt_sha256':package_sha,
            'commit':'1'*40,'source_digest':'2'*64,'source_snapshot_sha256':'3'*64}
        resume={**common,'phase':'resume','state':'succeeded','attempt':'a'*32,
            'inputs':{'attempt':'d'*32,'config_sha256':cfg},'backend_started_at':'2026-10-23T21:46:50Z',
            'backend_build_receipt_sha256':package_sha,'source_commit':'1'*40,'source_digest':'2'*64,
            'source_snapshot_sha256':'3'*64}
        self.docs={self.parent_root+'/terminal.json':parent,self.parent_root+'/compose.json':self.document,
            self.parent_root+'/backend-cache.json':self.profile,self.resume_root+'/terminal.json':resume,
            self.resume_root+'/backend-build-receipt.json':package,self.resume_root+'/provenance.json':provenance}
        self.stale={**parent,'state':'succeeded','attempt':'f'*32,'backend_container':'0'*64}
        self.control.read=lambda path:self.stale if path=='development/verified.json' else self.docs[path]
        self.repin()
    def repin(self):
        self.args.resume_terminal_sha256=hashlib.sha256(canonical(self.docs[self.resume_root+'/terminal.json'])+b'\n').hexdigest()
    def load(self):
        with patch('docker_volume_reconcile.read_raw',side_effect=lambda _c,path:canonical(self.docs[path])+b'\n'):
            return repair.recovery_authority(self.control,self.args,self.source)
    def test_explicit_success_uses_parent_compose_and_ignores_stale_verified(self):
        parent,resume,document,profile,pins=self.load()
        self.assertEqual(parent['state'],'failed-confirmed');self.assertEqual(resume['state'],'succeeded')
        self.assertEqual(document,self.document);self.assertEqual(profile,self.profile)
        self.assertEqual(pins['parent_attempt'],'d'*32);self.assertEqual(len(pins['documents']),6)
        self.assertEqual(self.stale['backend_container'],'0'*64)
    def test_legacy_selection_is_unchanged_without_pins(self):
        self.args.resume_attempt=self.args.resume_terminal_sha256=None
        self.docs['development/attempts/'+'f'*32+'/compose.json']=self.document
        self.docs['development/attempts/'+'f'*32+'/backend-cache.json']=self.profile
        parent,authority,_,_,pins=self.load()
        self.assertIs(parent,self.stale);self.assertIs(authority,self.stale);self.assertEqual(pins,{})
    def test_partial_malformed_or_wrong_digest_never_falls_back(self):
        for key,value in [('resume_attempt',None),('resume_terminal_sha256',None),
                          ('resume_attempt','../escape'),('resume_terminal_sha256','0'*64)]:
            old=getattr(self.args,key);setattr(self.args,key,value)
            with self.subTest(key=key,value=value),self.assertRaises(ValueError):self.load()
            setattr(self.args,key,old)
    def test_wrong_resume_identity_or_state_is_rejected_even_with_matching_sha(self):
        path=self.resume_root+'/terminal.json'
        for key,value in [('schema','other'),('phase','development'),('state','failed-confirmed'),
                ('attempt','0'*32),('compose_project','other'),('control_volume','other'),
                ('backend_container','0'*64),('frontend_container','0'*64),('backend_started_at',''),
                ('state_root','/other'),('backend_volumes',{}),('frontend_volume','other')]:
            before=copy.deepcopy(self.docs[path]);self.docs[path][key]=value;self.repin()
            with self.subTest(key=key),self.assertRaises(ValueError):self.load()
            self.docs[path]=before;self.repin()
    def test_parent_config_and_publication_drift_are_rejected(self):
        cases=[(self.parent_root+'/terminal.json','phase','resume'),
            (self.parent_root+'/terminal.json','state','starting'),
            (self.parent_root+'/terminal.json','compose_project','other'),
            (self.parent_root+'/terminal.json','config_sha256','0'*64),
            (self.parent_root+'/compose.json','name','other'),
            (self.parent_root+'/backend-cache.json','volume_names',{}),
            (self.resume_root+'/backend-build-receipt.json','state','failed'),
            (self.resume_root+'/provenance.json','state','failed'),
            (self.resume_root+'/provenance.json','build_receipt_sha256','0'*64),
            (self.resume_root+'/provenance.json','commit','0'*40)]
        for path,key,value in cases:
            before=copy.deepcopy(self.docs[path]);self.docs[path][key]=value
            with self.subTest(path=path,key=key),self.assertRaises(ValueError):self.load()
            self.docs[path]=before
    def test_missing_sidecar_or_changed_parent_source_refuses(self):
        path=self.resume_root+'/provenance.json';saved=self.docs.pop(path)
        with self.assertRaises(KeyError):self.load()
        self.docs[path]=saved
        self.docs[self.parent_root+'/terminal.json']['inputs']['source_root']='/other'
        with self.assertRaises(ValueError):self.load()
    def test_document_recheck_detects_changed_parent_receipt(self):
        old=self.load()[4];self.docs[self.parent_root+'/terminal.json']['finished_at']=123
        self.assertNotEqual(self.load()[4],old)

class ResumeShellTests(unittest.TestCase):
    def recipe(self,mode='',pair=True):
        base=('python "/selected/scripts/docker_dev_recovery_build.py" --source-root \'/selected\''
            +" --backend-container-id '"+'b'*64+"' --image-id 'sha256:"+'c'*64+"'"
            +" --process-receipt-sha256 '"+'d'*64+"' --owner-sha256 '"+'e'*64+"'")
        if mode=='promote':
            base+=" --promote --candidate-basename '.backend-package-candidate-own' --candidate-receipt-sha256 '"+'1'*64+"' --current-receipt-sha256 '"+'2'*64+"' --provenance-sha256 '"+'3'*64+"'"
        elif mode=='superseded':
            base+=" --superseded-candidate-basename '.backend-package-candidate-old' --superseded-marker-sha256 '"+'1'*64+"' --superseded-receipt-sha256 '"+'2'*64+"' --superseded-make-attempt-sha256 '"+'3'*64+"'"
        return base+(" --resume-attempt '"+'a'*32+"' --resume-terminal-sha256 '"+'f'*64+"'" if pair else '')
    def dispatch(self,recipe):
        wrapper=globals().get('WRAPPER') or (Path(__file__).parent/'just_storage_shell.sh').read_text()
        body=wrapper.split('  *"scripts/docker_dev_recovery_build.py"*)\n',1)[1].split('\n    ;;',1)[0]
        program='set -euo pipefail\nrecipe="$RECIPE_LITERAL"\npython_cmd="/python"\nscript_dir="/scripts"\nexec() { printf \'%s\\0\' "$@"; }\n'+body
        return subprocess.run(['/bin/bash','--noprofile','--norc','-c',program],
            env={**os.environ,'RECIPE_LITERAL':recipe},capture_output=True,timeout=10)
    def test_legacy_and_explicit_pair_preserve_every_existing_mode(self):
        for mode in ('','promote','superseded'):
            for pair in (False,True):
                with self.subTest(mode=mode,pair=pair):
                    result=self.dispatch(self.recipe(mode,pair));self.assertEqual(result.returncode,0,result.stderr)
                    argv=result.stdout.split(b'\0')[:-1];self.assertEqual(b'--resume-attempt' in argv,pair)
                    if pair:self.assertEqual(argv[-4:],[b'--resume-attempt',b'a'*32,b'--resume-terminal-sha256',b'f'*64])
                    if mode=='promote':self.assertIn(b'--promote',argv)
                    if mode=='superseded':self.assertIn(b'--superseded-candidate-basename',argv)
    def test_partial_pins_extra_flags_and_shell_commands_refuse(self):
        valid=self.recipe()
        for value in [valid.replace(" --resume-terminal-sha256 '"+'f'*64+"'",''),
                      valid+" --resume-attempt '"+'a'*32+"'",valid+'; echo bad',valid+' && echo bad',
                      valid+'\necho bad',valid.replace('a'*32,'../bad'),valid+' --unknown']:
            with self.subTest(value=value):
                result=self.dispatch(value);self.assertEqual(result.returncode,2);self.assertFalse(result.stdout)

if __name__=='__main__':unittest.main()
