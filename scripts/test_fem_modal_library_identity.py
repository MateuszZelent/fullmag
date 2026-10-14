import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import subprocess
from fem_modal_library_identity import capture, identity, loader_resolution, require_equal, resolve_runtime_library, verify_unchanged

class LibraryIdentityTests(unittest.TestCase):
    def test_same_size_mismatch_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            left, right = Path(directory)/'left', Path(directory)/'right'
            left.write_bytes(b'aaaa'); right.write_bytes(b'bbbb')
            with self.assertRaisesRegex(ValueError, 'differs'):
                require_equal(identity(left), identity(right))
            right.write_bytes(b'aaaa')
            require_equal(identity(left), identity(right))

    def test_missing_and_ambiguous_runtime_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            with self.assertRaisesRegex(ValueError, 'exactly one'):
                resolve_runtime_library(root)
            for name in ('libfullmag_fem.so.0.1.0','libfullmag_fem.so.other'):
                (root/name).write_bytes(b'library')
            with self.assertRaisesRegex(ValueError, 'exactly one'):
                resolve_runtime_library(root)

    def test_soname_symlinks_resolve_one_target(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); target=root/'libfullmag_fem.so.0.1.0'; target.write_bytes(b'library')
            (root/'libfullmag_fem.so').symlink_to(target)
            self.assertEqual(resolve_runtime_library(root),target.resolve())

    def test_wrong_loader_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); binary=root/'test'; expected=root/'expected'; wrong=root/'wrong'
            for path in (binary,expected,wrong): path.write_bytes(b'file')
            result=subprocess.CompletedProcess([],0,f'libfullmag_fem.so.0 => {wrong} (0x123)\n','')
            with patch('fem_modal_library_identity.subprocess.run',return_value=result):
                with self.assertRaisesRegex(ValueError,'wrong FEM loader'):
                    loader_resolution(binary,expected)

    def test_missing_test_dependency_fails_but_optional_runtime_is_explicit(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); binary=root/'test'; expected=root/'lib.so'
            binary.write_bytes(b'binary'); expected.write_bytes(b'library')
            result=subprocess.CompletedProcess([],0,'libc.so => /system/libc.so (0x123)\n','')
            with patch('fem_modal_library_identity.subprocess.run',return_value=result):
                with self.assertRaisesRegex(ValueError,'missing required FEM'):
                    loader_resolution(binary,expected)
                self.assertEqual(loader_resolution(binary,expected,required=False)['binding'],
                                 'no_linked_fem_dependency')

    def test_post_identity_detects_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); private=root/'private.so'; runtime=root/'libfullmag_fem.so.0.1.0'; manifest=root/'path.txt'
            private.write_bytes(b'old'); runtime.write_bytes(b'old'); manifest.write_text(str(private)+'\n')
            before=capture(manifest,root,[])
            private.write_bytes(b'new'); runtime.write_bytes(b'new')
            after=capture(manifest,root,[])
            with self.assertRaisesRegex(ValueError,'changed during'):
                verify_unchanged(before,after)

    def test_aslr_addresses_do_not_invalidate_stable_resolution(self):
        observed = {'private': {}, 'runtime': {}, 'loader_path': '/private',
                    'loader_resolutions': [{'binary': '/test', 'fem_dependency': '/private/lib.so',
                                            'binding': 'dynamic_dependency', 'ldd_stdout': '0x123'}]}
        changed = json.loads(json.dumps(observed))
        changed['loader_resolutions'][0]['ldd_stdout'] = '0x456'
        verify_unchanged(observed, changed)
        changed['loader_resolutions'][0]['fem_dependency'] = '/other/lib.so'
        with self.assertRaisesRegex(ValueError, 'loader resolution changed'):
            verify_unchanged(observed, changed)

    def test_ambiguous_manifest_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); manifest=root/'path.txt'; manifest.write_text('/one\n/two\n')
            with self.assertRaisesRegex(ValueError,'exactly one library path'):
                capture(manifest,root,[])

if __name__=='__main__': unittest.main()
