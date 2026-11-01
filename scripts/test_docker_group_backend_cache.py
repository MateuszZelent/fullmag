import copy
import tempfile
import unittest
from pathlib import Path
import docker_backend_volume_cache as cache
from test_docker_backend_volume_cache import _profile, _container, _maintenance_receipt, TOOLCHAIN, IMAGE

class GroupBackendCacheTests(unittest.TestCase):
    def prepare(self, args, **kw):
        old, layout, source, repo, runroot=args
        return cache.prepare(layout,repo,IMAGE,runroot,source_root=source,toolchain_image=kw.pop('toolchain_image',TOOLCHAIN),control_volume_name=__import__('bootstrap_docker_toolchain').control_volume_name(layout['compose_project']),shared_packages=True,group_volume=True,**kw)

    def test_toolchain_and_profile_change_reuse_volume_and_package_namespace(self):
        with tempfile.TemporaryDirectory() as tmp:
            args=_profile(tmp,shared_packages=True)
            a=self.prepare(args)
            b=self.prepare(args,toolchain_image='sha256:'+'d'*64,cargo_profile='release')
            self.assertEqual(a['volume_names']['build'],a['volume_names']['control'])
            self.assertEqual(a['volume_names'],b['volume_names'])
            self.assertEqual(a['unit_key'],b['unit_key'])
            self.assertNotEqual(a['cache_key'],b['cache_key'])
            self.assertEqual(a['shared_package_subpath'],b['shared_package_subpath'])
            self.assertEqual(a['environment']['FULLMAG_PRIVATE_GROUP_STORAGE'],'group-volume-v1')
            mount=next(m for m in a['mounts'] if m['target']=='/build')
            self.assertEqual(mount['volume']['subpath'],'private/backend')

    def test_backend_plan_does_not_require_host_storage(self):
        with tempfile.TemporaryDirectory() as tmp:
            old,layout,source,repo,_=_profile(tmp,shared_packages=True)
            layout.pop('storage_root')
            result=cache.prepare(layout,repo,IMAGE,None,source_root=source,toolchain_image=TOOLCHAIN,
                control_volume_name=__import__('bootstrap_docker_toolchain').control_volume_name(layout['compose_project']),
                shared_packages=True,group_volume=True)
            self.assertEqual(result['receipt_storage'],'docker-named-volume')
            self.assertIsNone(result['host_receipt_path'])

    def test_interrupted_render_keeps_layout_and_legacy_resume_stays_legacy(self):
        import docker_volume_dev as dev
        class Control:
            def __init__(self):self.records={}
            def write(self,path,data):self.records[path]=copy.deepcopy(data)
        control=Control();operation={'receipt':{},'root':'development/attempts/exact'}
        self.assertTrue(dev._pin_private_group_storage(control,operation,new_render=True))
        persisted=control.records[operation['root']+'/receipt.json']
        self.assertTrue(dev._pin_private_group_storage(control,{'receipt':persisted,'root':operation['root']},new_render=False))
        self.assertFalse(dev._pin_private_group_storage(control,{'receipt':{},'root':'legacy'},new_render=False))
        refreshed={'receipt':{},'root':'frontend-refresh'}
        self.assertTrue(dev._pin_private_group_storage(control,refreshed,new_render=False,previous=persisted))
        self.assertEqual(control.records['frontend-refresh/receipt.json']['private_group_storage'],'group-volume-v1')
        control.read=lambda *a,**kw:{'schema':'fullmag.docker-group-storage-owner.v1'}
        with self.assertRaises(dev.BuildControlError):
            dev._uses_private_group_storage(control,{'receipt':{}})
        with self.assertRaises(dev.BuildControlError):
            dev._pin_private_group_storage(control,{'receipt':{'private_group_storage':'unknown'},'root':'bad'},new_render=False)

    def test_no_new_private_volume_and_canonical_control_labels(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=self.prepare(_profile(tmp,shared_packages=True))
            docs={role:{'Name':n,'Driver':'local','Options':{},'Scope':'local','Mountpoint':f'/var/lib/docker/volumes/{n}/_data','Labels':cache.volume_labels(p,role)} for role,n in p['volume_names'].items()}
            self.assertEqual(docs['build']['Labels'],docs['control']['Labels'])
            calls=[]
            def docker(*args):
                calls.append(args)
                if args[:2]!=('volume','inspect'):raise AssertionError('No private volume creation permitted')
                return [next(d for d in docs.values() if d['Name']==args[2])]
            observed=cache.ensure_volume_pair(docker,p)
            self.assertEqual(observed['build']['Name'],observed['control']['Name'])
            self.assertTrue(all(c[:2]==('volume','inspect') for c in calls))

    def test_existing_bootstrap_volume_needs_only_canonical_shared_labels(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=self.prepare(_profile(tmp,shared_packages=True))
            role=cache.BUILD_VOLUME_ROLE
            name=p['volume_names'][role]
            labels=cache._control_volume_labels(p)
            doc={'Name':name,'Driver':'local','Options':{},'Scope':'local',
                 'Mountpoint':f'/var/lib/docker/volumes/{name}/_data','Labels':labels}
            self.assertEqual(cache._validate_volume_document(doc,p,role)['Name'],name)
            doc['Labels']={**labels,'org.fullmag.source.worktree-id':'another-worktree'}
            with self.assertRaises(cache.BackendVolumeCacheError):
                cache._validate_volume_document(doc,p,role)

    def test_backend_cannot_mount_group_root_as_build_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=self.prepare(_profile(tmp,shared_packages=True))
            p['volume_documents']={role:{'Name':n,'Driver':'local','Options':{},'Scope':'local','Mountpoint':f'/var/lib/docker/volumes/{n}/_data','Labels':cache.volume_labels(p,role)} for role,n in p['volume_names'].items()}
            p['state']='ready'  # isolate mount attestation after maintenance admission
            row=_container(p)
            with self.assertRaises(cache.BackendVolumeCacheError):cache.validate_container(row,p)
            for m in row['Mounts']:
                if m['Destination']=='/build':m['Source']+='/private/backend'
            for m in row['HostConfig']['Mounts']:
                if m['Target']=='/build':m['VolumeOptions']={'Subpath':'private/backend'}
            self.assertEqual(cache.validate_container(row,p)['state'],'attested')

    def test_unknown_control_root_consumer_cannot_modify_build_subpath(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=self.prepare(_profile(tmp,shared_packages=True))
            c={'Id':'e'*64,'State':{'Running':True},'Config':{'Labels':{},'Env':[]},'Mounts':[{'Type':'volume','Name':p['volume_names']['control'],'Destination':'/foreign','Source':'/var/lib/docker/volumes/'+p['volume_names']['control']+'/_data','RW':True}], 'HostConfig':{'Mounts':[]}}
            with self.assertRaises(cache.BackendVolumeCacheError):cache._assert_no_active_consumers(p,[c])

if __name__=='__main__':unittest.main()
