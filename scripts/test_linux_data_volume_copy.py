"""Root-copy scope checks and real tiny-file archives, without root/mounts."""
from contextlib import ExitStack
import copy
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

from scripts import linux_data_volume_copy as stage
from scripts.fullmag_data_volume_journal import new_journal, append_started, append_terminal


def digest(value):
    raw = value if isinstance(value,bytes) else (json.dumps(value,sort_keys=True)+'\n').encode()
    return hashlib.sha256(raw).hexdigest()


def journal_to_copy(volume, plan_sha, provision_sha, drain_sha):
    journal = new_journal(volume,plan_sha)
    for phase,receipt in [('image-created','a'*64),('image-attached','b'*64),
                          ('ext4-mounted',provision_sha),('group-drained',drain_sha)]:
        journal = append_terminal(append_started(journal,phase,'c'*64),'succeeded',receipt)
    return journal


class CopyContextTests(unittest.TestCase):
    def setUp(self):
        self.request={'schema':stage.SCHEMA,'volume_id':'1'*32,'storage_root':'/srv/fullmag/storage','token':'2'*32,
          'linux_request_sha256':'3'*64,'provision_result_sha256':'4'*64,
          'drain_sha256':'5'*64,'fence_ready_sha256':'6'*64,
          'components':{name:hashlib.sha256((Path(stage.__file__).parent/name).read_bytes()).hexdigest() for name in stage.COMPONENTS}}
        self.op=Path(self.request['storage_root'])/'migrations/data-volumes'/self.request['volume_id']
        self.path=self.op/'linux-copy-request.json'
        roots={k:{'canonical_root':'/srv/fullmag/storage/'+k,'device':100,'inode':i}
               for k,i in [('state',10),('user_data',20)]}
        self.linux={'schema':'fullmag.data-volume-linux-provision.v1','volume_id':self.request['volume_id'],
          'storage_root':self.request['storage_root'],'mount_root':'/mnt/fullmag-data-fixture','capacity_bytes':128*1024**3,
          'filesystem_uuid':'11111111-1111-4111-8111-111111111111','boot_id':'22222222-2222-4222-8222-222222222222',
          'source_roots':roots,**{k:'a'*64 for k in ('baseline_sha256','attach_inputs_sha256',
            'provision_request_sha256','created_receipt_sha256','attached_receipt_sha256','controller_sha256')}}
        self.plan={'volume_id':self.request['volume_id'],'storage_root':self.request['storage_root'],
          'mount_root':self.linux['mount_root'],'observation':{'datasets':roots},
          'runtime_pins':{'backend':'a'*64,'frontend':'b'*64}}
        self.plan_raw=(json.dumps(self.plan,sort_keys=True)+'\n').encode()
        self.provision={'schema':'fullmag.data-volume-linux-provision-result.v1','state':'mounted-not-data-migrated',
          'volume_id':self.request['volume_id'],'filesystem_uuid':self.linux['filesystem_uuid'],
          'linux_request_sha256':self.request['linux_request_sha256'],
          'formatter_sha256':self.request['components']['linux_data_volume_format.py'],'namespace_admitted':False,
          'filesystem':{'device':200,'inode':2,'mount':{'maj:min':'8:9'}}}
        self.drain={'schema':'fullmag.data-volume-group-drained.v1','volume_id':self.request['volume_id'],
          'token':self.request['token'],'plan_sha256':digest(self.plan_raw),'source_roots':roots,
          'stop_attempt':'7'*32,'stop_sha256':'8'*64,'process_receipt_sha256':'9'*64,
          'containers':dict(self.plan['runtime_pins'])}
        paths=['/opt/fullmag/runtime-control/runtime-services/'+n+'.lock' for n in ('STARTUP-GATE','LAUNCH','OWNER')]
        paths+=['/host-ledger/ledger/WRITER.lock','/state/runs/docker-all/session-store/WRITER.lock']
        self.ready={'schema':'fullmag.data-copy-fence-event.v1','state':'held','token':self.request['token'],
          'volume_id':self.request['volume_id'],'observation':{'schema':'fullmag.data-volume-copy-fences.v1',
            'locks':[{'path':p,'device':200,'inode':10+i} for i,p in enumerate(paths)],
            'authentication':{'process_receipt_sha256':self.drain['process_receipt_sha256'],'released':{'active_count':0}}}}
        self.journal=journal_to_copy(self.request['volume_id'],digest(self.plan_raw),
          self.request['provision_result_sha256'],self.request['drain_sha256'])
        self.evidence={'linux-copy-request.json':self.request,'linux-provision-request.json':self.linux,
          'plan.json':self.plan,'linux-provision-result.json':self.provision,
          'group-drained.json':self.drain,'copy-fence-ready.json':self.ready}
        self.expected={'linux-copy-request.json':'f'*64,'linux-provision-request.json':'3'*64,
          'plan.json':None,'linux-provision-result.json':'4'*64,'group-drained.json':'5'*64,'copy-fence-ready.json':'6'*64}

    def read(self,path,expected=None):
        self.assertEqual(path.parent,self.op)
        self.assertEqual(expected,self.expected[path.name])
        value=self.evidence[path.name]
        raw=self.plan_raw if path.name=='plan.json' else json.dumps(value).encode()
        return raw,copy.deepcopy(value)

    def patches(self):
        stack=ExitStack()
        stack.enter_context(mock.patch.object(stage.os,'geteuid',return_value=0))
        stack.enter_context(mock.patch.object(stage.qualification,'_read',side_effect=self.read))
        stack.enter_context(mock.patch.object(stage.qualification,'probe_host',return_value={'boot_id':self.linux['boot_id']}))
        stack.enter_context(mock.patch.object(stage.qualification,'_selected_journal',side_effect=lambda _op:(self.op/'journal.json',copy.deepcopy(self.journal))))
        stack.enter_context(mock.patch.object(stage,'_source_roots',return_value={k:Path(p['canonical_root']) for k,p in self.linux['source_roots'].items()}))
        stack.enter_context(mock.patch.object(stage,'_mounted_root',return_value=Path(self.linux['mount_root'])))
        return stack

    def test_closed_request_and_real_component_hashes_accept(self):
        with self.patches():value=stage.load_context(self.path,'f'*64)
        self.assertEqual(value['request'],self.request)
        self.assertEqual(value['roots']['state'],Path(self.linux['source_roots']['state']['canonical_root']))

    def completed_copy(self,request_sha='f'*64):
        receipt_sha='c'*64
        self.journal=append_terminal(append_started(self.journal,'copy-verified',request_sha),'succeeded',receipt_sha)
        target=Path(self.linux['mount_root']);archive=target/'migration'/self.request['volume_id']
        result={'schema':'fullmag.data-volume-linux-copy-result.v1','state':'copied-and-verified-not-switched',
            'volume_id':self.request['volume_id'],'token':self.request['token'],'request_sha256':'f'*64,
            'filesystem_uuid':self.linux['filesystem_uuid'],'data_sha256':'d'*64,
            'manifest_path':str(archive/'source-manifest.json'),'manifest_sha256':'e'*64,
            'archive_path':str(archive/'originals.pax'),'archive_sha256':'a'*64,
            'copied_roots':{role:str(target/'payload'/Path(pin['canonical_root']).relative_to(self.request['storage_root']))
                            for role,pin in self.linux['source_roots'].items()},
            'namespace_admitted':False,'originals_retired':False}
        self.expected['linux-copy-result.json']=receipt_sha;self.evidence['linux-copy-result.json']=result
        return receipt_sha,result

    def test_completed_context_requires_exact_terminal_and_does_not_reenable_copy(self):
        receipt_sha,result=self.completed_copy()
        with self.patches():
            context=stage.load_context(self.path,'f'*64,completed_receipt_sha256=receipt_sha)
        self.assertEqual(context['copy_result'],result)
        self.assertEqual(context['plan_sha256'],digest(self.plan_raw))
        self.assertEqual(context['drain'],self.drain)
        with self.patches(),self.assertRaises(ValueError):
            stage.load_context(self.path,'f'*64)

    def test_completed_context_rejects_foreign_request_terminal_or_copy_result_scope(self):
        receipt_sha,result=self.completed_copy()
        for key,value in [('token','9'*32),('copied_roots',{}),('archive_path','/tmp/other.pax'),
                          ('namespace_admitted',True),('unexpected',False)]:
            changed=copy.deepcopy(result);changed[key]=value
            self.evidence['linux-copy-result.json']=changed
            with self.subTest(key=key),self.patches(),self.assertRaises(ValueError):
                stage.load_context(self.path,'f'*64,completed_receipt_sha256=receipt_sha)
        self.evidence['linux-copy-result.json']=result
        self.journal['events'][-1]['inputs_sha256']='0'*64
        self.journal['events'][-2]['inputs_sha256']='0'*64
        with self.patches(),self.assertRaises(ValueError):
            stage.load_context(self.path,'f'*64,completed_receipt_sha256=receipt_sha)

    def test_refuses_nonroot_before_reading_any_evidence(self):
        with mock.patch.object(stage.os,'geteuid',return_value=1000),mock.patch.object(stage.qualification,'_read') as read:
            with self.assertRaisesRegex(ValueError,'root'):stage.load_context(self.path,'f'*64)
        read.assert_not_called()

    def test_unknown_keys_boolean_tokens_and_transient_roots_are_refused(self):
        for key,value in [('extra','unknown'),('token',True),('storage_root','/tmp/not-durable'),
                          ('volume_id','0'*32),('drain_sha256',False),('components',{})]:
            candidate=copy.deepcopy(self.request);candidate[key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):stage.validate_request(candidate)

    def test_source_drift_is_refused_before_copy(self):
        self.request['components']['fullmag_data_volume_fs.py']='0'*64
        with self.patches(),self.assertRaisesRegex(ValueError,'source changed'):
            stage.load_context(self.path,'f'*64)

    def test_foreign_volume_boot_drain_or_fence_is_refused(self):
        mutations=[(self.linux,'volume_id','e'*32),(self.plan,'mount_root','/mnt/foreign'),
          (self.drain,'token','e'*32),(self.drain,'stop_sha256','bad'),
          (self.provision,'namespace_admitted',True),(self.ready,'state','released'),
          (self.ready['observation']['authentication']['released'],'active_count',1)]
        for obj,key,value in mutations:
            original=obj[key];obj[key]=value
            try:
                with self.subTest(key=key,value=value),self.patches(),self.assertRaises(ValueError):
                    stage.load_context(self.path,'f'*64)
            finally:obj[key]=original
        with self.patches(),mock.patch.object(stage.qualification,'probe_host',return_value={'boot_id':'different'}),self.assertRaisesRegex(ValueError,'boot'):
            stage.load_context(self.path,'f'*64)

    def test_missing_or_aliased_copy_fence_is_refused(self):
        locks=self.ready['observation']['locks']
        for changed in (locks[:-1],locks[::-1],locks[:4]+[dict(locks[4],inode=locks[3]['inode'])]):
            self.ready['observation']['locks']=changed
            with self.patches(),self.assertRaisesRegex(ValueError,'five distinct'):
                stage.load_context(self.path,'f'*64)
        self.ready['observation']['locks']=locks

    def test_wrong_journal_mount_or_drain_receipt_is_refused(self):
        for index in (5,7):
            old=self.journal['events'][index]['receipt_sha256'];self.journal['events'][index]['receipt_sha256']='0'*64
            try:
                with self.patches(),self.assertRaises(ValueError):stage.load_context(self.path,'f'*64)
            finally:self.journal['events'][index]['receipt_sha256']=old

    def test_mounted_root_rejects_uuid_options_or_source_device_before_archive(self):
        row={'target':self.linux['mount_root'],'fstype':'ext4','uuid':self.linux['filesystem_uuid'],'maj:min':'8:9','options':'rw,nodev,nosuid'}
        for key,value in [('uuid','other'),('options','rw'),('target','/mnt/other'),('fstype','ntfs')]:
            actual=dict(row);actual[key]=value
            with mock.patch.object(stage.qualification,'_capture',return_value=SimpleNamespace(stdout=json.dumps({'filesystems':[actual]}).encode())), \
                    mock.patch.object(stage,'_open_directory_nofollow') as opened,self.assertRaises(ValueError):
                stage._mounted_root(self.linux,self.provision)
            opened.assert_not_called()

    def test_mounted_root_resolves_only_null_uuid_and_still_checks_the_expected_filesystem(self):
        target=Path(self.linux['mount_root'])
        marker={'schema':'fullmag.user-data-volume-identity.v1','volume_id':self.linux['volume_id'],
            'filesystem_uuid':self.linux['filesystem_uuid'],'created_receipt_sha256':self.linux['created_receipt_sha256'],
            'attached_receipt_sha256':self.linux['attached_receipt_sha256'],
            'controller_sha256':self.linux['controller_sha256'],'data_migrated':False}
        metadata=SimpleNamespace(st_uid=0,st_mode=stat.S_IFDIR|0o755,st_dev=200,st_ino=2)

        def observe(row, resolver_result):
            with tempfile.TemporaryDirectory() as directory:
                payload={'filesystems':[row]}
                capture=SimpleNamespace(stdout=json.dumps(payload).encode())
                with mock.patch.object(stage.qualification,'_capture',return_value=capture), \
                        mock.patch.object(stage.qualification,'_read',return_value=(b'',marker)), \
                        mock.patch.object(stage,'_open_directory_nofollow',
                            side_effect=lambda _path:os.open(directory,os.O_RDONLY|os.O_DIRECTORY)), \
                        mock.patch.object(stage.os,'fstat',return_value=metadata), \
                        mock.patch.object(stage,'resolve_mount_uuid',return_value=resolver_result,
                                          create=True) as resolve:
                    result=stage._mounted_root(self.linux,self.provision)
                return result,resolve

        null_row={'target':str(target),'fstype':'ext4','uuid':None,'maj:min':'8:9','options':'rw,nodev,nosuid'}
        result,resolve=observe(null_row,self.linux['filesystem_uuid'])
        self.assertEqual(result,target)
        resolve.assert_called_once_with(target,None,major_minor='8:9')
        self.assertIsNone(null_row['uuid'])

        reported=dict(null_row,uuid=self.linux['filesystem_uuid'])
        with tempfile.TemporaryDirectory() as directory:
            capture=SimpleNamespace(stdout=json.dumps({'filesystems':[reported]}).encode())
            with mock.patch.object(stage.qualification,'_capture',return_value=capture), \
                    mock.patch.object(stage.qualification,'_read',return_value=(b'',marker)), \
                    mock.patch.object(stage,'_open_directory_nofollow',
                        side_effect=lambda _path:os.open(directory,os.O_RDONLY|os.O_DIRECTORY)), \
                    mock.patch.object(stage.os,'fstat',return_value=metadata), \
                    mock.patch.object(stage,'resolve_mount_uuid',create=True) as resolve:
                self.assertEqual(stage._mounted_root(self.linux,self.provision),target)
            resolve.assert_not_called()

        wrong=dict(null_row)
        with mock.patch.object(stage.qualification,'_capture',return_value=
                SimpleNamespace(stdout=json.dumps({'filesystems':[wrong]}).encode())), \
                mock.patch.object(stage,'resolve_mount_uuid',return_value='22222222-2222-4222-8222-222222222222',
                                  create=True), \
                mock.patch.object(stage,'_open_directory_nofollow') as opened, \
                self.assertRaises(ValueError):
            stage._mounted_root(self.linux,self.provision)
        opened.assert_not_called()

        with mock.patch.object(stage.qualification,'_capture',return_value=
                SimpleNamespace(stdout=json.dumps({'filesystems':[null_row]}).encode())), \
                mock.patch.object(stage,'resolve_mount_uuid',side_effect=ValueError('unsupported UUID ioctl'),
                                  create=True), \
                mock.patch.object(stage,'_open_directory_nofollow') as opened, \
                self.assertRaisesRegex(ValueError,'unsupported UUID ioctl'):
            stage._mounted_root(self.linux,self.provision)
        opened.assert_not_called()

        invalid_rows=(
            {key:value for key,value in null_row.items() if key != 'uuid'},
            dict(null_row,UUID=None),
            dict(null_row,uuid=False),
        )
        for row in invalid_rows:
            with self.subTest(row=row),mock.patch.object(stage.qualification,'_capture',return_value=
                    SimpleNamespace(stdout=json.dumps({'filesystems':[row]}).encode())), \
                    mock.patch.object(stage,'resolve_mount_uuid',create=True) as resolve, \
                    mock.patch.object(stage,'_open_directory_nofollow') as opened,self.assertRaises(ValueError):
                stage._mounted_root(self.linux,self.provision)
            resolve.assert_not_called();opened.assert_not_called()

    def test_original_source_inode_replacement_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);metadata=root.stat()
            linux={'source_roots':{'state':{'canonical_root':str(root),'device':metadata.st_dev,'inode':metadata.st_ino+1}}}
            with self.assertRaisesRegex(ValueError,'Original copy dataset identity'):
                stage._source_roots(linux)


class CopyArchiveLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.base=Path(self.temp.name);self.source=self.base/'source';self.target=self.base/'new-volume';self.op=self.base/'operation'
        for p in (self.source,self.target,self.op):p.mkdir()
        roots={role:self.source/role for role in ('user_data','state')}
        for p in roots.values():p.mkdir()
        (roots['user_data']/'m.zarr').write_bytes(b'complete saved field');(roots['state']/'owner').write_bytes(b'original owner')
        self.request={'schema':stage.SCHEMA,'volume_id':'1'*32,'token':'2'*32,'storage_root':str(self.source)}
        self.journal=journal_to_copy('1'*32,'a'*64,'b'*64,'c'*64)
        (self.op/'journal.json').write_text(json.dumps(self.journal))
        self.context={'request':self.request,'linux':{'source_roots':{},'filesystem_uuid':'11111111-1111-4111-8111-111111111111'},'operation_root':self.op,
          'journal_path':self.op/'journal.json','journal':self.journal,'roots':roots,'target':self.target,'provision':{}}

    def patches(self):
        # Namespace/root identity authentication has separate negative tests.
        # Here all tar/hash/manifest/journal/retention I/O is real small-file I/O.
        stack=ExitStack()
        stack.enter_context(mock.patch.object(stage,'load_context',return_value=self.context))
        stack.enter_context(mock.patch.object(stage,'_source_roots',return_value=self.context['roots']))
        stack.enter_context(mock.patch.object(stage,'_mounted_root',return_value=self.target))
        stack.enter_context(mock.patch.object(stage,'_new_directory',side_effect=lambda p,n:(p/n).mkdir(mode=0o700)))
        stack.enter_context(mock.patch('scripts.fullmag_data_volume_fs.os.fstatvfs',return_value=SimpleNamespace(f_bavail=128*1024**3,f_frsize=1)))
        return stack

    def test_real_archive_manifest_and_terminal_receipt_preserve_all_originals(self):
        with self.patches():result=stage.copy_verified(self.op/'linux-copy-request.json','d'*64)
        self.assertEqual(result['state'],'copied-and-verified-not-switched')
        self.assertFalse(result['namespace_admitted']);self.assertFalse(result['originals_retired'])
        self.assertEqual((self.source/'user_data/m.zarr').read_bytes(),b'complete saved field')
        self.assertEqual((self.target/'payload/user_data/m.zarr').read_bytes(),b'complete saved field')
        self.assertEqual((self.source/'state/owner').read_bytes(),b'original owner')
        self.assertEqual((self.target/'payload/state/owner').read_bytes(),b'original owner')
        self.assertEqual(digest(Path(result['manifest_path']).read_bytes()),result['manifest_sha256'])
        self.assertEqual(digest(Path(result['archive_path']).read_bytes()),result['archive_sha256'])
        journal=json.loads((self.op/'journal.json').read_text())
        self.assertEqual(journal['events'][-1]['state'],'succeeded')
        self.assertEqual(journal['events'][-1]['receipt_sha256'],digest((self.op/'linux-copy-result.json').read_bytes()))

    def failed_archive(self,*args):
        Path(args[2]).write_bytes(b'partial archive evidence')
        raise RuntimeError('copy failure')

    def test_copy_failure_retains_source_partial_archive_and_failure_receipt(self):
        with self.patches(),mock.patch.object(stage,'archive_and_extract',side_effect=self.failed_archive):
            with self.assertRaisesRegex(RuntimeError,'copy failure'):stage.copy_verified(self.op/'linux-copy-request.json','d'*64)
        self.assertEqual((self.target/'migration'/('1'*32)/'originals.pax').read_bytes(),b'partial archive evidence')
        self.assertEqual((self.source/'user_data/m.zarr').read_bytes(),b'complete saved field')
        failure=json.loads((self.op/'linux-copy-failed.json').read_text())
        self.assertEqual(failure['state'],'failed-confirmed')
        with self.patches(),mock.patch.object(stage,'archive_and_extract') as archive,self.assertRaisesRegex(ValueError,'never replay'):
            stage.copy_verified(self.op/'linux-copy-request.json','d'*64)
        archive.assert_not_called()

    def test_interruption_retains_unknown_outcome_and_never_claims_copy_success(self):
        with self.patches(),mock.patch.object(stage,'archive_and_extract',side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):stage.copy_verified(self.op/'linux-copy-request.json','d'*64)
        self.assertFalse((self.op/'linux-copy-result.json').exists())
        failure=json.loads((self.op/'linux-copy-failed.json').read_text())
        self.assertEqual(failure['state'],'outcome-unknown-resources-retained')
        self.assertEqual(json.loads((self.op/'journal.json').read_text())['events'][-1]['state'],failure['state'])

    def test_late_journal_failure_retains_success_bytes_but_marks_outcome_unknown(self):
        original=stage._publish_journal;calls=0
        def publish(*args):
            nonlocal calls
            calls+=1
            if calls==2:raise OSError('journal publication failed')
            return original(*args)
        with self.patches(),mock.patch.object(stage,'_publish_journal',side_effect=publish):
            with self.assertRaisesRegex(OSError,'journal publication'):stage.copy_verified(self.op/'linux-copy-request.json','d'*64)
        self.assertTrue((self.op/'linux-copy-result.json').exists())
        self.assertEqual(json.loads((self.op/'linux-copy-failed.json').read_text())['state'],'outcome-unknown-resources-retained')
        self.assertEqual(json.loads((self.op/'journal.json').read_text())['events'][-1]['state'],'outcome-unknown-resources-retained')

    def test_existing_payload_is_never_adopted_or_overwritten(self):
        (self.target/'payload').mkdir();(self.target/'payload/keep').write_bytes(b'foreign')
        with self.patches(),mock.patch.object(stage,'archive_and_extract') as archive,self.assertRaisesRegex(ValueError,'never replay'):
            stage.copy_verified(self.op/'linux-copy-request.json','d'*64)
        archive.assert_not_called();self.assertEqual((self.target/'payload/keep').read_bytes(),b'foreign')
        self.assertEqual(json.loads((self.op/'journal.json').read_text()),self.journal)


if __name__=='__main__':unittest.main()
