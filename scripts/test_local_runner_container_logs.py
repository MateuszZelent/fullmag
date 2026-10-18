"""Real Application.logs regression with an in-memory filesystem; no runner activation."""
import io
import json
from pathlib import Path, PurePosixPath
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from local_runner import container_main

LEGACY = ('native-build.stderr.log', 'native-build.stdout.log', 'frontend-dependencies.stdout.log',
          'frontend-dependencies.stderr.log', 'frontend-build.stderr.log', 'frontend-build.stdout.log')
BASE = '/storage/runs/wt/job'

class MemoryPath:
    def __init__(self, fs, value): self.fs, self.value = fs, str(PurePosixPath(value))
    def __truediv__(self, value): return MemoryPath(self.fs, self.value + '/' + str(value))
    @property
    def name(self): return PurePosixPath(self.value).name
    def exists(self): return self.is_file() or any(p.startswith(self.value + '/') for p in self.fs.files)
    def is_file(self): return self.value in self.fs.files
    def is_symlink(self): return self.value in self.fs.symlinks
    def stat(self): return SimpleNamespace(st_size=self.fs.sizes.get(self.value, len(self.fs.files[self.value])))
    def open(self, mode):
        assert mode == 'rb'
        self.fs.reads.append(self.value)
        return io.BytesIO(self.fs.files[self.value])
    def read_text(self, encoding='utf-8'):
        self.fs.reads.append(self.value)
        return self.fs.files[self.value].decode(encoding)
    def iterdir(self):
        names = {p[len(self.value)+1:].split('/')[0] for p in self.fs.files if p.startswith(self.value + '/')}
        return iter(MemoryPath(self.fs, self.value + '/' + n) for n in sorted(names))

class MemoryFS:
    def __init__(self): self.files, self.sizes, self.symlinks, self.reads = {}, {}, set(), []
    def log(self, name, content): self.files[BASE + '/artifacts/logs/' + name] = content
    def receipt(self, stages, **overrides):
        value = dict(schema='fullmag.local-runner.build-receipt.v1', job_id='job', profile='boris-cpu-v1', stages=stages)
        value.update(overrides)
        self.files[BASE + '/artifacts/build-receipt.json'] = json.dumps(value).encode()

class ContainerLogsTests(unittest.TestCase):
    def call(self, fs, profile='boris-cpu-v1', docker_text=''):
        app = container_main.Application.__new__(container_main.Application)
        app.storage = MemoryPath(fs, '/storage')
        app.get = lambda job: dict(job_id=job, worktree_id='wt', profile=profile)
        with patch.object(container_main, 'validate_path', side_effect=lambda p,*a,**kw:p), \
             patch.object(container_main, 'inspect_owned') as inspect, \
             patch.object(container_main, 'docker', return_value=docker_text) as docker:
            result = app.logs('job')
            return result, inspect.call_args_list, docker.call_args_list

    def test_boris_first_compile_error_is_returned_by_real_method(self):
        fs = MemoryFS()
        fs.log('boris-cpu-compile-00000.stderr.log', b'fatal error: fftw3.h: No such file or directory')
        tail = self.call(fs)[0]['tail']
        self.assertIn('fatal error: fftw3.h', tail)
        self.assertIn('boris-cpu-compile-00000.stderr.log', tail)

    def test_first_failure_survives_409_compile_stage_logs(self):
        fs = MemoryFS()
        for i in range(409):
            fs.log(f'boris-cpu-compile-{i:05d}.stderr.log', b'first fatal error' if i == 0 else b'')
            fs.log(f'boris-cpu-compile-{i:05d}.stdout.log', f'success {i}'.encode())
        fs.receipt([dict(name=f'boris-cpu-compile-{i:05d}',exit_code=1 if i == 0 else 0) for i in range(409)])
        tail = self.call(fs)[0]['tail']
        self.assertIn('first fatal error',tail)
        self.assertLess(tail.index('first fatal error'),tail.index('success 408'))
        self.assertLessEqual(len([p for p in fs.reads if p.endswith('.log')]),8)

    def test_abi_witness_fixed_names_and_failed_priority(self):
        fs=MemoryFS()
        for name in ('boris-cpu-abi-compile','boris-cpu-abi-link','boris-cpu-abi-observe'):
            fs.log(name+'.stderr.log', name.encode())
        fs.log('boris-cpu-abi-other.stderr.log',b'REJECTED_SECRET')
        fs.receipt([dict(name='boris-cpu-abi-compile',exit_code=1)])
        tail=self.call(fs)[0]['tail']
        self.assertLess(tail.index('boris-cpu-abi-compile.stderr.log'),tail.index('boris-cpu-abi-observe.stderr.log'))
        self.assertIn('boris-cpu-abi-link.stderr.log',tail)
        self.assertNotIn('REJECTED_SECRET',tail)

    def test_legacy_six_order_and_tail_and_docker_behavior_unchanged(self):
        fs = MemoryFS()
        expected=[]
        for name in LEGACY:
            content=b'old prefix' + (name.encode()+b'\xff')*1000
            fs.log(name,content);expected.append(name+'\n'+content[-16000:].decode(errors='replace'))
        fs.log('boris-cpu-link.stderr.log',b'must not appear')
        fs.files[BASE+'/coordinator.json']=b'{"container_id":"owned"}'
        docker_text='legacy Docker\n'*2000
        result,inspect,calls=self.call(fs,profile='fem-cpu-release',docker_text=docker_text)
        self.assertEqual(result,dict(job_id='job',tail='\n'.join([*expected,docker_text])))
        self.assertEqual(calls[0].args[0],['logs','--tail','100','owned'])
        self.assertEqual(inspect[0].args[1:],('owned','job'))

    def test_only_trusted_names_and_regular_files_are_read(self):
        fs=MemoryFS()
        for name in ('boris-cpu-compile-20000.stderr.log','boris-cpu-compile-100000.stderr.log','boris-cpu-compile-00000.stderr.log.bak','other.stderr.log'):
            fs.log(name,b'REJECTED_SECRET')
        fs.log('boris-cpu-link.stderr.log',b'REJECTED_SYMLINK')
        fs.symlinks.add(BASE+'/artifacts/logs/boris-cpu-link.stderr.log')
        fs.log('boris-binary-inspect.stdout.log',b'ELF inspection')
        fs.receipt([dict(name='../../outside',exit_code=1,stderr_log='../../secret')])
        tail=self.call(fs)[0]['tail']
        self.assertIn('ELF inspection',tail)
        self.assertNotIn('REJECTED',tail)
        self.assertFalse(any('20000' in p or '100000' in p or p.endswith('.bak') for p in fs.reads))

    def test_invalid_or_foreign_receipt_uses_bounded_recent_fallback(self):
        for override in (dict(job_id='other'),dict(profile='other'),dict(schema='other')):
            with self.subTest(override=override):
                fs=MemoryFS()
                for i in range(10):fs.log(f'boris-cpu-compile-{i:05d}.stderr.log',str(i).encode())
                fs.receipt([dict(name='boris-cpu-compile-00000',exit_code=1)],error='FOREIGN_SECRET',**override)
                tail=self.call(fs)[0]['tail']
                self.assertNotIn('00000.stderr.log',tail)
                self.assertNotIn('FOREIGN_SECRET',tail)
                self.assertIn('00009.stderr.log',tail)

    def test_oversized_or_malformed_receipt_does_not_hide_logs(self):
        for oversized in (False,True):
            with self.subTest(oversized=oversized):
                fs=MemoryFS();fs.log('boris-cpu-compile-00408.stderr.log',b'last compile fatal')
                fs.files[BASE+'/artifacts/build-receipt.json']=b'not json'
                if oversized:fs.sizes[BASE+'/artifacts/build-receipt.json']=32*1024*1024+1
                tail=self.call(fs)[0]['tail'];self.assertIn('last compile fatal',tail)
                if oversized:self.assertNotIn(BASE+'/artifacts/build-receipt.json',fs.reads)

    def test_boris_response_file_count_tails_and_docker_are_bounded(self):
        fs=MemoryFS()
        for name in LEGACY:fs.log(name,b'PREFIX'+b'x'*20000)
        for i in range(30):
            for stream in ('stderr','stdout'):fs.log(f'boris-cpu-compile-{i:05d}.{stream}.log',b'PREFIX'+b'x'*20000)
        fs.log('boris-cpu-link.stderr.log',b'link error')
        fs.log('boris-binary-inspect.stdout.log',b'inspect output')
        fs.receipt([dict(name='boris-cpu-compile-00000',exit_code=1)],error='e'*30000)
        fs.files[BASE+'/coordinator.json']=b'{"container_id":"owned"}'
        result,_,_=self.call(fs,docker_text='d'*30000)
        self.assertLessEqual(len(result['tail']),258000)
        self.assertNotIn('PREFIX',result['tail'])
        self.assertTrue(result['tail'].endswith('d'*16000))
        self.assertFalse(result['tail'].endswith('d'*16001))
        self.assertLessEqual(len([p for p in fs.reads if '/boris-' in p and p.endswith('.log')]),8)

if __name__=='__main__':unittest.main(verbosity=2)
