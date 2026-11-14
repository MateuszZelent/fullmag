"""Retained-copy qualification: real tiny PAX trees, no mount or copy replay."""
from contextlib import ExitStack
import copy
import hashlib
import io
import os
from pathlib import Path
import tarfile
import struct
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

from scripts import fullmag_data_volume_fs as fs
from scripts import linux_data_volume_copy as stage
from scripts import docker_data_volume_root_bootstrap as bootstrap


class _RetainedCopyFixture:
    """Shared tiny archive fixture without duplicated test discovery."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent.parent); self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.source = self.base/'source'; self.source.mkdir()
        self.target = self.base/'target'; self.target.mkdir()
        self.roots = {'user_data':self.source/'user', 'state':self.source/'state'}
        for root in self.roots.values(): root.mkdir()
        store = self.roots['state']/'runs/docker-all/session-store'; store.mkdir(parents=True)
        (store/'WRITER.lock').write_bytes(b'')
        (self.roots['user_data']/'chunk').write_bytes(b'retained science')
        os.setxattr(self.roots['user_data']/'chunk', 'user.recovery', b'yes')
        os.link(self.roots['user_data']/'chunk', self.roots['state']/'alias')
        self.archive = self.target/'originals.pax'; self.payload = self.target/'payload'
        patch = mock.patch.object(fs.os, 'fstatvfs', return_value=SimpleNamespace(f_bavail=128*1024**3, f_frsize=1))
        patch.start(); self.addCleanup(patch.stop)
        self.original = fs.archive_and_extract(self.source, self.roots, self.archive, self.payload)
        self.archive_bytes = self.archive.read_bytes()
        self.verify = self.target/'recovery-verification-token'

    def recover(self):
        return fs.requalify_existing_copy(self.source, self.roots, self.archive, self.payload, self.verify)

class RetainedCopyFilesystemTests(_RetainedCopyFixture,unittest.TestCase):
    def test_three_views_preserve_original_archive_payload_and_lock(self):
        lock = self.payload/'state/runs/docker-all/session-store/WRITER.lock'
        inode = lock.stat().st_ino
        with mock.patch.object(fs, 'archive_and_extract', side_effect=AssertionError('ordinary copy replay')):
            value = self.recover()
        self.assertEqual(value['data_sha256'], self.original['data_sha256'])
        self.assertEqual(value['archive_sha256'], hashlib.sha256(self.archive_bytes).hexdigest())
        self.assertEqual(self.archive.read_bytes(), self.archive_bytes)
        self.assertEqual(lock.stat().st_ino, inode)
        self.assertEqual((self.verify/'user/chunk').read_bytes(), b'retained science')
        with self.assertRaises(ValueError): self.recover()

    def test_source_payload_and_archive_drift_refuse_without_overwrite(self):
        for location in ('source','payload','archive'):
            with self.subTest(location=location):
                if location == 'source': path = self.roots['user_data']/'chunk'
                elif location == 'payload': path = self.payload/'user/chunk'
                else: path = self.archive
                before = path.read_bytes(); metadata = path.stat()
                path.write_bytes(before+b'changed')
                with self.assertRaises(ValueError): self.recover()
                self.assertEqual(path.read_bytes(), before+b'changed')
                path.write_bytes(before); os.utime(path, ns=(metadata.st_atime_ns, metadata.st_mtime_ns))
                # Failed verification directories are retained: use a distinct attempt.
                self.verify = self.verify.with_name(self.verify.name+'-next')

    def test_recovery_preserves_extended_acl(self):
        # A separate archive is made only by the fixture setup, before recovery.
        undefined = 0xffffffff
        entries = [(1,7,undefined),(2,5,os.getuid()+1),(4,0,undefined),(16,5,undefined),(32,0,undefined)]
        acl = struct.pack('<I',2)+b''.join(struct.pack('<HHI',*item) for item in entries)
        for name in ('system.posix_acl_access','system.posix_acl_default'):
            os.setxattr(self.roots['user_data'],name,acl)
        archive = self.target/'acl.pax'; payload = self.target/'acl-payload'
        fs.archive_and_extract(self.source,self.roots,archive,payload)
        verify = self.target/'acl-verification'
        fs.requalify_existing_copy(self.source,self.roots,archive,payload,verify)
        for name in ('system.posix_acl_access','system.posix_acl_default'):
            self.assertEqual(os.getxattr(verify/'user',name),os.getxattr(self.roots['user_data'],name))

    def test_unsafe_archive_members_refused_before_extraction(self):
        for name, kind, link in [('../escape',tarfile.REGTYPE,''), ('/absolute',tarfile.REGTYPE,''),
                                ('user/link',tarfile.SYMTYPE,'../../escape'),
                                ('user/device',tarfile.CHRTYPE,''),
                                ('user/chunk',tarfile.LNKTYPE,'../../escape')]:
            with self.subTest(name=name):
                with tarfile.open(self.archive,'w',format=tarfile.PAX_FORMAT) as archive:
                    item=tarfile.TarInfo(name); item.type=kind; item.linkname=link
                    archive.addfile(item)
                with mock.patch.object(fs,'_run_to_file',side_effect=AssertionError('unsafe extraction')):
                    with self.assertRaises(ValueError): self.recover()
                self.verify=self.verify.with_name(self.verify.name+'-next')


class RecoveryContractTests(unittest.TestCase):
    def request(self):
        return {'schema':'fullmag.data-volume-copy-recovery-request.v1','volume_id':'1'*32,
                'storage_root':'/srv/fullmag/storage','token':'2'*32,
                'failed_journal_relative':'recovery/'+'3'*32+'/journal.json',
                **{k:'a'*64 for k in ('original_copy_request_sha256','failed_copy_receipt_sha256',
                   'failed_journal_sha256','selector_sha256','recovery_journal_sha256','fence_ready_sha256')},
                'components':{k:'b'*64 for k in stage.COMPONENTS}}

    def test_closed_recovery_request_and_bootstrap(self):
        request=self.request()
        self.assertEqual(stage.validate_recovery_request(request), request)
        self.assertIn("STAGE = 'recover-copy'",bootstrap.bootstrap('recover-copy'))
        for key,value in [('unexpected',True),('failed_journal_relative','../journal.json'),
                          ('token','0'*32),('components',{})]:
            changed=dict(request); changed[key]=value
            with self.subTest(key=key),self.assertRaises(ValueError): stage.validate_recovery_request(changed)


class RootRecoveryFixture:
    """Real immutable request/journal files with only root/mount probes mocked."""
    def setUp(self):
        RetainedCopyFilesystemTests.setUp(self)
        from scripts.test_linux_data_volume_copy import CopyContextTests, journal_to_copy
        template = CopyContextTests(); template.setUp()
        self.volume = template.request['volume_id']; self.token = '8'*32
        self.op = self.source/'migrations/data-volumes'/self.volume
        self.op.mkdir(parents=True)
        self.attempt = self.op/'recovery'/self.token; self.attempt.mkdir(parents=True)
        self.failed_relative = 'recovery/'+'7'*32+'/journal.json'
        (self.op/self.failed_relative).parent.mkdir()
        self.archive_root = self.target/'migration'/self.volume; self.archive_root.mkdir(parents=True)
        self.archive.rename(self.archive_root/'originals.pax'); self.archive = self.archive_root/'originals.pax'
        self.verify = self.archive_root/'recovery-verification-fixture'
        self.original_request = copy.deepcopy(template.request)
        self.original_request.update(storage_root=str(self.source))
        # Old source pins are intentionally obsolete; recovery pins the current graph.
        self.original_request['components'] = {k:'0'*64 for k in stage.COMPONENTS}
        for k in ('linux_data_volume_format.py','linux_data_volume_provision.py'):
            self.original_request['components'][k] = template.request['components'][k]
        self.linux = copy.deepcopy(template.linux)
        self.linux.update(storage_root=str(self.source),mount_root=str(self.target),
            source_roots={role:{'canonical_root':str(root),'device':root.stat().st_dev,'inode':root.stat().st_ino}
                          for role,root in self.roots.items()})
        linux_sha = self.write(self.op/'linux-provision-request.json',self.linux)
        self.original_request['linux_request_sha256'] = linux_sha
        self.plan = copy.deepcopy(template.plan)
        self.plan.update(storage_root=str(self.source),mount_root=str(self.target),
            observation={'datasets':self.linux['source_roots']},worktree_id='fixture')
        plan_sha = self.write(self.op/'plan.json',self.plan)
        self.provision = copy.deepcopy(template.provision)
        self.provision.update(linux_request_sha256=linux_sha)
        provision_sha = self.write(self.op/'linux-provision-result.json',self.provision)
        self.original_request['provision_result_sha256'] = provision_sha
        self.drain = copy.deepcopy(template.drain)
        self.drain.update(plan_sha256=plan_sha,source_roots=self.linux['source_roots'])
        drain_sha = self.write(self.op/'group-drained.json',self.drain)
        self.original_request['drain_sha256'] = drain_sha
        ready = copy.deepcopy(template.ready)
        self.original_request['fence_ready_sha256'] = self.write(self.op/'copy-fence-ready.json',ready)
        original_sha = self.write(self.op/'linux-copy-request.json',self.original_request)
        self.original_sha = original_sha
        self.write(self.op/'linux-copy-started.json',{'schema':'fullmag.data-volume-copy-started.v1',
            'volume_id':self.volume,'token':self.original_request['token'],'request_sha256':original_sha})
        self.failure = {'schema':'fullmag.data-volume-linux-copy-failure.v1','state':'failed-confirmed',
            'volume_id':self.volume,'token':self.original_request['token'],'request_sha256':original_sha,
            'error_type':'ValueError','originals_and_partial_copy_retained':True}
        failure_sha = self.write(self.op/'linux-copy-failed.json',self.failure)
        from scripts.fullmag_data_volume_journal import append_started, append_terminal
        self.prefix = journal_to_copy(self.volume,plan_sha,provision_sha,drain_sha)
        failed = append_terminal(append_started(self.prefix,'copy-verified',original_sha),'failed-confirmed',failure_sha)
        failed_sha = self.write(self.op/self.failed_relative,failed)
        prefix_sha = self.write(self.attempt/'journal.json',self.prefix)
        self.selector = {'schema':'fullmag.data-volume-active-recovery.v2','volume_id':self.volume,
            'attempt':self.token,'journal_relative':'recovery/'+self.token+'/journal.json',
            'parent_journal_relative':self.failed_relative,'parent_journal_sha256':failed_sha,'state':'started'}
        selector_sha = self.write(self.op/'active-attempt.json',self.selector)
        ready['token'] = self.token
        ready_sha = self.write(self.attempt/'fence-ready.json',ready)
        self.recovery = {'schema':stage.RECOVERY_SCHEMA,'volume_id':self.volume,'storage_root':str(self.source),
            'token':self.token,'original_copy_request_sha256':original_sha,'failed_copy_receipt_sha256':failure_sha,
            'failed_journal_relative':self.failed_relative,'failed_journal_sha256':failed_sha,
            'selector_sha256':selector_sha,'recovery_journal_sha256':prefix_sha,'fence_ready_sha256':ready_sha,
            'components':{k:hashlib.sha256((Path(stage.__file__).parent/k).read_bytes()).hexdigest() for k in stage.COMPONENTS}}
        self.request_path = self.attempt/'copy-recovery-request.json'
        self.request_sha = self.write(self.request_path,self.recovery)
        patches = ExitStack(); self.addCleanup(patches.close)
        class RootBoundary:
            def __getattr__(self,name): return getattr(os,name)
            def geteuid(self): return 0
        patches.enter_context(mock.patch.object(stage,'os',RootBoundary()))
        patches.enter_context(mock.patch.object(stage.qualification,'probe_host',return_value={'boot_id':self.linux['boot_id']}))
        patches.enter_context(mock.patch.object(stage,'_mounted_root',return_value=self.target))

    def write(self,path,value):
        raw = stage._encoded(value); path.write_bytes(raw)
        return hashlib.sha256(raw).hexdigest()


class RootRecoveryTests(RootRecoveryFixture, unittest.TestCase):
    def test_root_success_v2_completed_reader_and_no_replay(self):
        old_request = (self.op/'linux-copy-request.json').read_bytes()
        old_failure = (self.op/'linux-copy-failed.json').read_bytes()
        old_journal = (self.op/self.failed_relative).read_bytes()
        with mock.patch.object(stage,'copy_verified',side_effect=AssertionError('ordinary copy')):
            result = stage.recover_verified(self.request_path,self.request_sha)
        self.assertEqual(result['schema'],'fullmag.data-volume-linux-copy-result.v2')
        self.assertEqual(result['token'],self.original_request['token'])
        self.assertEqual(result['request_sha256'],self.original_sha)
        result_raw=(self.op/'linux-copy-result.json').read_bytes()
        context=stage.load_context(self.op/'linux-copy-request.json',self.original_sha,
            completed_receipt_sha256=hashlib.sha256(result_raw).hexdigest())
        self.assertEqual(context['copy_result'],result)
        self.assertEqual((self.archive_root/'source-manifest.json').read_bytes(),
                         (self.op/'source-manifest-export.json').read_bytes())
        self.assertEqual((self.op/'linux-copy-request.json').read_bytes(),old_request)
        self.assertEqual((self.op/'linux-copy-failed.json').read_bytes(),old_failure)
        self.assertEqual((self.op/self.failed_relative).read_bytes(),old_journal)
        with self.assertRaises(ValueError): stage.recover_verified(self.request_path,self.request_sha)
        with self.assertRaises(ValueError): stage.copy_verified(self.op/'linux-copy-request.json',self.original_sha)

    def test_wrong_predecessor_selector_failure_ready_and_graph_refuse(self):
        cases = [(self.op/'active-attempt.json','parent_journal_relative','recovery/'+'6'*32+'/journal.json','selector_sha256'),
                 (self.op/'linux-copy-failed.json','state','outcome-unknown-resources-retained','failed_copy_receipt_sha256'),
                 (self.attempt/'fence-ready.json','token',self.original_request['token'],'fence_ready_sha256'),
                 (self.op/self.failed_relative,'volume_id','6'*32,'failed_journal_sha256')]
        for path,key,value,pin in cases:
            with self.subTest(path=path):
                original=path.read_bytes(); body=stage.qualification._read(path)[1]; body[key]=value
                changed=copy.deepcopy(self.recovery); changed[pin]=self.write(path,body)
                changed_sha=self.write(self.request_path,changed)
                with self.assertRaises(ValueError): stage.recover_verified(self.request_path,changed_sha)
                self.assertFalse((self.attempt/'copy-recovery-started.json').exists())
                path.write_bytes(original)
                self.write(self.request_path,self.recovery)
        changed=copy.deepcopy(self.recovery); changed['components']['fullmag_data_volume_fs.py']='0'*64
        changed_sha=self.write(self.request_path,changed)
        with self.assertRaises(ValueError): stage.recover_verified(self.request_path,changed_sha)

    def test_bind_or_pending_blocks_before_start(self):
        for path in (self.op/'linux-bind-event-042.json',self.source/'index/data-volumes/fixture.pending.json'):
            path.parent.mkdir(parents=True,exist_ok=True); path.write_text('{}')
            with self.assertRaises(ValueError): stage.recover_verified(self.request_path,self.request_sha)
            self.assertFalse((self.attempt/'copy-recovery-started.json').exists())
            path.unlink()

    def test_verification_failure_terminalizes_only_new_attempt(self):
        (self.payload/'user/chunk').write_bytes(b'drift')
        with self.assertRaises(ValueError): stage.recover_verified(self.request_path,self.request_sha)
        _,failure=stage.qualification._read(self.attempt/'copy-recovery-failed.json')
        self.assertEqual(failure,{'schema':'fullmag.data-volume-copy-recovery-failure.v1','state':'failed-confirmed',
            'volume_id':self.volume,'token':self.token,'request_sha256':self.request_sha,
            'original_copy_request_sha256':self.original_sha,'error_type':'ValueError',
            'originals_archive_and_payload_retained':True})
        _,journal=stage.qualification._read(self.attempt/'journal.json')
        self.assertEqual(journal['events'][-1]['state'],'failed-confirmed')
        self.assertEqual(journal['events'][-1]['inputs_sha256'],self.request_sha)
        self.assertFalse((self.op/'linux-copy-result.json').exists())


class RootRecoveryProbeTests(RootRecoveryFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        from scripts.fullmag_data_volume_journal import append_started, append_terminal
        historical = append_terminal(append_started(dict(self.prefix,events=self.prefix['events'][:4]),
            'ext4-mounted','a'*64),'failed-confirmed','b'*64)
        historical_sha = self.write(self.op/'journal.json',historical)
        self.old_selector = {'schema':'fullmag.data-volume-active-recovery.v1','volume_id':self.volume,
            'attempt':'7'*32,'journal_relative':self.failed_relative,
            'parent_journal_sha256':historical_sha,'state':'started'}
        old_selector_sha = self.write(self.op/'active-attempt.json',self.old_selector)
        self.write(self.attempt/'previous-active-attempt.json',self.old_selector)
        self.probe = dict(self.recovery,schema='fullmag.data-volume-copy-recovery-probe.v1',
                          selector_sha256=old_selector_sha,
                          fence_ready_sha256=self.original_request['fence_ready_sha256'])
        (self.attempt/'fence-ready.json').unlink()
        self.probe_path = self.attempt/'copy-recovery-probe-request.json'
        self.probe_sha = self.write(self.probe_path,self.probe)

    def probe_snapshot(self):
        return {str(p.relative_to(self.base)):p.read_bytes() for p in self.base.rglob('*') if p.is_file()}

    def assert_probe_readonly(self, *, error=False):
        before = self.probe_snapshot()
        with ExitStack() as stack:
            for name in ('_document','_publish_journal','_operation_lock','requalify_existing_copy'):
                stack.enter_context(mock.patch.object(stage,name,side_effect=AssertionError('probe attempted '+name)))
            if error:
                with self.assertRaises(ValueError): stage.probe_recovery(self.probe_path,self.probe_sha)
                result = None
            else: result = stage.probe_recovery(self.probe_path,self.probe_sha)
        self.assertEqual(self.probe_snapshot(),before)
        return result

    def test_probe_exact_output_and_readonly(self):
        value = self.assert_probe_readonly()
        self.assertEqual(value,{'schema':'fullmag.data-volume-copy-recovery-probe-result.v1',
            'state':'ready-for-copy-recovery','volume_id':self.volume,'token':self.token,
            'request_sha256':self.probe_sha,'original_copy_request_sha256':self.original_sha,
            'failed_copy_receipt_sha256':self.recovery['failed_copy_receipt_sha256'],
            'filesystem_uuid':self.linux['filesystem_uuid']})
        self.assertIn("STAGE = 'probe-copy-recovery'",bootstrap.bootstrap('probe-copy-recovery'))
        self.assertEqual(stage.validate_recovery_probe_request(self.probe),self.probe)

    def test_probe_requires_closed_request_and_historical_ready_pin(self):
        for changed in (dict(self.probe,unexpected=True),dict(self.probe,schema=stage.RECOVERY_SCHEMA)):
            with self.assertRaises(ValueError): stage.validate_recovery_probe_request(changed)
        changed = dict(self.probe,fence_ready_sha256=self.recovery['fence_ready_sha256'])
        self.probe_sha = self.write(self.probe_path,changed)
        self.assert_probe_readonly(error=True)
        self.assertFalse((self.attempt/'fence-ready.json').exists())

    def test_probe_rejects_private_manifest_and_old_evidence_drift_without_writes(self):
        private = self.archive_root/'source-manifest.json'; private.write_text('{}')
        self.assert_probe_readonly(error=True); private.unlink()
        for path in (self.op/'linux-copy-started.json',self.op/'copy-fence-ready.json'):
            original=path.read_bytes()
            path.unlink(); self.assert_probe_readonly(error=True)
            path.write_bytes(b'{}'); self.assert_probe_readonly(error=True)
            path.write_bytes(original)

    def test_probe_rejects_parent_prefix_ack_and_previous_selector_without_writes(self):
        for path in (self.op/'active-attempt.json',self.attempt/'journal.json',
                     self.op/'copy-fence-ready.json',self.attempt/'previous-active-attempt.json'):
            original=path.read_bytes(); path.write_text('{}')
            self.assert_probe_readonly(error=True); path.write_bytes(original)



if __name__ == '__main__': unittest.main()
