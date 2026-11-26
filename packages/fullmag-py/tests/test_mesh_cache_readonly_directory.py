"""Existing mesh caches must be usable through a genuinely read-only capture."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from fullmag.model.problem import _fem_mesh_cache_dir


class MeshCacheReadonlyDirectoryTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(dir=os.environ['FULLMAG_TEST_TEMP_ROOT'])
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)

    def test_existing_cache_needs_no_directory_write(self):
        cache = self.root / 'cache'
        cache.mkdir()
        with patch.dict(os.environ, {'FULLMAG_FEM_MESH_CACHE_DIR': str(cache)}), patch.object(
                Path, 'mkdir', side_effect=PermissionError('readonly capture refuses mutation')):
            self.assertEqual(_fem_mesh_cache_dir(), cache)

    def test_missing_cache_is_created_for_ordinary_execution(self):
        cache = self.root / 'parent' / 'cache'
        with patch.dict(os.environ, {'FULLMAG_FEM_MESH_CACHE_DIR': str(cache)}):
            self.assertEqual(_fem_mesh_cache_dir(), cache)
        self.assertTrue(cache.is_dir())

    def test_empty_cache_setting_still_disables_cache(self):
        with patch.dict(os.environ, {'FULLMAG_FEM_MESH_CACHE_DIR': ''}):
            self.assertIsNone(_fem_mesh_cache_dir())
        self.assertEqual(list(self.root.iterdir()), [])

    def test_regular_file_is_not_accepted_as_cache_directory(self):
        cache = self.root / 'cache'
        cache.write_bytes(b'preserve')
        with patch.dict(os.environ, {'FULLMAG_FEM_MESH_CACHE_DIR': str(cache)}):
            with self.assertRaises(FileExistsError):
                _fem_mesh_cache_dir()
        self.assertEqual(cache.read_bytes(), b'preserve')


if __name__ == '__main__':
    unittest.main()
