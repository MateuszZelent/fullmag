import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from local_runner.worker_entrypoint import SCHEMA, canonical, verify_source


class EntryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / 'tree').mkdir()
        (self.root / 'tree' / 'manifest.json').write_bytes(b'actual source file')
        self.manifest = dict(schema_version=SCHEMA, source_mode='commit', resolved_commit='a' * 40,
            files=[dict(path='manifest.json', type='file', mode='100644', size=18,
                        sha256=hashlib.sha256(b'actual source file').hexdigest())],
            deleted=[], included_untracked=[], excluded=[])
        self.save()

    def save(self):
        self.manifest.pop('source_digest', None)
        self.manifest['source_digest'] = hashlib.sha256(canonical(self.manifest)).hexdigest()
        (self.root / 'manifest.json').write_text(json.dumps(self.manifest), encoding='utf-8')

    def test_real_source_manifest_filename_is_verified(self):
        self.assertEqual(self.manifest, verify_source(self.root, self.manifest['source_digest']))

    def test_tampered_file_rejected(self):
        (self.root / 'tree' / 'manifest.json').write_bytes(b'tampered')
        with self.assertRaises(ValueError):
            verify_source(self.root)

    def test_extra_file_rejected(self):
        (self.root / 'tree' / 'extra').write_bytes(b'x')
        with self.assertRaises(ValueError):
            verify_source(self.root)

    def test_extra_root_file_rejected(self):
        (self.root / 'unexpected').write_bytes(b'x')
        with self.assertRaises(ValueError):
            verify_source(self.root)

    def test_empty_extra_directory_rejected(self):
        (self.root / 'tree' / 'unexpected').mkdir()
        with self.assertRaises(ValueError):
            verify_source(self.root)

    def test_host_identity_mismatch_rejected(self):
        with self.assertRaises(ValueError):
            verify_source(self.root, 'b' * 64)

    def test_traversal_rejected_even_with_rehashed_manifest(self):
        self.manifest['files'][0]['path'] = '../manifest.json'
        self.save()
        with self.assertRaises(ValueError):
            verify_source(self.root)


if __name__ == '__main__':
    unittest.main()
