"""Interpreted exact-owned legacy build recovery guards; no real operation apply."""
import argparse
import ast
import ctypes
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import docker_dev_failed_build_recovery as recovery
import docker_dev_recovery_build as repair


def functions(source, names, scope):
    nodes=[node for node in ast.parse(source).body if isinstance(node,ast.FunctionDef) and node.name in names]
    exec(compile(ast.Module(body=nodes,type_ignores=[]),'<production-recovery-contract>','exec'),scope)
    return scope


class HostPidfdCompatibilityTests(unittest.TestCase):
    def test_missing_python_binding_observes_exact_child_exit_without_signals(self):
        release_r, release_w = os.pipe()
        child = os.fork()
        if child == 0:
            os.close(release_w)
            os.read(release_r, 1)
            os._exit(0)
        os.close(release_r)
        descriptor = None
        try:
            with patch.object(os, 'pidfd_open', None, create=True):
                descriptor = recovery.host_pidfd_open(child)
            self.assertFalse(select.select([descriptor], [], [], 0)[0])
            os.write(release_w, b'1')
            self.assertEqual(select.select([descriptor], [], [], 5)[0], [descriptor])
            _, status = os.waitpid(child, 0)
            child = None
            self.assertEqual(os.waitstatus_to_exitcode(status), 0)
        finally:
            os.close(release_w)
            if descriptor is not None:
                os.close(descriptor)
            if child is not None:
                os.waitpid(child, 0)

    def test_missing_python_binding_preserves_errno_and_rejects_unknown_architecture(self):
        with patch.object(os, 'pidfd_open', None, create=True):
            with self.assertRaises(ProcessLookupError):
                recovery.host_pidfd_open(2_147_483_647)
            with patch.object(os, 'uname', return_value=SimpleNamespace(sysname='Linux', machine='unknown')):
                with self.assertRaises(ValueError):
                    recovery.host_pidfd_open(os.getpid())


class FailedBuildRecoveryTests(unittest.TestCase):
    def test_generated_controller_parses_and_preview_never_calls_mutation(self):
        for apply,verify in ((False,False),(True,False),(False,True)):
            ast.parse(recovery.code(apply,verify))
        preview=ast.parse(recovery.code()).body[-1]
        self.assertIn('observe(',ast.unparse(preview))
        self.assertNotIn('finalize_native(',ast.unparse(preview))
        self.assertEqual(set(recovery.source_pins()),{'adapter_sha256','repair_sha256','apply_code_sha256'})

    def test_request_rejects_unknown_keys_paths_sources_and_changed_manager(self):
        args=argparse.Namespace(attempt='a'*32,backend_container_id='b'*64,image_id='sha256:'+'c'*64)
        root='/opt/fullmag/control/recovery-build/attempts/'+args.attempt
        manager={'pid':123,'start_token':'456'}
        request={'schema':recovery.SCHEMA,'attempt':args.attempt,'backend_container_id':args.backend_container_id,
            'image_id':args.image_id,'helper':{'Id':'own'},'operation_inputs':{'own':True},
            'operation_receipt_path':root+'/receipt.json','result_path':root+'/result.json',
            'source_pins':recovery.source_pins(),'host_manager':manager,'observation':{},
            'native_journal_path':'/opt/fullmag/control/verification/failed-build-recovery/'+args.attempt+'/'+'d'*32+'/native-handoff.json'}
        with patch.object(recovery,'host_process',return_value=manager),patch.object(recovery,'manager_pin',return_value=manager):
            recovery.validate_request(request,args,{'inputs':{'own':True}},{'Id':'own'})
            for key,value in [('extra',True),('result_path','/tmp/result.json'),
                              ('native_journal_path','/opt/fullmag/control/verification/elsewhere/native-handoff.json'),
                              ('source_pins',{})]:
                with self.subTest(key=key),self.assertRaises(ValueError):
                    recovery.validate_request({**request,key:value},args,{'inputs':{'own':True}},{'Id':'own'})
            with patch.object(recovery,'host_process',return_value={'pid':123,'start_token':'reused'}):
                with self.assertRaises(ValueError):
                    recovery.validate_request(request,args,{'inputs':{'own':True}},{'Id':'own'})

    def test_archive_collision_never_replaces_existing_directory(self):
        scope=functions(repair.RUNTIME,{'rename_no_replace'},dict(ctypes=ctypes,os=os))
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'source';destination=Path(directory)/'destination'
            source.mkdir();destination.mkdir();(source/'marker').write_bytes(b'preserve')
            with self.assertRaises(OSError) as failure:scope['rename_no_replace'](source,destination)
            self.assertEqual(failure.exception.errno,errno.EEXIST)
            self.assertEqual((source/'marker').read_bytes(),b'preserve')
            destination.rmdir();scope['rename_no_replace'](source,destination)
            self.assertEqual((destination/'marker').read_bytes(),b'preserve')

    def test_changed_identity_refuses_before_any_signal(self):
        scope=functions(recovery.RUNTIME,{'interrupt_owned_controllers'},
            dict(os=os,signal=signal,select=select,require=repair.require,
                 init_identity=lambda:{'pid':1},process_record=lambda pid:{'pid':pid,'start_token':'changed'},
                 held_native_locks=lambda *args:None))
        observation={'namespace_init':{'pid':1},'processes':[{'pid':os.getpid(),'start_token':'original'}],
                     'lock_inodes':{}}
        with patch.object(signal,'pidfd_send_signal') as send:
            with self.assertRaises(ValueError):scope['interrupt_owned_controllers'](observation)
            send.assert_not_called()

    def test_distinct_previews_share_one_operation_handoff_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);scope=functions(recovery.RUNTIME,{'finalize_native'},
                dict(Path=Path,os=os,stat=__import__('stat'),fcntl=fcntl,require=repair.require,
                     backend=SimpleNamespace(_assert_no_links=lambda *args:None)))
            one={'operation_receipt_path':str(root/'receipt.json'),'native_journal_path':str(root/'one'/'native-handoff.json')}
            two={**one,'native_journal_path':str(root/'two'/'native-handoff.json')}
            def held(request):
                with self.assertRaises(BlockingIOError):scope['finalize_native'](two)
                return 'first request alone'
            scope['finalize_native_locked']=held
            self.assertEqual(scope['finalize_native'](one),'first request alone')
            with (root/'legacy-handoff.lock').open('r+') as released:
                fcntl.flock(released,fcntl.LOCK_EX|fcntl.LOCK_NB)

    def test_actual_parent_then_reparented_guard_sigint_unwinds_fixture_lock(self):
        # This test process is the subreaper for its own two fixtures. Production
        # observes namespace PID 1; the fixture uses its exact local subreaper.
        libc=ctypes.CDLL(None,use_errno=True);previous=ctypes.c_int()
        self.assertEqual(libc.prctl(37,ctypes.byref(previous),0,0,0),0)
        self.assertEqual(libc.prctl(36,1,0,0,0),0)
        parent=child=None
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);lock=root/'OWNER.lock';lock.touch()
            scope=functions(recovery.RUNTIME,{'process_record','held_native_locks','interrupt_owned_controllers'},
                dict(Path=Path,os=os,hashlib=hashlib,signal=signal,select=select,require=repair.require))
            init=lambda:{key:value for key,value in scope['process_record'](os.getpid()).items() if key!='children'}
            scope['init_identity']=init
            ready_r,ready_w=os.pipe()
            parent=os.fork()
            if parent==0:
                os.close(ready_r)
                child=os.fork()
                if child==0:
                    with lock.open('r+') as owned:
                        fcntl.flock(owned,fcntl.LOCK_EX)
                        os.write(ready_w,str(os.getpid()).encode())
                        os.close(ready_w)
                        try:
                            while True:time.sleep(.1)
                        except KeyboardInterrupt:pass
                    os._exit(0)
                os.close(ready_w)
                try:
                    while True:time.sleep(.1)
                except KeyboardInterrupt:pass
                os._exit(0)
            os.close(ready_w)
            try:
                child=int(os.read(ready_r,64));os.close(ready_r)
                observation={'namespace_init':init(),'processes':[scope['process_record'](parent),scope['process_record'](child)],
                             'lock_inodes':{str(lock):[lock.stat().st_dev,lock.stat().st_ino]}}
                transitions=scope['interrupt_owned_controllers'](observation)
                self.assertEqual(transitions,[{'pid':child,'from_ppid':parent,'to_ppid':os.getpid()}])
                for pid in (parent,child):
                    _,status=os.waitpid(pid,0);self.assertEqual(os.waitstatus_to_exitcode(status),0)
                parent=child=None
                with lock.open('r+') as owned:fcntl.flock(owned,fcntl.LOCK_EX|fcntl.LOCK_NB)
            finally:
                for pid in (parent,child):
                    if pid:
                        try:os.kill(pid,signal.SIGTERM);os.waitpid(pid,0)
                        except (ProcessLookupError,ChildProcessError):pass
                libc.prctl(36,previous.value,0,0,0)

    def test_wrapper_routes_fixed_argv_and_refuses_unpinned_apply(self):
        wrapper=Path(recovery.__file__).with_name('just_storage_shell.sh').read_text()
        begin=wrapper.index('  *"scripts/docker_dev_failed_build_recovery.py"*)')
        end=wrapper.index('    ;;',begin)+len('    ;;')
        branch=wrapper[begin:end]
        # Replace only this branch's final exec; no launcher or Docker command runs.
        branch=branch[:branch.rfind('    exec ')]+'    printf "%s\\n" "__DOLLAR__{failed_build_args[@]}"\n    ;;'.replace('__DOLLAR__','$')
        command='python3 "/source/scripts/docker_dev_failed_build_recovery.py" --source-root \'/source\' --backend-container-id \''+'b'*64+'\' --image-id \'sha256:'+'c'*64+'\' --attempt \''+'a'*32+'\''
        script='recipe="$1"; case "$recipe" in\n'+branch+'\nesac'
        result=subprocess.run(['bash','-euo','pipefail','-c',script,'fixture',command],capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr);self.assertIn('--attempt',result.stdout)
        result=subprocess.run(['bash','-euo','pipefail','-c',script,'fixture',command+' --apply'],capture_output=True,text=True)
        self.assertEqual(result.returncode,2);self.assertIn('requires reviewed request',result.stderr)


if __name__=='__main__':unittest.main()
