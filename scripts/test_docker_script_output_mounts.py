"""Interpreted regression checks for opt-in source-adjacent user outputs."""
import copy
from pathlib import Path
import tempfile
import unittest
from docker_build_control import BuildControlError
import docker_script_output_mounts as output

class OutputMountTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'examples').mkdir()
        self.doc = {'services': {'backend': {'environment': {}, 'volumes': [
            {'type': 'bind', 'source': str(self.root), 'target': '/opt/fullmag/source', 'read_only': True},
            {'type': 'volume', 'source': 'build', 'target': '/build'}]}, 'frontend': {'volumes': []}}}
    def test_alias_is_only_the_configured_child_and_preserves_build_mounts(self):
        before = copy.deepcopy(self.doc['services']['backend']['volumes'])
        output.configure(self.doc, self.root, configured='examples')
        output.validate(self.doc)
        self.assertEqual(self.doc['services']['backend']['volumes'][:2], before)
        self.assertEqual(self.doc['services']['backend']['volumes'][2]['source'], str(self.root / 'examples'))
        self.assertEqual(self.doc['services']['backend']['environment']['FULLMAG_SCRIPT_OUTPUT_SOURCE_DIR'], '/opt/fullmag/source/examples')
    def test_operator_directory_is_loaded_from_the_main_dotenv(self):
        from unittest.mock import patch
        import docker_dev_defaults
        (self.root / '.env').write_text('FULLMAG_SCRIPT_OUTPUT_DIRECTORY=examples\nIGNORED_SECRET=value\n')
        with patch.object(docker_dev_defaults, '_known_checkouts', return_value=(self.root,)), patch.dict('os.environ', {}, clear=True):
            self.assertEqual(output.selected_directory(self.root), self.root / 'examples')
        self.assertNotIn('IGNORED_SECRET', docker_dev_defaults._read_dotenv(self.root / '.env'))

    def test_no_operator_opt_in_means_no_writable_alias(self):
        before = copy.deepcopy(self.doc)
        output.configure(self.doc, self.root, configured='')
        self.assertEqual(self.doc, before)
    def test_checkout_root_and_traversal_are_refused(self):
        for directory in ['.', '..', '../outside', '/tmp', 'C:/other', '.git', '.GiT']:
            with self.subTest(directory=directory), self.assertRaises(BuildControlError):
                output.configure(copy.deepcopy(self.doc), self.root, configured=directory)
    def test_foreign_output_bind_is_rejected(self):
        output.configure(self.doc, self.root, configured='examples')
        self.doc['services']['backend']['volumes'][2]['source'] = str(self.root / 'other')
        with self.assertRaises(BuildControlError): output.validate(self.doc)
    def test_audit_allows_only_the_validated_output_mapping(self):
        import importlib.util
        file = Path(__file__).resolve().parents[1] / '.agents/skills/fullmag-docker-build/scripts/audit_build_mounts.py'
        spec = importlib.util.spec_from_file_location('output_mount_audit', file)
        audit = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(audit)
        output.configure(self.doc, self.root, configured='examples')
        self.doc['name'] = 'fullmag-test'
        problems = audit.audit(self.doc, 'fullmag-test')['problems']
        self.assertFalse(any('writable host bind at /opt/fullmag/script-output' in p for p in problems))
        self.doc['services']['backend']['volumes'][2]['source'] = str(self.root)
        problems = audit.audit(self.doc, 'fullmag-test')['problems']
        self.assertTrue(any('invalid script output mapping' in p for p in problems))
        self.assertTrue(any('writable host bind at /opt/fullmag/script-output' in p for p in problems))

    def test_source_must_stay_readonly(self):
        self.doc['services']['backend']['volumes'][0]['read_only'] = False
        with self.assertRaises(BuildControlError): output.configure(self.doc, self.root, configured='examples')
    def test_frontend_cannot_receive_output_alias(self):
        output.configure(self.doc, self.root, configured='examples')
        self.doc['services']['frontend']['volumes'].append(self.doc['services']['backend']['volumes'][2])
        with self.assertRaises(BuildControlError): output.validate(self.doc)
    def test_linked_child_is_rejected(self):
        try: (self.root / 'alias').symlink_to(self.root / 'examples', target_is_directory=True)
        except OSError: self.skipTest('host does not permit symlink creation')
        with self.assertRaises(BuildControlError): output.configure(self.doc, self.root, configured='alias')

if __name__ == '__main__': unittest.main()
