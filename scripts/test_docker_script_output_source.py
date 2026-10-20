"""User result files must not invalidate the backend source package cache."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'docker/all-in-one'))
import backend_source

@unittest.skipIf(os.name == 'nt', 'image-owned Linux source capture')
class OutputSourceIdentityTests(unittest.TestCase):
    def test_untracked_binary_is_excluded_only_inside_the_opted_in_directory(self):
        raw = b'examples/model.fms\0fixtures/reference.h5\0examples/new.py\0'
        with patch.dict(os.environ, {}, clear=True):
            paths, _ = backend_source._live_untracked_records(raw)
            self.assertEqual(paths, ['examples/model.fms', 'fixtures/reference.h5', 'examples/new.py'])
        with patch.dict(os.environ, {
            'FULLMAG_SCRIPT_OUTPUT_ROOT': '/opt/fullmag/script-output',
            'FULLMAG_SCRIPT_OUTPUT_SOURCE_DIR': '/opt/fullmag/source/examples',
        }, clear=True):
            paths, _ = backend_source._live_untracked_records(raw)
            self.assertEqual(paths, ['fixtures/reference.h5', 'examples/new.py'])

    def test_results_do_not_change_identity_but_tracked_fixtures_and_new_code_do(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def git(*args):
                return subprocess.run(['git', '-C', str(root), *args], check=True, capture_output=True)
            git('init'); git('config', 'user.name', 'Output test'); git('config', 'user.email', 'output@example.invalid')
            (root / 'examples').mkdir()
            (root / 'examples/model.py').write_text('value = 1\n')
            fixture = root / 'examples/reference.h5'; fixture.write_bytes(b'tracked fixture')
            git('add', '.'); git('commit', '-m', 'Create source fixture')
            environment = {'FULLMAG_SCRIPT_OUTPUT_ROOT': '/opt/fullmag/script-output',
                           'FULLMAG_SCRIPT_OUTPUT_SOURCE_DIR': '/opt/fullmag/source/examples'}
            with patch.dict(os.environ, environment):
                before = backend_source._capture_live_source_once(root, root / '.git')
                (root / 'examples/model.fms').write_bytes(b'user session')
                (root / 'examples/model.results').mkdir()
                (root / 'examples/model.results/field.h5').write_bytes(b'user field')
                (root / 'examples/.fullmag-tmp').mkdir()
                (root / 'examples/.fullmag-tmp/runtime.json').write_text('{}')
                after = backend_source._capture_live_source_once(root, root / '.git')
                self.assertEqual(before, after, 'saving user results must preserve backend cache identity')
                fixture.write_bytes(b'changed tracked fixture')
                self.assertNotEqual(after, backend_source._capture_live_source_once(root, root / '.git'))
                fixture.write_bytes(b'tracked fixture')
                (root / 'examples/new_code.py').write_text('value = 2\n')
                self.assertNotEqual(after, backend_source._capture_live_source_once(root, root / '.git'))

if __name__ == '__main__': unittest.main()
