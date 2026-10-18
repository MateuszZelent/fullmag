"""Interpreted coordinator source-freeze regressions; no real Docker builds."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from local_runner import coordinator_image as c


class CoordinatorImageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.repo = self.root/'repo'; self.repo.mkdir()
        self.scripts = self.repo/'scripts'
        self.inputs = {
            'fullmag_storage.py':b'# storage\n',
            'capture_source_snapshot_identity.py':b'# capture\n',
            'local_runner/container_main.py':b'# queue\n',
            'local_runner/helper.py':b'# helper\n',
            'local_runner/ui_dist/index.html':b'<html/>',
            'local_runner/Dockerfile.coordinator':Path(c.__file__).with_name('Dockerfile.coordinator').read_bytes(),
        }
        for name,data in self.inputs.items():
            p=self.scripts/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(data)
        self.git('init','-q');self.git('add','scripts')
        self.git('update-index','--chmod=+x','scripts/local_runner/helper.py')
        self.git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','Fixture')
        self.head=self.git('rev-parse','HEAD').decode().strip()
        self.storage=self.root/'storage';self.storage.mkdir()
        self.layout=dict(storage_root=str(self.storage),worktree_id='fixture',build_root=str(self.storage/'builds'/'fixture'))
        self.base=dict(Id='sha256:'+'a'*64,RootFS=dict(Type='layers',Layers=['sha256:'+'b'*64]),Architecture='amd64',Os='linux',Config={})

    def git(self,*args):
        return subprocess.check_output(['git','--no-optional-locks','-C',str(self.repo),*args],stderr=subprocess.STDOUT)

    def prepare(self,**options):
        with patch.object(c,'resolve_layout',return_value=self.layout),patch.object(c,'base_inspect',return_value=self.base),contextlib.redirect_stdout(io.StringIO()):
            return c.prepare_context(self.repo,'snapshot',**options)

    def rewrite(self,context,value):
        (context/'context.json').write_bytes(c.canonical(value))

    def test_snapshot_preserves_exact_bytes_and_git_modes(self):
        context=self.prepare()
        value=c.validate_context(context)
        self.assertEqual((context/'local_runner/helper.py').read_bytes(),self.inputs['local_runner/helper.py'])
        self.assertEqual(next(e['mode'] for e in value['files'] if e['path']=='local_runner/helper.py'),'100755')
        self.assertIn(b'COPY context.json /opt/runner/source-proof.json',(context/'Dockerfile').read_bytes())
        self.assertNotIn(b'COPY context.json',self.inputs['local_runner/Dockerfile.coordinator'])

    def test_dirty_snapshot_requires_explicit_admission(self):
        (self.scripts/'local_runner/helper.py').write_text('# changed')
        with self.assertRaisesRegex(ValueError,'allow-dirty'):c.capture(self.repo,'snapshot')
        _,proof=c.capture(self.repo,'snapshot',allow_dirty=True)
        self.assertTrue(proof['dirty_snapshot'])

    def test_untracked_copy_input_requires_explicit_admission(self):
        (self.scripts/'local_runner/new.py').write_bytes(b'# new')
        with self.assertRaisesRegex(ValueError,'explicit admission'):c.capture(self.repo,'snapshot',allow_dirty=True)
        data,_=c.capture(self.repo,'snapshot',allow_dirty=True,include_untracked=('scripts/local_runner/new.py',))
        self.assertIn('local_runner/new.py',[e[0] for e in data])
        with self.assertRaisesRegex(ValueError,'outside'):c.capture(self.repo,'snapshot',allow_dirty=True,include_untracked=('../outside',))

    def test_commit_uses_immutable_git_bytes(self):
        (self.scripts/'local_runner/helper.py').write_bytes(b'# ignored dirty')
        data,proof=c.capture(self.repo,'commit',self.head)
        expected=self.git('show',self.head+':scripts/local_runner/helper.py')
        self.assertEqual(next(e[1] for e in data if e[0]=='local_runner/helper.py'),expected)
        self.assertFalse(proof['dirty_snapshot'])
        with self.assertRaisesRegex(ValueError,'full immutable'):c.capture(self.repo,'commit',self.head[:8])
        with self.assertRaisesRegex(ValueError,'snapshot options'):c.capture(self.repo,'commit',self.head,True)

    def test_snapshot_byte_change_during_capture_refused(self):
        original=c.sha;changed=False
        def changing(path):
            nonlocal changed
            if not changed:
                changed=True;path.write_bytes(path.read_bytes()+b'# changed')
            return original(path)
        with patch.object(c,'sha',side_effect=changing),self.assertRaisesRegex(ValueError,'changed during capture'):
            c.capture(self.repo,'snapshot')

    def test_snapshot_membership_change_refused(self):
        original=c.snapshot_members;count=0
        def changing(scripts):
            nonlocal count
            count+=1
            if count==2:(scripts/'local_runner/late.py').write_bytes(b'# late')
            return original(scripts)
        with patch.object(c,'snapshot_members',side_effect=changing),self.assertRaisesRegex(ValueError,'membership'):
            c.capture(self.repo,'snapshot')

    def test_byte_bounds_before_capture(self):
        with patch.object(c,'MAX_BYTES',3),self.assertRaisesRegex(ValueError,'bound'):c.capture(self.repo,'snapshot')
        with patch.object(c,'MAX_BYTES',3),self.assertRaisesRegex(ValueError,'bound'):c.capture(self.repo,'commit',self.head)

    def test_symlink_refusal(self):
        path=self.scripts/'local_runner/helper.py';path.unlink()
        try:path.symlink_to(self.scripts/'fullmag_storage.py')
        except OSError:
            path.write_bytes(b'# fallback fixture')
            original=Path.is_symlink
            with patch.object(Path,'is_symlink',lambda current:current==path or original(current)),self.assertRaisesRegex(ValueError,'symlink'):
                c.capture(self.repo,'snapshot',allow_dirty=True)
            return
        with self.assertRaisesRegex(ValueError,'symlink'):c.capture(self.repo,'snapshot',allow_dirty=True)

    def test_context_tamper_and_unexpected_member_refused(self):
        context=self.prepare();(context/'local_runner/helper.py').write_bytes(b'tamper')
        with self.assertRaisesRegex(ValueError,'identity'):c.validate_context(context)
        context=self.prepare();(context/'unexpected').write_bytes(b'extra')
        with self.assertRaisesRegex(ValueError,'unexpected'):c.validate_context(context)

    def test_manifest_duplicate_escape_and_mode_refused(self):
        for mutation in ('duplicate','escape','mode','size'):
            with self.subTest(mutation=mutation):
                context=self.prepare();value=c.load(context/'context.json')
                if mutation=='duplicate':value['files'].append(value['files'][0])
                if mutation=='escape':value['files'][0]['path']='../outside'
                if mutation=='mode':value['files'][0]['mode']='120000'
                if mutation=='size':value['files'][0]['size']='bad'
                self.rewrite(context,value)
                with self.assertRaises(ValueError):c.validate_context(context)

    def test_base_requires_digest_and_exact_local_identity(self):
        inspected=dict(self.base,RepoDigests=[c.BASE_REFERENCE],Config={})
        with patch.object(c.subprocess,'check_output',return_value=json.dumps([inspected]).encode()):
            self.assertEqual(c.base_inspect(c.BASE_REFERENCE),self.base)
            with self.assertRaisesRegex(ValueError,'identity'):c.base_inspect(c.BASE_REFERENCE,'sha256:'+'c'*64)
        inspected['RepoDigests']=[]
        with patch.object(c.subprocess,'check_output',return_value=json.dumps([inspected]).encode()),self.assertRaisesRegex(ValueError,'identity'):
            c.base_inspect(c.BASE_REFERENCE)

    def test_unpinned_dockerfile_refused(self):
        with self.assertRaisesRegex(ValueError,'pinned'):c.frozen_dockerfile(b'FROM python:latest\n')

    def test_context_lock_refusal_writes_terminal_receipt_without_docker(self):
        context=self.prepare()
        with patch.object(c,'resolve_layout',return_value=self.layout),patch.object(c.subprocess,'run') as run,contextlib.redirect_stdout(io.StringIO()),self.assertRaisesRegex(ValueError,'context lock'):
            c.build_image(self.repo,context,'fullmag/build-runner:test','0'*64)
        run.assert_not_called()
        receipt=c.load(next((self.storage/'builds').rglob('terminal-receipt.json')))
        self.assertEqual(receipt['status'],'FAILED');self.assertFalse(receipt['operator_changed'])
        self.assertFalse(receipt['native_compilation_executed'])

    def test_build_foreign_entrypoint_refused_with_receipt(self):
        context=self.prepare();identity='sha256:'+'c'*64
        def fake_build(command,log):
            Path(command[command.index('--iidfile')+1]).write_text(identity)
            log.write_bytes(b'synthetic fixture\n');return 0
        inspected=dict(Id=identity,Config=dict(Entrypoint=['wrong']),RootFS=self.base['RootFS'])
        with patch.object(c,'resolve_layout',return_value=self.layout),patch.object(c,'base_inspect',return_value=self.base),patch.object(c.subprocess,'run'),patch.object(c,'bounded_build',side_effect=fake_build),patch.object(c.subprocess,'check_output',return_value=json.dumps([inspected]).encode()),contextlib.redirect_stdout(io.StringIO()),self.assertRaisesRegex(ValueError,'entrypoint'):
            c.build_image(self.repo,context,'fullmag/build-runner:test',c.sha(context/'context.json'))
        receipt=c.load(next((self.storage/'builds').rglob('terminal-receipt.json')))
        self.assertEqual(receipt['status'],'FAILED')
        self.assertIn('--network',receipt['command']);self.assertIn('none',receipt['command']);self.assertIn('--pull=false',receipt['command'])

    def test_success_receipt_is_only_source_image_not_deployment(self):
        context=self.prepare();value=c.validate_context(context);identity='sha256:'+'c'*64
        def fake_build(command,log):
            Path(command[command.index('--iidfile')+1]).write_text(identity)
            log.write_bytes(b'synthetic fixture\n');return 0
        inspected=dict(Id=identity,Config=dict(Entrypoint=c.ENTRYPOINT),RootFS=dict(Layers=[*self.base['RootFS']['Layers'],'sha256:'+'d'*64]))
        proof=dict(proof_sha256=c.sha(context/'context.json'),files={e['path']:e['sha256'] for e in value['files'] if e['path'] not in ('Dockerfile','.dockerignore')})
        with patch.object(c,'resolve_layout',return_value=self.layout),patch.object(c,'base_inspect',return_value=self.base),patch.object(c.subprocess,'run'),patch.object(c,'bounded_build',side_effect=fake_build),patch.object(c.subprocess,'check_output',side_effect=[json.dumps([inspected]).encode(),json.dumps(proof).encode()]),contextlib.redirect_stdout(io.StringIO()):
            c.build_image(self.repo,context,'fullmag/build-runner:test',c.sha(context/'context.json'))
        receipt=c.load(next((self.storage/'builds').rglob('terminal-receipt.json')))
        self.assertEqual(receipt['status'],'SUCCEEDED_IMAGE_ONLY')
        self.assertEqual(receipt['qualification'],'COORDINATOR_DEPLOYMENT_NOT_VERIFIED')
        self.assertEqual(receipt['source_readback_sha256'],c.sha(next((self.storage/'builds').rglob('source-readback.json'))))

    def test_base_drift_prevents_build(self):
        context=self.prepare();changed=dict(self.base,Architecture='wrong')
        with patch.object(c,'resolve_layout',return_value=self.layout),patch.object(c,'base_inspect',return_value=changed),patch.object(c.subprocess,'run') as run,contextlib.redirect_stdout(io.StringIO()),self.assertRaisesRegex(ValueError,'base drift'):
            c.build_image(self.repo,context,'fullmag/build-runner:test',c.sha(context/'context.json'))
        run.assert_not_called()

    def test_provision_is_only_pinned_download_and_verified_receipt(self):
        seen=[]
        def pull(command,log):
            seen.append(command);log.write_bytes(b'synthetic pinned pull\n');return 0
        with patch.object(c,'resolve_layout',return_value=self.layout),patch.object(c,'bounded_build',side_effect=pull),patch.object(c,'base_inspect',return_value=self.base),contextlib.redirect_stdout(io.StringIO()):
            c.provision_base(self.repo)
        self.assertEqual(seen,[['docker','--context','desktop-linux','image','pull',c.BASE_REFERENCE]])
        receipt=c.load(next((self.storage/'builds').rglob('terminal-receipt.json')))
        self.assertEqual(receipt['status'],'SUCCEEDED_PINNED_BASE_ONLY')
        self.assertEqual(receipt['verified_repo_digest'],c.BASE_REFERENCE)
        self.assertFalse(receipt['docker_image_build_executed']);self.assertFalse(receipt['operator_changed'])

    def test_provision_download_failure_has_terminal_receipt(self):
        def pull(command,log):log.write_bytes(b'synthetic failure');return 1
        with patch.object(c,'resolve_layout',return_value=self.layout),patch.object(c,'bounded_build',side_effect=pull),patch.object(c,'base_inspect') as inspect,contextlib.redirect_stdout(io.StringIO()),self.assertRaisesRegex(ValueError,'download failed'):
            c.provision_base(self.repo)
        inspect.assert_not_called()
        receipt=c.load(next((self.storage/'builds').rglob('terminal-receipt.json')))
        self.assertEqual(receipt['status'],'FAILED');self.assertEqual(receipt['exit_code'],1)

    def test_provision_refuses_foreign_digest_after_download(self):
        def pull(command,log):log.write_bytes(b'synthetic pull');return 0
        with patch.object(c,'resolve_layout',return_value=self.layout),patch.object(c,'bounded_build',side_effect=pull),patch.object(c,'base_inspect',side_effect=ValueError('base identity mismatch')),contextlib.redirect_stdout(io.StringIO()),self.assertRaisesRegex(ValueError,'identity mismatch'):
            c.provision_base(self.repo)
        receipt=c.load(next((self.storage/'builds').rglob('terminal-receipt.json')))
        self.assertEqual(receipt['status'],'FAILED')
        self.assertNotIn('verified_repo_digest',receipt)

    def test_log_limit_kills_only_owned_process(self):
        class Process:
            stdout=io.BytesIO(b'12345');killed=False
            def poll(self):return None if not self.killed else -9
            def kill(self):self.killed=True
            def wait(self,timeout):return -9
        process=Process()
        with patch.object(c.subprocess,'Popen',return_value=process),patch.object(c,'MAX_LOG',3),self.assertRaisesRegex(ValueError,'log bound'):
            c.bounded_build(['synthetic'],self.root/'build.log')
        self.assertTrue(process.killed);self.assertLessEqual((self.root/'build.log').stat().st_size,3)

    def test_source_readback_checks_exact_members(self):
        context=self.prepare();value=c.validate_context(context)
        target=self.root/'image';target.mkdir()
        proof=self.root/'proof.json';proof.write_bytes((context/'context.json').read_bytes())
        for e in value['files']:
            if e['path'] in ('Dockerfile','.dockerignore'):continue
            p=target/e['path'];p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes((context/e['path']).read_bytes())
        code=c.READBACK.replace('/opt/runner/source-proof.json',proof.as_posix()).replace('/opt/runner/scripts',target.as_posix())
        out=io.StringIO()
        with contextlib.redirect_stdout(out):exec(code,{})
        self.assertEqual(json.loads(out.getvalue())['proof_sha256'],c.sha(proof))
        (target/'unexpected').write_bytes(b'extra')
        with self.assertRaises(AssertionError):exec(code,{})


if __name__=='__main__':unittest.main()
