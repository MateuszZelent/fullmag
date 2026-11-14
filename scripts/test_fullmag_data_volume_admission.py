"""Real tiny archive/certificate/writer checks; root and mount probes simulated."""
from contextlib import ExitStack
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
from types import SimpleNamespace
import unittest
from unittest import mock

from scripts import test_linux_native_data_volume_migration as fixtures


class AdmissionPreparationTests(unittest.TestCase):
    def setUp(self):
        from scripts import fullmag_data_volume_admission as admission
        self.module=admission
        self.case=fixtures.DataVolumeStateMigrationTests();self.case.setUp()
        self.addCleanup(self.case.doCleanups)
        self.state=self.case.state;self.pins=self.case.pins
        self.store=self.state/'runs/docker-all/session-store';self.store.mkdir(parents=True)
        self.writer=self.store/'WRITER.lock';self.writer.touch()
        info=self.writer.stat()
        self.entry={'role':'state','path':'runs/docker-all/session-store/WRITER.lock','kind':'file',
            'uid':info.st_uid,'gid':info.st_gid,'mode':stat.S_IMODE(info.st_mode),'mtime_ns':info.st_mtime_ns,
            'xattrs':{},'size':0,'sha256':hashlib.sha256(b'').hexdigest(),'hardlink_to':None}
        self.archive=self.case.volume/'migration'/self.pins['volume_id']/'state-admission.json'
        self.archive.parent.mkdir(parents=True,mode=0o700)
        self.request={'schema':admission.SCHEMA,'pins':self.pins,'writer_entry':self.entry}
        self.original={name:(self.state/name).read_bytes() for name in admission.migration.host.READMISSION_FILES}
        self.stack=ExitStack();self.addCleanup(self.stack.close)
        self.stack.enter_context(self.case.patches())
        self.stack.enter_context(mock.patch.object(admission.os,'geteuid',return_value=0))
        # Root ownership is tested separately; these files belong to the test operator.
        self.stack.enter_context(mock.patch.object(admission,'_require_archive_directory'))

    def locked(self):
        descriptor=os.open(self.writer,os.O_RDONLY)
        try:
            with self.assertRaises(BlockingIOError):fcntl.flock(descriptor,fcntl.LOCK_EX|fcntl.LOCK_NB)
        finally:os.close(descriptor)

    def call(self):
        return self.module.prepare_guarded(self.request)

    def test_archive_and_certificate_change_happen_under_existing_new_writer(self):
        original_prepare=self.module.migration.prepare_state_migration
        original_apply=self.module.migration.apply_state_migration
        calls=[]
        def prepare(*args):
            self.locked();calls.append('prepare');return original_prepare(*args)
        def apply(*args):
            self.locked();calls.append('apply')
            self.assertTrue(self.archive.is_file())
            self.assertEqual(hashlib.sha256(self.archive.read_bytes()).hexdigest(),args[3])
            return original_apply(*args)
        with mock.patch.object(self.module.migration,'prepare_state_migration',side_effect=prepare), \
                mock.patch.object(self.module.migration,'apply_state_migration',side_effect=apply):result=self.call()
        self.assertEqual(calls,['prepare','apply'])
        self.assertFalse(result['namespace_admitted']);self.assertFalse(result['originals_retired'])
        self.assertEqual(result['state'],'admission-prepared-not-admitted')
        self.assertEqual(stat.S_IMODE(self.archive.stat().st_mode),0o600)
        archived=json.loads(self.archive.read_bytes())
        self.assertEqual(json.loads(self.case.fixture.certificate_path.read_bytes()),archived['candidate'])
        self.assertFalse(archived['candidate']['restart_verified'])
        for name in self.module.migration.host.READMISSION_FILES[2:]:
            self.assertEqual((self.state/name).read_bytes(),self.original[name])
        descriptor=os.open(self.writer,os.O_RDONLY)
        try:fcntl.flock(descriptor,fcntl.LOCK_EX|fcntl.LOCK_NB)
        finally:os.close(descriptor)

    def test_foreign_existing_writer_refuses_before_archive_or_certificate_write(self):
        descriptor=os.open(self.writer,os.O_RDONLY);fcntl.flock(descriptor,fcntl.LOCK_EX|fcntl.LOCK_NB)
        try:
            with self.assertRaises(BlockingIOError):self.call()
        finally:os.close(descriptor)
        self.assertFalse(self.archive.exists())
        self.assertEqual(self.case.fixture.certificate_path.read_bytes(),self.original['linux-native-host.json'])

    def test_outer_new_writer_stays_locked_after_preparation_using_duplicate(self):
        with self.module.bind_stage._copied_writer(self.state,self.entry) as descriptor:
            result=self.module.prepare_guarded(self.request,writer_fd=descriptor)
            self.locked()
            self.assertEqual(os.fstat(descriptor).st_ino,self.writer.stat().st_ino)
        self.assertEqual(result['state'],'admission-prepared-not-admitted')

    def test_foreign_borrowed_descriptor_cannot_authorize_a_new_store_write(self):
        other=self.state/'foreign-writer';other.touch();descriptor=os.open(other,os.O_RDONLY)
        try:
            with self.assertRaisesRegex(ValueError,'writer'):
                self.module.prepare_guarded(self.request,writer_fd=descriptor)
            separate=os.open(other,os.O_RDONLY)
            try:fcntl.flock(separate,fcntl.LOCK_EX|fcntl.LOCK_NB)
            finally:os.close(separate)
        finally:os.close(descriptor)
        self.assertFalse(self.archive.exists())

    def test_invalid_borrowed_descriptor_never_creates_archive(self):
        for value in (True,-1,'3'):
            with self.subTest(value=value),self.assertRaises(ValueError):
                self.module.prepare_guarded(self.request,writer_fd=value)
        self.assertFalse(self.archive.exists())

    def test_existing_archive_is_preserved_without_replay(self):
        self.archive.write_bytes(b'keep this exact previous attempt')
        with mock.patch.object(self.module.migration,'prepare_state_migration') as prepare, self.assertRaises(ValueError):self.call()
        prepare.assert_not_called();self.assertEqual(self.archive.read_bytes(),b'keep this exact previous attempt')

    def test_application_failure_keeps_original_archive_and_partial_state(self):
        def fail(*args):
            self.locked();self.case.fixture.owner_path.write_bytes(b'partial candidate')
            raise RuntimeError('interrupted apply')
        with mock.patch.object(self.module.migration,'apply_state_migration',side_effect=fail), \
                self.assertRaisesRegex(RuntimeError,'interrupted'):self.call()
        self.assertTrue(self.archive.is_file())
        self.assertEqual(self.case.fixture.owner_path.read_bytes(),b'partial candidate')
        self.assertEqual(self.case.fixture.certificate_path.read_bytes(),self.original['linux-native-host.json'])

    def test_new_writer_path_replacement_after_apply_refuses_while_old_fd_is_locked(self):
        apply=self.module.migration.apply_state_migration
        retained=self.writer.with_suffix('.retained')
        def replace(*args):
            value=apply(*args);self.writer.rename(retained);self.writer.touch();return value
        with mock.patch.object(self.module.migration,'apply_state_migration',side_effect=replace), \
                self.assertRaisesRegex(ValueError,'writer'):self.call()
        self.assertTrue(retained.is_file());self.assertTrue(self.archive.is_file())

    def test_archive_parent_replacement_after_apply_is_detected_and_retained(self):
        apply=self.module.migration.apply_state_migration;retained=self.archive.parent.with_name('retained-original-archive')
        def replace(*args):
            value=apply(*args);self.archive.parent.rename(retained);self.archive.parent.mkdir();return value
        with mock.patch.object(self.module.migration,'apply_state_migration',side_effect=replace), \
                self.assertRaises(ValueError):self.call()
        self.assertTrue((retained/self.archive.name).is_file())

    def test_archive_parent_replacement_before_apply_keeps_certificate_original(self):
        archive=self.module._archive;retained=self.archive.parent.with_name('retained-archive-before-apply')
        def replace(*args):
            digest=archive(*args);self.archive.parent.rename(retained);self.archive.parent.mkdir();return digest
        with mock.patch.object(self.module,'_archive',side_effect=replace), \
                mock.patch.object(self.module.migration,'apply_state_migration') as apply,self.assertRaises(ValueError):self.call()
        apply.assert_not_called();self.assertTrue((retained/self.archive.name).is_file())
        self.assertEqual(self.case.fixture.certificate_path.read_bytes(),self.original['linux-native-host.json'])

    def test_new_root_replacement_after_apply_is_detected_and_original_retained(self):
        apply=self.module.migration.apply_state_migration;retained=self.state.with_name('retained-state')
        def replace(*args):
            value=apply(*args);self.state.rename(retained);self.state.mkdir();return value
        with mock.patch.object(self.module.migration,'apply_state_migration',side_effect=replace),self.assertRaises(ValueError):self.call()
        self.assertTrue((retained/'linux-native-host.json').is_file());self.assertTrue(self.archive.is_file())

    def test_wrong_original_admission_sha_refuses_before_archive(self):
        self.pins['files']['linux-native-host.json']='0'*64
        with self.assertRaises(ValueError):self.call()
        self.assertFalse(self.archive.exists())
        self.assertEqual(self.case.fixture.certificate_path.read_bytes(),self.original['linux-native-host.json'])

    def test_closed_request_root_and_authenticated_writer_metadata_are_required(self):
        for mutate in (lambda r:r.update(extra=True),lambda r:r['pins'].pop('files'),
                       lambda r:r['writer_entry'].update(path='other'),lambda r:r['writer_entry'].update(uid=-1)):
            request=copy.deepcopy(self.request);mutate(request)
            with self.assertRaises(ValueError):self.module.prepare_guarded(request)
            self.assertFalse(self.archive.exists())
        with mock.patch.object(self.module.os,'geteuid',return_value=1000),self.assertRaisesRegex(ValueError,'root'):
            self.call()

    def test_writer_bytes_are_authenticated_in_addition_to_metadata(self):
        self.entry['sha256']='0'*64
        with self.assertRaisesRegex(ValueError,'writer'):self.call()
        self.assertFalse(self.archive.exists())


class ArchiveDirectoryProtectionTests(unittest.TestCase):
    def test_only_root_owned_mode0700_on_exact_new_device_is_accepted(self):
        from scripts import fullmag_data_volume_admission as admission
        correct={'st_mode':stat.S_IFDIR|0o700,'st_uid':0,'st_dev':2128}
        with mock.patch.object(admission.os,'fstat',return_value=SimpleNamespace(**correct)):
            admission._require_archive_directory(123,{'observed_device':2128})
        for key,value in [('st_uid',1000),('st_mode',stat.S_IFDIR|0o750),('st_mode',stat.S_IFREG|0o700),('st_dev',2129)]:
            with mock.patch.object(admission.os,'fstat',return_value=SimpleNamespace(**dict(correct,**{key:value}))), \
                    self.assertRaisesRegex(ValueError,'root-owned'):
                admission._require_archive_directory(123,{'observed_device':2128})


if __name__=='__main__':unittest.main()
