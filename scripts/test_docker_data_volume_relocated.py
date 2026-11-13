"""Post-bind view authentication; tiny files, no mount or daemon mutations."""
from contextlib import ExitStack
import copy
import hashlib
import json
import os
from pathlib import Path
import threading
import unittest
from types import SimpleNamespace
from unittest import mock

from scripts import docker_dev_data_volume_copy as copy_parent
from scripts import docker_dev_data_volume_bind as bind_parent
from scripts import test_docker_data_volume_bind_job as fixtures
from scripts import fullmag_data_volume_journal as journal_module


class RelocatedGroupTests(unittest.TestCase):
    def setUp(self):
        import docker_data_volume_relocated as relocated
        self.module=relocated
        self.case=fixtures.BindTerminalScenario(self)
        self.case.plan['runtime_pins']['image_id']='sha256:'+'f'*64
        self.case.plan_raw=(json.dumps(self.case.plan,sort_keys=True)+'\n').encode()
        self.case.pending_value['plan_sha256']=hashlib.sha256(self.case.plan_raw).hexdigest()
        self.case.write(self.case.pending_path,self.case.pending_value)
        self.result=self.case.publish_success()
        op=self.case.operation_root
        (op/'plan.json').write_bytes(self.case.plan_raw)
        self.case.write(op/'linux-provision-result.json',{'fixture':'protected mount'})
        self.terminal={'state':self.result['state'],'result':self.result,
            'receipt_sha256':hashlib.sha256((op/'linux-bind-result.json').read_bytes()).hexdigest()}
        self.context={'source':self.case.source_root,'operation_root':op,'plan':self.case.plan,
            'plan_sha256':hashlib.sha256(self.case.plan_raw).hexdigest(),
            'linux':self.case.linux,'linux_request_sha256':self.case.linux_sha256,
            'provision_result_sha256':hashlib.sha256((op/'linux-provision-result.json').read_bytes()).hexdigest(),
            'layout':self.case.pending_layout,'identity':{'project_name':'compose-fixture'}}
        self.copied=copy_parent._CopiedGroupScope(self.context,{'receipt_sha256':self.case.request['copy_receipt_sha256']})
        self.token=copy_parent._CURRENT_COPY_SCOPE.set(self.copied)
        self.addCleanup(copy_parent._CURRENT_COPY_SCOPE.reset,self.token)
        self.bound={'context':copy.deepcopy(self.context),'terminal':self.terminal}
        self.stack=ExitStack();self.addCleanup(self.stack.close)
        self.validate=self.stack.enter_context(mock.patch.object(relocated.bind_job,'validate_terminal',return_value=self.terminal))
        self.stack.enter_context(mock.patch.object(relocated,'load_plan',return_value=(self.case.plan_raw,self.case.plan,None)))
        self.stack.enter_context(mock.patch.object(relocated,'validate_linux_request',return_value=self.case.linux))
        self.stack.enter_context(mock.patch.object(relocated,'_mounted_root',return_value=self.case.mount_root))
        self.identities={}
        for row in self.result['switch']['roots'].values():
            self.identities[Path(row['backup_root'])]=row['original_identity']
            self.identities[Path(row['canonical_root'])]=row['bound_identity']
        self.stack.enter_context(mock.patch.object(relocated,'_observe_directory',side_effect=lambda p:copy.deepcopy(self.identities[Path(p)])))
        self.mounts={}
        self.newdev='0:501';self.olddev='0:101'
        self.mounts[self.case.mount_root]={'target':str(self.case.mount_root),'fsroot':'/',
            'fstype':'ext4','uuid':self.case.filesystem_uuid,'maj:min':self.newdev,
            'options':'rw,nodev,nosuid','propagation':'private'}
        for row in self.result['switch']['roots'].values():
            canonical=Path(row['canonical_root'])
            self.mounts[canonical]=dict(self.mounts[self.case.mount_root],target=str(canonical),
                fsroot='/'+str(Path(row['copied_root']).relative_to(self.case.mount_root)))
        self.real_mount=relocated._mount
        self.stack.enter_context(mock.patch.object(relocated,'_mount',side_effect=self.mount))

    def mount(self,path):
        path=Path(path)
        if path in self.mounts:return copy.deepcopy(self.mounts[path])
        return {'target':'/','fsroot':'/','fstype':'ext4','uuid':'old-filesystem',
                'maj:min':self.olddev,'options':'rw','propagation':'private'}

    def issue(self):
        return bind_parent.relocated_copied_group(self.copied,self.bound)

    def test_verified_live_view_distinguishes_old_roots_from_canonical_declarations(self):
        view=self.issue();observed=view.check(self.case.source_root,self.case.plan)
        self.validate.assert_called_once_with(self.case.operation_root,self.case.request,self.case.request_sha256,0)
        for role,row in self.result['switch']['roots'].items():
            self.assertEqual(observed['old_roots'][role],Path(row['backup_root']))
            self.assertEqual(observed['canonical_roots'][role],Path(row['canonical_root']))
            self.assertIn(Path(row['copied_root']),observed['consumer_roots'])
        self.assertEqual(self.copied['context']['plan']['observation']['datasets'],self.case.source_roots)

    def test_saved_or_escaped_copy_scope_is_not_authority(self):
        saved=dict(self.copied)
        with self.assertRaises(ValueError):self.module.from_bound(saved,self.bound)
        view=self.issue();self.copied._live=False
        with self.assertRaises(ValueError):view.check(self.case.source_root,self.case.plan)

    def test_forged_checker_cannot_revive_an_expired_scope(self):
        self.copied._live=False
        with self.assertRaises(TypeError):self.module.from_bound(self.copied,self.bound,lambda value:value)
        with self.assertRaises(ValueError):self.issue()
        self.validate.assert_not_called()

    def test_direct_import_issuer_uses_its_own_live_contextvar(self):
        import docker_dev_data_volume_copy as direct
        scope=direct._CopiedGroupScope(self.context,self.copied['terminal'])
        with self.assertRaises(ValueError):self.module.from_bound(scope,self.bound)
        token=direct._CURRENT_COPY_SCOPE.set(scope)
        try:
            view=self.module.from_bound(scope,self.bound)
            view.check(self.case.source_root,self.case.plan)
        finally:direct._CURRENT_COPY_SCOPE.reset(token)
        with self.assertRaises(ValueError):view.check(self.case.source_root,self.case.plan)

    def test_changed_context_and_wrong_source_or_plan_refuse(self):
        self.bound['context']['plan_sha256']='0'*64
        with self.assertRaisesRegex(ValueError,'copied context'):self.issue()
        self.bound['context']=copy.deepcopy(self.context);view=self.issue()
        for source,plan in [(Path('/foreign'),self.case.plan),(self.case.source_root,{})]:
            with self.assertRaisesRegex(ValueError,'source/plan'):view.check(source,plan)

    def test_inherited_context_in_other_thread_cannot_use_view(self):
        import contextvars
        view=self.issue();errors=[]
        def attempt():
            try:view.check(self.case.source_root,self.case.plan)
            except ValueError as error:errors.append(str(error))
        thread=threading.Thread(target=contextvars.copy_context().run,args=(attempt,));thread.start();thread.join()
        self.assertEqual(len(errors),1)

    def test_changed_pending_or_request_bytes_refuse_before_physical_probe(self):
        for name,path in [('pending',self.case.pending_path),('request',self.case.operation_root/'linux-bind-request.json')]:
            with self.subTest(name=name):
                view=self.issue();raw=path.read_bytes();path.write_bytes(raw+b' ')
                try:
                    with mock.patch.object(self.module,'_observe_directory') as physical,self.assertRaisesRegex(ValueError,'evidence'):
                        view.check(self.case.source_root,self.case.plan)
                    physical.assert_not_called()
                finally:path.write_bytes(raw)

    def test_old_and_new_identity_or_new_mount_drift_refuses(self):
        view=self.issue();row=self.result['switch']['roots']['state']
        for key in ('backup_root','canonical_root'):
            path=Path(row[key]);original=self.identities[path]
            self.identities[path]=dict(original,inode=original['inode']+1)
            try:
                with self.assertRaisesRegex(ValueError,'identity'):view.check(self.case.source_root,self.case.plan)
            finally:self.identities[path]=original
        path=Path(row['canonical_root'])
        for key,value in [('uuid','wrong'),('propagation','shared'),('fsroot','/wrong'),('options','rw')]:
            old=self.mounts[path][key];self.mounts[path][key]=value
            try:
                with self.assertRaisesRegex(ValueError,'mount'):view.check(self.case.source_root,self.case.plan)
            finally:self.mounts[path][key]=old

    def test_journal_valid_prefix_can_advance_only_into_live_admission(self):
        view=self.issue();path=self.case.journal_path;original=path.read_bytes()
        next_journal=journal_module.append_started(json.loads(original),'admission-prepared','e'*64)
        self.case.write(path,next_journal);view.check(self.case.source_root,self.case.plan)
        for state in ('failed-confirmed','outcome-unknown-resources-retained'):
            self.case.write(path,journal_module.append_terminal(next_journal,state,'d'*64))
            with self.assertRaisesRegex(ValueError,'journal'):view.check(self.case.source_root,self.case.plan)
        self.case.write(path,json.loads(original));changed=json.loads(original);changed['events'][0]['inputs_sha256']='0'*64
        self.case.write(path,changed)
        with self.assertRaises(ValueError):view.check(self.case.source_root,self.case.plan)

    def test_same_prefix_in_recovery_journal_cannot_replace_selected_journal(self):
        view=self.issue()
        selected,journal=self.module.qualification._selected_journal(self.case.operation_root)
        with mock.patch.object(self.module.qualification,'_selected_journal',return_value=(selected.with_name('other.json'),journal)):
            with self.assertRaisesRegex(ValueError,'journal'):view.check(self.case.source_root,self.case.plan)

    def test_recovery_selector_bytes_cannot_change_after_issue(self):
        view=self.issue()
        (self.case.operation_root/'active-attempt.json').write_text('{}')
        with self.assertRaisesRegex(ValueError,'selector'):view.check(self.case.source_root,self.case.plan)

    def test_lexical_and_physical_alias_consumers_overlap_but_disjoint_mount_passes(self):
        view=self.issue();view.check(self.case.source_root,self.case.plan)
        row=self.result['switch']['roots']['state']
        for key in ('backup_root','canonical_root','copied_root'):
            for path in (Path(row[key]),Path(row[key])/'results',Path(row[key]).parent):
                self.assertTrue(view.overlaps(path),str(path))
        alias=Path('/different-bind-alias')
        self.mounts[alias]=dict(self.mounts[Path(row['canonical_root'])],target=str(alias))
        self.assertTrue(view.overlaps(alias))
        self.assertFalse(view.overlaps(Path('/unrelated/data')))

    def test_foreign_pseudo_filesystem_can_be_proved_disjoint_without_uuid(self):
        row={'target':'/dev','fsroot':'/','fstype':'devtmpfs','uuid':None,
             'maj:min':'0:999','options':'rw,nosuid','propagation':'private'}
        view=self.issue()
        with mock.patch.object(self.module.qualification,'_capture',return_value=
                SimpleNamespace(stdout=json.dumps({'filesystems':[row]}).encode())):
            observed=self.real_mount(Path('/dev/null'))
        self.assertIsNone(observed['uuid'])
        self.mounts[Path('/dev/null')]=observed
        self.assertFalse(view.overlaps(Path('/dev/null')))

    def test_ext4_null_uuid_resolves_and_reported_uuid_keeps_no_ioctl_route(self):
        path=self.case.mount_root
        row={'target':str(path),'fsroot':'/','fstype':'ext4','uuid':None,'maj:min':self.newdev,
             'options':'rw,nodev,nosuid','propagation':'private'}
        with mock.patch.object(self.module.qualification,'_capture',return_value=
                SimpleNamespace(stdout=json.dumps({'filesystems':[row]}).encode())), \
                mock.patch.object(self.module,'resolve_mount_uuid',return_value=self.case.filesystem_uuid,
                                  create=True) as resolve:
            observed=self.real_mount(path)
        self.assertEqual(observed['uuid'],self.case.filesystem_uuid)
        resolve.assert_called_once_with(path,None,major_minor=self.newdev)
        self.assertIsNone(row['uuid'])

        row=dict(row,uuid=self.case.filesystem_uuid)
        with mock.patch.object(self.module.qualification,'_capture',return_value=
                SimpleNamespace(stdout=json.dumps({'filesystems':[row]}).encode())), \
                mock.patch.object(self.module,'resolve_mount_uuid',create=True) as resolve:
            observed=self.real_mount(path)
        self.assertEqual(observed['uuid'],self.case.filesystem_uuid)
        resolve.assert_not_called()

    def test_ext4_null_uuid_mismatch_or_unsupported_resolution_fails_view_check(self):
        view=self.issue();path=self.case.mount_root
        row={'target':str(path),'fsroot':'/','fstype':'ext4','uuid':None,'maj:min':self.newdev,
             'options':'rw,nodev,nosuid','propagation':'private'}
        original_mount=self.mount

        def observe_with_null(path_value):
            path_value=Path(path_value)
            if path_value not in self.mounts or path_value == path:
                return self.real_mount(path_value)
            return original_mount(path_value)

        def capture(_argv, **_kwargs):
            return SimpleNamespace(stdout=json.dumps({'filesystems':[row]}).encode())

        for resolver,pattern in (
            (mock.Mock(return_value='22222222-2222-4222-8222-222222222222'),'mount changed'),
            (mock.Mock(side_effect=ValueError('unsupported UUID ioctl')),'unsupported UUID ioctl'),
        ):
            with self.subTest(pattern=pattern), \
                    mock.patch.object(self.module,'_mount',side_effect=observe_with_null), \
                    mock.patch.object(self.module.qualification,'_capture',side_effect=capture), \
                    mock.patch.object(self.module,'resolve_mount_uuid',resolver,create=True), \
                    self.assertRaisesRegex(ValueError,pattern):
                view.check(self.case.source_root,self.case.plan)
            resolver.assert_called_once_with(path,None,major_minor=self.newdev)

    def test_relocated_mount_rejects_missing_or_ambiguous_uuid_fields(self):
        path=self.case.mount_root
        base={'target':str(path),'fsroot':'/','fstype':'ext4','maj:min':self.newdev,
              'options':'rw,nodev,nosuid','propagation':'private'}
        for row in (dict(base),dict(base,uuid=None,UUID=None)):
            with self.subTest(row=row), \
                    mock.patch.object(self.module.qualification,'_capture',return_value=
                        SimpleNamespace(stdout=json.dumps({'filesystems':[row]}).encode())), \
                    mock.patch.object(self.module,'resolve_mount_uuid',create=True) as resolve, \
                    self.assertRaises(ValueError):
                self.real_mount(path)
            resolve.assert_not_called()

    def test_overrides_are_closed_and_keep_original_root_ids(self):
        view=self.issue()
        request={'volume_id':self.case.linux['volume_id'],
            'source_roots':{r:{k:v[k] for k in ('device','inode')} for r,v in self.case.source_roots.items()}}
        mounts=view.old_mounts(self.case.source_root,request)
        self.assertEqual(set(mounts),{'/state','/user-data'})
        self.assertEqual(mounts['/state'],Path(self.result['switch']['roots']['state']['backup_root']))
        request['source_roots']['state']['inode']+=1
        with self.assertRaisesRegex(ValueError,'original'):view.old_mounts(self.case.source_root,request)

    def test_fence_override_is_bound_to_exact_original_backend_and_image(self):
        view=self.issue();pins=self.case.plan['runtime_pins']
        request={'volume_id':self.case.linux['volume_id'],
            'source_roots':{r:{k:v[k] for k in ('device','inode')} for r,v in self.case.source_roots.items()}}
        actual={'Id':pins['backend'],'Image':pins['image_id']}
        self.assertEqual(set(self.module.fence_mounts(view,self.case.source_root,request,actual)),{'/state','/user-data'})
        for key in ('Id','Image'):
            with self.assertRaisesRegex(ValueError,'backend incarnation'):
                self.module.fence_mounts(view,self.case.source_root,request,dict(actual,**{key:'foreign'}))


if __name__=='__main__':unittest.main()
