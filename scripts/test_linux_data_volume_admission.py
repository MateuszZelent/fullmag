"""Root admission lineage and lifecycle; no real Docker, WSL or mounts."""
from contextlib import ExitStack
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

from scripts import linux_data_volume_bind as bind_stage
from scripts import test_linux_data_volume_copy as copy_fixtures
from scripts import fullmag_data_volume_journal as journal_module
from scripts import fullmag_data_volume_manifest as manifest_module
from scripts import test_fullmag_data_volume_admission as primitive_fixtures


NATIVE_COMPONENTS=('linux_native_data_volume_migration.py','linux_native_host.py','docker_dev_host.py',
                   'fullmag_storage.py','fullmag_data_volume_admission.py','linux_data_volume_admission.py')


def valid_request():
    return {'schema':'fullmag.data-volume-linux-admission-request.v1','volume_id':'1'*32,
        'storage_root':'/srv/fullmag/storage','token':'5'*32,'bind_request_sha256':'a'*64,
        'bind_receipt_sha256':'b'*64,'fence_ready_sha256':'c'*64,
        'components':{name:'d'*64 for name in (*bind_stage.COMPONENTS,*NATIVE_COMPONENTS)}}


class AdmissionRequestTests(unittest.TestCase):
    def test_isolated_import_keeps_root_source_graph_closed_without_docker_host_jobs(self):
        source=Path(__file__).resolve().parent
        code=('import sys,pathlib\n'
              'sys.path.insert(0,sys.argv[1])\n'
              'import linux_data_volume_admission as stage\n'
              'root=pathlib.Path(sys.argv[1])\n'
              'loaded={pathlib.Path(m.__file__).name for m in list(sys.modules.values()) '
              'if getattr(m,"__file__",None) and pathlib.Path(m.__file__).parent==root}\n'
              'assert loaded <= set(stage.COMPONENTS),(loaded-set(stage.COMPONENTS))\n'
              'assert len(stage.COMPONENTS)==len(set(stage.COMPONENTS))==19\n'
              'assert "docker_data_volume_bind_job" not in sys.modules\n')
        with tempfile.TemporaryDirectory() as outside:
            result=subprocess.run([sys.executable,'-I','-B','-c',code,str(source)],cwd=outside,
                                  capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr)

    def test_closed_request_does_not_include_admission_authority(self):
        from scripts import linux_data_volume_admission as stage
        request=valid_request();self.assertEqual(stage.validate_request(request),request)
        for mutate in (lambda r:r.update(namespace_admitted=True),lambda r:r.pop('bind_receipt_sha256'),
                       lambda r:r['components'].pop('linux_native_host.py'),lambda r:r.update(token='0'*32),
                       lambda r:r.update(bind_request_sha256=True),lambda r:r.update(storage_root='/tmp/storage')):
            value=copy.deepcopy(request);mutate(value)
            with self.assertRaises(ValueError):stage.validate_request(value)

    def test_nonroot_cannot_read_migration_inputs(self):
        from scripts import linux_data_volume_admission as stage
        with mock.patch.object(stage.os,'geteuid',return_value=1000), \
                mock.patch.object(stage.qualification,'_read') as read,self.assertRaisesRegex(ValueError,'root'):
            stage.load_context(Path('/srv/fullmag/storage/request.json'),'a'*64)
        read.assert_not_called()

    def test_wrong_request_sha_refuses_before_any_read(self):
        from scripts import linux_data_volume_admission as stage
        with mock.patch.object(stage.os,'geteuid',return_value=0), \
                mock.patch.object(stage.qualification,'_read') as read,self.assertRaises(ValueError):
            stage.load_context(Path('/srv/fullmag/storage/request.json'),True)
        read.assert_not_called()


class AdmissionLoadScenario:
    def __init__(self,test):
        from scripts import linux_data_volume_admission as stage
        self.stage=stage;self.copy=copy_fixtures.CopyContextTests();self.copy.setUp()
        self.op=self.copy.op;self.linux=self.copy.linux;self.source=Path(stage.__file__).resolve().parents[1]
        self.linux['source_roots']['state']['canonical_root']='/srv/fullmag/storage/runtimes/worktree-fixture/docker-volume-dev/state'
        self.linux['source_roots']['user_data']['canonical_root']='/srv/fullmag/storage/user-data/compose-fixture'
        self.docs={};self.image='sha256:'+'5'*64
        self.plan=self.copy.plan
        self.plan.update(schema='fullmag.data-volume-plan.v1',source_root=str(self.source),project_id='project-fixture',
            worktree_id='worktree-fixture',compose_project='compose-fixture',runtime_root='/srv/fullmag/storage/runtimes/worktree-fixture')
        self.plan['runtime_pins']['image_id']=self.image;self.plan['observation']['engine_id']='engine-fixture'
        self.plan_sha=self.put(self.op/'plan.json',self.plan)
        self.copy.drain['plan_sha256']=self.plan_sha
        self.copy_request=self.copy.request;self.copy_request['drain_sha256']=self.put(self.op/'group-drained.json',self.copy.drain)
        self.copy_request['linux_request_sha256']=self.put(self.op/'linux-provision-request.json',self.linux)
        self.copy.provision['linux_request_sha256']=self.copy_request['linux_request_sha256']
        self.copy_request['provision_result_sha256']=self.put(self.op/'linux-provision-result.json',self.copy.provision)
        self.copy_request_sha=self.put(self.op/'linux-copy-request.json',self.copy_request)
        temporary=tempfile.TemporaryDirectory();test.addCleanup(temporary.cleanup)
        roots={role:Path(temporary.name)/role for role in ('state','user_data')}
        self.original_fixture_roots=roots
        for root in roots.values():root.mkdir()
        cert={'engine_id':'engine-fixture','image_id':self.image,'owner_token':'6'*32,
              'source_commit':'7'*40,'binary_hashes':{'fullmag':'8'*64},'artifact_receipt_sha256':'9'*64}
        self.certificate_raw=json.dumps(cert,sort_keys=True).encode()
        for name in stage.admission.migration.host.READMISSION_FILES:
            (roots['state']/name).write_bytes(self.certificate_raw if name == 'linux-native-host.json' else b'historical')
        store=roots['state']/'runs/docker-all/session-store';store.mkdir(parents=True);(store/'WRITER.lock').touch()
        self.manifest=manifest_module.inventory_datasets(roots)
        self.manifest['roots']={role:{'path':p['canonical_root'],'device':p['device'],'inode':p['inode']}
                                for role,p in self.linux['source_roots'].items()}
        mount=Path(self.linux['mount_root']);archive=mount/'migration'/self.copy_request['volume_id']
        manifest_sha=self.put(archive/'source-manifest.json',self.manifest)
        self.copy_result={'schema':'fullmag.data-volume-linux-copy-result.v1','state':'copied-and-verified-not-switched',
            'volume_id':self.linux['volume_id'],'token':self.copy_request['token'],'request_sha256':self.copy_request_sha,
            'filesystem_uuid':self.linux['filesystem_uuid'],'data_sha256':self.manifest['data_sha256'],
            'manifest_path':str(archive/'source-manifest.json'),'manifest_sha256':manifest_sha,
            'archive_path':str(archive/'originals.pax'),'archive_sha256':'a'*64,
            'copied_roots':{r:str(mount/'payload'/Path(p['canonical_root']).relative_to(self.linux['storage_root']))
                            for r,p in self.linux['source_roots'].items()},'namespace_admitted':False,'originals_retired':False}
        self.copy_sha=self.put(self.op/'linux-copy-result.json',self.copy_result)
        self.bind_request={'schema':bind_stage.SCHEMA,'volume_id':self.linux['volume_id'],'storage_root':self.linux['storage_root'],
            'token':'4'*32,'copy_request_sha256':self.copy_request_sha,'copy_receipt_sha256':self.copy_sha,
            'fence_ready_sha256':'b'*64,'components':{n:hashlib.sha256((self.source/'scripts'/n).read_bytes()).hexdigest() for n in bind_stage.COMPONENTS}}
        self.bind_request_sha=self.put(self.op/'linux-bind-request.json',self.bind_request)
        self.layout={'repo_root':str(self.source),'storage_root':self.linux['storage_root'],'runtime_root':self.plan['runtime_root'],
                     'worktree_id':self.plan['worktree_id'],'env':{'FULLMAG_PROJECT_ID':self.plan['project_id']}}
        marker={'schema':bind_stage.pending.SCHEMA,**{k:self.plan[k] for k in ('project_id','worktree_id','compose_project','source_root')},
            'volume_id':self.linux['volume_id'],'plan_sha256':self.plan_sha,
            'linux_request_sha256':self.copy_request['linux_request_sha256'],'copy_receipt_sha256':self.copy_sha,
            'state_root':self.linux['source_roots']['state']['canonical_root'],'user_data_root':self.linux['source_roots']['user_data']['canonical_root']}
        marker_path=bind_stage.pending.pending_path(self.layout);marker_sha=self.put(marker_path,marker)
        rows={}
        for offset,(role,original) in enumerate(self.linux['source_roots'].items()):
            canonical=Path(original['canonical_root'])
            rows[role]={'role':role,'canonical_root':str(canonical),
                'backup_root':str(canonical.with_name('.'+canonical.name+'.fullmag-before-'+self.linux['volume_id'])),
                'copied_root':self.copy_result['copied_roots'][role],
                'original_identity':{k:original[k] for k in ('device','inode')},
                'underlay_identity':{'device':100,'inode':30+offset},'bound_identity':{'device':200,'inode':40+offset},
                'mount':{'target':str(canonical),'fstype':'ext4','uuid':self.linux['filesystem_uuid'],
                         'options':'rw,nodev,nosuid','propagation':'private'}}
        self.bind_result={'schema':'fullmag.data-volume-linux-bind-result.v1','state':'binds-switched-not-admitted',
            'volume_id':self.linux['volume_id'],'token':self.bind_request['token'],'request_sha256':self.bind_request_sha,
            'copy_receipt_sha256':self.copy_sha,'pending_marker':{'path':str(marker_path),'sha256':marker_sha},
            'switch':{'schema':'fullmag.data-volume-bind-result.v1','state':'binds-switched-not-admitted',
                'volume_id':self.linux['volume_id'],'filesystem_uuid':self.linux['filesystem_uuid'],
                'data_sha256':self.manifest['data_sha256'],'roots':rows,'namespace_admitted':False,'originals_retired':False},
            'namespace_admitted':False,'originals_retired':False}
        self.bind_sha=self.put(self.op/'linux-bind-result.json',self.bind_result)
        ready=copy.deepcopy(self.copy.ready);ready['token']='5'*32
        self.request=valid_request();self.request.update(bind_request_sha256=self.bind_request_sha,bind_receipt_sha256=self.bind_sha,
            fence_ready_sha256=self.put(self.op/'admission-fence-ready.json',ready),
            components={n:hashlib.sha256((self.source/'scripts'/n).read_bytes()).hexdigest() for n in stage.COMPONENTS})
        self.path=self.op/'linux-admission-request.json';self.request_sha=self.put(self.path,self.request)
        journal=journal_module.new_journal(self.linux['volume_id'],self.plan_sha)
        terminals=[('image-created','a'*64,'b'*64),('image-attached','c'*64,'d'*64),
            ('ext4-mounted','e'*64,self.copy_request['provision_result_sha256']),
            ('group-drained','f'*64,self.copy_request['drain_sha256']),
            ('copy-verified',self.copy_request_sha,self.copy_sha),('binds-switched',self.bind_request_sha,self.bind_sha)]
        for phase,inputs,receipt in terminals:
            journal=journal_module.append_terminal(journal_module.append_started(journal,phase,inputs),'succeeded',receipt)
        self.journal=journal

    def put(self,path,value):
        raw=(json.dumps(value,sort_keys=True)+'\n').encode();self.docs[Path(path)]=raw
        return hashlib.sha256(raw).hexdigest()

    def read(self,path,expected=None):
        raw=self.docs[Path(path)]
        if expected is not None and hashlib.sha256(raw).hexdigest() != expected:raise ValueError('fixture evidence SHA changed')
        return raw,json.loads(raw)

    def optional(self,path,*args,**kwargs):
        path=Path(path)
        if path in self.docs:return self.docs[path]
        return path.read_bytes() if path.is_file() else None

    def patches(self):
        stage=self.stage;stack=ExitStack()
        stack.enter_context(mock.patch.object(stage.os,'geteuid',return_value=0))
        stack.enter_context(mock.patch.object(stage.qualification,'_read',side_effect=self.read))
        stack.enter_context(mock.patch.object(stage,'_read_optional_regular',side_effect=self.optional))
        stack.enter_context(mock.patch.object(stage.qualification,'probe_host',return_value={'boot_id':self.linux['boot_id']}))
        stack.enter_context(mock.patch.object(stage.qualification,'_selected_journal',side_effect=lambda _op:(self.op/'journal.json',copy.deepcopy(self.journal))))
        stack.enter_context(mock.patch.object(stage,'load_plan',side_effect=lambda *_:(self.docs[self.op/'plan.json'],copy.deepcopy(self.plan),None)))
        self.roots=stack.enter_context(mock.patch.object(stage,'_verify_roots',return_value=({},{})))
        stack.enter_context(mock.patch.object(stage.bind_stage,'_require_pending',side_effect=lambda ctx,ref:
            stage.require(hashlib.sha256(self.docs[Path(ref['path'])]).hexdigest() == ref['sha256'],'fixture pending changed')))
        return stack

    def call(self):return self.stage.load_context(self.path,self.request_sha)


class AdmissionContextTests(unittest.TestCase):
    def setUp(self):self.case=AdmissionLoadScenario(self)

    def test_mount_resolves_null_uuid_and_preserves_reported_uuid_route(self):
        stage=self.case.stage;path=Path(self.case.linux['mount_root'])
        row={'target':str(path),'fsroot':'/','fstype':'ext4','uuid':None,'maj:min':'8:9',
             'options':'rw,nodev,nosuid','propagation':'private'}
        capture=SimpleNamespace(stdout=json.dumps({'filesystems':[row]}).encode())
        with mock.patch.object(stage.qualification,'_capture',return_value=capture), \
                mock.patch.object(stage,'resolve_mount_uuid',return_value=self.case.linux['filesystem_uuid'],
                                  create=True) as resolve:
            observed=stage._mount(path)
        self.assertEqual(observed['uuid'],self.case.linux['filesystem_uuid'])
        resolve.assert_called_once_with(path,None,major_minor='8:9')
        self.assertIsNone(row['uuid'])

        reported=dict(row,uuid=self.case.linux['filesystem_uuid'])
        with mock.patch.object(stage.qualification,'_capture',return_value=
                SimpleNamespace(stdout=json.dumps({'filesystems':[reported]}).encode())), \
                mock.patch.object(stage,'resolve_mount_uuid',create=True) as resolve:
            self.assertEqual(stage._mount(path)['uuid'],self.case.linux['filesystem_uuid'])
        resolve.assert_not_called()

    def test_verify_roots_refuses_mismatched_or_unsupported_null_uuid_resolution(self):
        case=self.case
        with case.patches():context=case.call()
        stage=case.stage;path=Path(context['linux']['mount_root'])
        row={'target':str(path),'fsroot':'/','fstype':'ext4','uuid':None,'maj:min':'8:9',
             'options':'rw,nodev,nosuid','propagation':'private'}
        capture=SimpleNamespace(stdout=json.dumps({'filesystems':[row]}).encode())
        for resolver,pattern in ((mock.Mock(return_value='22222222-2222-4222-8222-222222222222'),'mount identity'),
                                 (mock.Mock(side_effect=ValueError('unsupported UUID ioctl')),'unsupported UUID ioctl')):
            with self.subTest(pattern=pattern), \
                    mock.patch.object(stage.bind_stage.copy_stage,'_mounted_root'), \
                    mock.patch.object(stage.qualification,'_capture',return_value=capture), \
                    mock.patch.object(stage,'resolve_mount_uuid',resolver,create=True), \
                    self.assertRaisesRegex(ValueError,pattern):
                stage._verify_roots(context)
            resolver.assert_called_once_with(path,None,major_minor='8:9')

    def test_mount_rejects_missing_ambiguous_and_invalid_uuid_fields(self):
        stage=self.case.stage;path=Path(self.case.linux['mount_root'])
        rows=(
            {'target':str(path),'fsroot':'/','fstype':'ext4','maj:min':'8:9'},
            {'target':str(path),'fsroot':'/','fstype':'ext4','uuid':None,'UUID':None,'maj:min':'8:9'},
            {'target':str(path),'fsroot':'/','fstype':'ext4','uuid':False,'maj:min':'8:9'},
        )
        for row in rows:
            with self.subTest(row=row),mock.patch.object(stage.qualification,'_capture',return_value=
                    SimpleNamespace(stdout=json.dumps({'filesystems':[row]}).encode())), \
                    mock.patch.object(stage,'resolve_mount_uuid',create=True) as resolve,self.assertRaises(ValueError):
                stage._mount(path)
            resolve.assert_not_called()

    def test_valid_complete_lineage_yields_original_and_copied_views_without_old_canonical_probe(self):
        with self.case.patches(),mock.patch.object(self.case.stage.bind_stage.copy_stage,'_source_roots') as originals:
            context=self.case.call()
        originals.assert_not_called();self.case.roots.assert_called_once()
        self.assertEqual(context['copy_result']['data_sha256'],context['source_manifest']['data_sha256'])
        self.assertEqual(context['writer_entry']['path'],'runs/docker-all/session-store/WRITER.lock')

    def test_corrupted_predecessor_request_bytes_fail_before_mount_observation(self):
        self.case.docs[self.case.op/'linux-copy-request.json']+=b' '
        with self.case.patches(),self.assertRaisesRegex(ValueError,'SHA'):self.case.call()
        self.case.roots.assert_not_called()

    def test_changed_boot_or_original_plan_scope_refuses(self):
        with self.case.patches(),mock.patch.object(self.case.stage.qualification,'probe_host',return_value={'boot_id':'other'}),self.assertRaisesRegex(ValueError,'boot'):
            self.case.call()
        self.case.plan['volume_id']='9'*32
        with self.case.patches(),self.assertRaisesRegex(ValueError,'plan/Linux'):self.case.call()

    def test_journal_wrong_volume_plan_or_terminal_receipt_refuses(self):
        for change in ('volume','plan','terminal'):
            original=copy.deepcopy(self.case.journal)
            if change == 'volume':self.case.journal['volume_id']='8'*32
            elif change == 'plan':self.case.journal['request_sha256']='9'*64
            else:self.case.journal['events'][-1]['receipt_sha256']='7'*64
            try:
                with self.case.patches(),self.assertRaisesRegex(ValueError,'journal'):self.case.call()
            finally:self.case.journal=original

    def test_changed_manifest_or_pending_refuses(self):
        for path in (Path(self.case.copy_result['manifest_path']),Path(self.case.bind_result['pending_marker']['path'])):
            original=self.case.docs[path];self.case.docs[path]+=b' '
            try:
                with self.case.patches(),self.assertRaises(ValueError):self.case.call()
            finally:self.case.docs[path]=original

    def test_preparation_pins_come_from_manifest_native_predecessor_and_bound_inode(self):
        with self.case.patches():context=self.case.call()
        with mock.patch.object(self.case.stage.admission.migration.host,'read_owned_regular',return_value=self.case.certificate_raw):
            request=self.case.stage._preparation_request(context)
        pins=request['pins']
        self.assertEqual(pins['source_device'],100);self.assertEqual(pins['observed_device'],200)
        self.assertEqual(pins['source_data_sha256'],pins['copied_data_sha256'])
        self.assertEqual(set(pins['files']),set(self.case.stage.admission.migration.host.READMISSION_FILES))

    def test_existing_stage_artifact_or_archive_refuses_replay(self):
        with self.case.patches(),mock.patch.object(self.case.stage.os.path,'lexists',return_value=True), \
                self.assertRaisesRegex(ValueError,'previous artifacts'):self.case.call()

    def test_current_old_new_inode_and_exact_payload_mount_are_reobserved(self):
        with self.case.patches():context=self.case.call()
        stage=self.case.stage;mount=Path(context['linux']['mount_root']);rows=context['bind_result']['switch']['roots']
        base={'target':str(mount),'fsroot':'/','fstype':'ext4','uuid':context['linux']['filesystem_uuid'],
              'maj:min':'8:9','options':'rw,nodev,nosuid','propagation':'private'}
        mounts={mount:base};identities={}
        for row in rows.values():
            mounts[Path(row['canonical_root'])]=dict(base,target=row['canonical_root'],
                fsroot='/'+str(Path(row['copied_root']).relative_to(mount)))
            identities[Path(row['backup_root'])]=row['original_identity']
            identities[Path(row['canonical_root'])]=row['bound_identity']
        with mock.patch.object(stage.bind_stage.copy_stage,'_mounted_root'), \
                mock.patch.object(stage,'_mount',side_effect=lambda path:mounts[path]), \
                mock.patch.object(stage,'_observe_directory',side_effect=lambda path:identities[path]):
            old,new=stage._verify_roots(context)
            self.assertEqual(old['state'],Path(rows['state']['backup_root']))
            self.assertEqual(new['state'],Path(rows['state']['canonical_root']))
            row=mounts[new['state']]
            for key,value in [('fsroot','/wrong'),('uuid','wrong'),('maj:min','8:10'),('propagation','shared'),('options','rw')]:
                original=row[key];row[key]=value
                try:
                    with self.subTest(key=key),self.assertRaises(ValueError):stage._verify_roots(context)
                finally:row[key]=original
            identities[old['state']]=dict(identities[old['state']],inode=999)
            with self.assertRaisesRegex(ValueError,'identity'):stage._verify_roots(context)

    def test_both_real_manifests_match_before_preparation_and_new_data_drift_refuses(self):
        with self.case.patches():context=self.case.call()
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
        old=self.case.original_fixture_roots;new={r:Path(temporary.name)/r for r in old}
        for role in old:shutil.copytree(old[role],new[role])
        stage=self.case.stage
        with mock.patch.object(stage,'_verify_roots',return_value=(old,new)), \
                mock.patch.object(stage.bind_stage,'_require_pending'):
            stage._verify_base_data(context)
            (new['state']/'linux-native-host.json').write_bytes(b'different data')
            with self.assertRaisesRegex(ValueError,'dataset entries differ'):stage._verify_base_data(context)


class AdmissionLifecycleTests(unittest.TestCase):
    def setUp(self):
        from scripts import linux_data_volume_admission as stage
        self.stage=stage;self.fixture=primitive_fixtures.AdmissionPreparationTests()
        self.fixture.setUp();self.addCleanup(self.fixture.doCleanups)
        self.op=self.fixture.state.parent/'operation';self.op.mkdir()
        self.pending_path=self.op/'pending.json';self.pending_path.write_text('{"blocked": true}')
        self.marker={'path':str(self.pending_path),'sha256':hashlib.sha256(self.pending_path.read_bytes()).hexdigest()}
        self.request=valid_request();self.request['storage_root']=str(self.fixture.state.parent)
        self.journal=journal_module.new_journal(self.request['volume_id'],'a'*64)
        for phase in journal_module.PHASES[:6]:
            self.journal=journal_module.append_terminal(journal_module.append_started(self.journal,phase,'b'*64),'succeeded','c'*64)
        self.journal_path=self.op/'journal.json'
        self.journal_path.write_text(json.dumps(self.journal))
        self.context={'request':self.request,'operation_root':self.op,'linux':{'source_roots':{
            'state':{'canonical_root':str(self.fixture.state)}}},'writer_entry':self.fixture.entry,
            'source_manifest':{'data_sha256':'2'*64},'bind_request':{'copy_receipt_sha256':'d'*64},
            'bind_result':{'pending_marker':self.marker},'journal_path':self.journal_path,'journal':self.journal}
        self.stack=ExitStack();self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch.object(stage,'load_context',side_effect=lambda *_:copy.deepcopy(self.context)))
        self.stack.enter_context(mock.patch.object(stage.bind_stage,'_verify_archive'))
        self.verify_base=self.stack.enter_context(mock.patch.object(stage,'_verify_base_data',side_effect=lambda *_:self.fixture.locked()))
        self.stack.enter_context(mock.patch.object(stage,'_preparation_request',return_value=self.fixture.request))
        self.stack.enter_context(mock.patch.object(stage,'_verify_roots',return_value=({'state':self.fixture.state},{})))
        self.stack.enter_context(mock.patch.object(stage,'inventory_datasets',side_effect=lambda *_:self.fixture.locked()))
        self.stack.enter_context(mock.patch.object(stage,'require_matching_data'))
        def pending(_context,marker):
            stage.require(hashlib.sha256(self.pending_path.read_bytes()).hexdigest() == marker['sha256'],'pending changed')
        self.stack.enter_context(mock.patch.object(stage.bind_stage,'_require_pending',side_effect=pending))

    def call(self):return self.stage.admission_verified(self.op/'linux-admission-request.json','e'*64)

    def test_writer_remains_held_through_actual_prepare_result_and_journal_publication(self):
        publish=self.stage._publish_journal
        def checked(*args):
            self.fixture.locked();return publish(*args)
        with mock.patch.object(self.stage,'_publish_journal',side_effect=checked):result=self.call()
        self.verify_base.assert_called_once()
        self.assertFalse(result['namespace_admitted']);self.assertFalse(result['data_migrated']);self.assertFalse(result['originals_retired'])
        self.assertEqual(json.loads(self.journal_path.read_bytes())['events'][-1]['state'],'succeeded')
        self.assertTrue(self.fixture.archive.exists());self.assertEqual(self.pending_path.read_text(),'{"blocked": true}')

    def test_application_error_after_started_retains_archive_pending_and_unknown_journal(self):
        def fail(*args,**kwargs):
            self.fixture.archive.write_bytes(b'retained partial archive');raise RuntimeError('root preparation interrupted')
        with mock.patch.object(self.stage.admission,'prepare_guarded',side_effect=fail),self.assertRaisesRegex(RuntimeError,'interrupted'):
            self.call()
        self.assertEqual(self.fixture.archive.read_bytes(),b'retained partial archive')
        self.assertTrue(self.pending_path.is_file())
        self.assertEqual(json.loads(self.journal_path.read_bytes())['events'][-1]['state'],'outcome-unknown-resources-retained')
        self.assertFalse((self.op/'linux-admission-result.json').exists())

    def test_data_verification_failure_cannot_begin_certificate_preparation(self):
        self.verify_base.side_effect=ValueError('copied data differ')
        with mock.patch.object(self.stage.admission,'prepare_guarded') as prepare,self.assertRaisesRegex(ValueError,'data differ'):
            self.call()
        prepare.assert_not_called();self.assertFalse(self.fixture.archive.exists())
        self.assertEqual(self.fixture.case.fixture.certificate_path.read_bytes(),self.fixture.original['linux-native-host.json'])
        self.assertEqual(json.loads(self.journal_path.read_bytes())['events'][-1]['phase'],'binds-switched')

    def test_pending_change_after_apply_preserves_candidate_but_cannot_publish_success(self):
        prepare=self.stage.admission.prepare_guarded
        def change(*args,**kwargs):
            result=prepare(*args,**kwargs);self.pending_path.write_text('{"changed": true}');return result
        with mock.patch.object(self.stage.admission,'prepare_guarded',side_effect=change),self.assertRaisesRegex(ValueError,'pending'):
            self.call()
        self.assertTrue(self.fixture.archive.is_file())
        self.assertFalse((self.op/'linux-admission-result.json').exists())
        self.assertEqual(json.loads(self.journal_path.read_bytes())['events'][-1]['state'],'outcome-unknown-resources-retained')

    def test_writer_replacement_after_primitive_return_is_unknown_before_success(self):
        prepare=self.stage.admission.prepare_guarded;writer=self.fixture.writer;retained=writer.with_suffix('.retained')
        def replace(*args,**kwargs):
            result=prepare(*args,**kwargs);writer.rename(retained);writer.touch();return result
        with mock.patch.object(self.stage.admission,'prepare_guarded',side_effect=replace), \
                mock.patch.object(self.stage,'inventory_datasets',return_value=None),self.assertRaises(ValueError):self.call()
        self.assertTrue(retained.is_file());self.assertTrue(self.fixture.archive.is_file())
        self.assertFalse((self.op/'linux-admission-result.json').exists())
        self.assertEqual(json.loads(self.journal_path.read_bytes())['events'][-1]['state'],'outcome-unknown-resources-retained')

    def test_store_replacement_after_primitive_return_is_unknown_before_success(self):
        prepare=self.stage.admission.prepare_guarded;store=self.fixture.store;retained=store.with_name('retained-store')
        def replace(*args,**kwargs):
            result=prepare(*args,**kwargs);store.rename(retained);store.mkdir();self.fixture.writer.touch();return result
        with mock.patch.object(self.stage.admission,'prepare_guarded',side_effect=replace), \
                mock.patch.object(self.stage,'inventory_datasets',return_value=None),self.assertRaises(ValueError):self.call()
        self.assertTrue((retained/'WRITER.lock').is_file());self.assertTrue(self.fixture.archive.is_file())
        self.assertFalse((self.op/'linux-admission-result.json').exists())

    def test_writer_replacement_during_old_inventory_is_unknown_before_success(self):
        writer=self.fixture.writer;retained=writer.with_suffix('.retained')
        def inventory(*args):
            self.fixture.locked();writer.rename(retained);writer.touch()
        with mock.patch.object(self.stage,'inventory_datasets',side_effect=inventory),self.assertRaises(ValueError):self.call()
        self.assertTrue(retained.exists());self.assertFalse((self.op/'linux-admission-result.json').exists())

    def test_certificate_change_during_old_inventory_cannot_publish_success(self):
        def inventory(*args):
            self.fixture.locked();self.fixture.case.fixture.certificate_path.write_bytes(b'{}')
        with mock.patch.object(self.stage,'inventory_datasets',side_effect=inventory),self.assertRaises(ValueError):self.call()
        self.assertTrue(self.fixture.archive.is_file());self.assertFalse((self.op/'linux-admission-result.json').exists())

    def test_writer_replacement_during_result_write_retains_ambiguous_receipts_as_unknown(self):
        document=self.stage._document;writer=self.fixture.writer;retained=writer.with_suffix('.retained')
        def replace(op,name,value):
            result=document(op,name,value)
            if name == 'linux-admission-result.json':writer.rename(retained);writer.touch()
            return result
        with mock.patch.object(self.stage,'_document',side_effect=replace),self.assertRaises(ValueError):self.call()
        self.assertTrue((self.op/'linux-admission-result.json').is_file())
        self.assertTrue((self.op/'linux-admission-failed.json').is_file())
        self.assertEqual(json.loads(self.journal_path.read_bytes())['events'][-1]['state'],'outcome-unknown-resources-retained')

    def test_writer_replacement_after_success_journal_still_raises_with_unknown_failure(self):
        publish=self.stage._publish_journal;writer=self.fixture.writer;retained=writer.with_suffix('.retained')
        def replace(path,expected,value):
            result=publish(path,expected,value)
            if value['events'][-1]['state'] == 'succeeded':writer.rename(retained);writer.touch()
            return result
        with mock.patch.object(self.stage,'_publish_journal',side_effect=replace),self.assertRaises(ValueError):self.call()
        self.assertTrue((self.op/'linux-admission-result.json').is_file())
        failure=json.loads((self.op/'linux-admission-failed.json').read_bytes())
        self.assertEqual(failure['state'],'outcome-unknown-resources-retained')
        self.assertEqual(json.loads(self.journal_path.read_bytes())['events'][-1]['state'],'succeeded')

    def test_late_success_journal_error_keeps_both_receipts_as_unknown(self):
        publish=self.stage._publish_journal;calls=[]
        def fail_late(path,expected,value):
            calls.append(value['events'][-1]['state'])
            if calls == ['started','succeeded']:raise RuntimeError('late journal failure')
            return publish(path,expected,value)
        with mock.patch.object(self.stage,'_publish_journal',side_effect=fail_late),self.assertRaisesRegex(RuntimeError,'late journal'):
            self.call()
        self.assertTrue((self.op/'linux-admission-result.json').is_file())
        self.assertTrue((self.op/'linux-admission-failed.json').is_file())
        self.assertTrue(self.fixture.archive.is_file())
        self.assertEqual(json.loads(self.journal_path.read_bytes())['events'][-1]['state'],'outcome-unknown-resources-retained')


if __name__=='__main__':unittest.main()
