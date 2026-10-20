"""Interpreted regressions; only private files and tiny Python process fixtures."""
import hashlib
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import verify_accepted_closed_loop_runtime as probe


class ClosedLoopVerifierTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ['FULLMAG_B02_TEST_ROOT'])
        self.root = Path(self.temp.name).resolve()
        self.execution = {'attempt_id': 'attempt', 'ownership_epoch': 2}
    def tearDown(self):
        self.temp.cleanup()
    def pin(self, raw):
        path = self.root / 'input'
        path.write_bytes(raw)
        return path, hashlib.sha256(raw).hexdigest()
    def submitted(self):
        return {'run_id': 'run', 'project_id': 'project', 'submit': {'status': 201},
                'materialization': {'body': {'task_ids': ['task']}}, 'run': {'body': {'tasks': [
                    {'task_id': 'task', 'lifecycle': 'accepted', 'readiness': {'reason': 'accepted_task_awaiting_preparation'}}]}}}
    def pages(self):
        owner = {'project_id': 'project', 'run_id': 'run', 'solution_set_id': 'solution', 'revision': '1', 'manifest_digest': 'digest'}
        return [
            {'project_id': 'project', 'run_id': 'run', 'tasks': [{'task_id': 'task', 'lifecycle': 'succeeded', 'accepted_state_ref': None}]},
            {'project_id': 'project', 'run_id': 'run', 'items': [dict(owner)], 'next_cursor': None},
            dict(owner, items=[{'member_id': 'member', 'task_id': 'task', 'attempt_id': 'attempt', 'ownership_epoch': '2',
                               'execution_status': 'succeeded', 'stage_id': probe.INSPECTION_EXECUTION_ID, 'case_id': 'default'}], next_after_member_id=None),
            dict(owner, member_id='member', items=[{'artifact_id': 'artifact', 'schema_id': 'fullmag.antenna.closed_loop_bundle@v1',
                 'object_ref': 'a' * 64, 'kind': 'other', 'accepted_state': None}], next_after_artifact_id=None)]
    def public(self, pages):
        with patch.object(probe, 'get_resource', side_effect=pages):
            return probe.public_output('http://unused', 'project', 'run', 'task', self.execution)
    def test_foreign_run_and_authored_stage_refused(self):
        for page, key, value in [(0, 'run_id', 'foreign'), (0, 'project_id', 'foreign')]:
            pages = self.pages(); pages[page][key] = value
            with self.assertRaises(ValueError): self.public(pages)
        for key, value in [('stage_id', 'other'), ('case_id', 'other')]:
            pages = self.pages(); pages[2]['items'][0][key] = value
            with self.assertRaises(ValueError): self.public(pages)
    def test_budget_cannot_exceed_actual_container_limits(self):
        good = dict(cpu_millis=2000, memory_bytes=4*1024**3, gpu_memory_bytes=0, storage_bytes=1024**3)
        probe.validate_budget(good, 2*1024**3)
        for key, value in [('cpu_millis', 2001), ('memory_bytes', 4*1024**3+1), ('storage_bytes', 1024**3+1), ('gpu_memory_bytes', 1)]:
            with self.assertRaises(ValueError): probe.validate_budget(dict(good, **{key:value}), 2*1024**3)
    def test_pin_hash_and_length(self):
        path, digest = self.pin(b'abc')
        self.assertEqual(probe.fixed_bytes(path, digest, 3), b'abc')
        path.write_bytes(b'abd')
        with self.assertRaises(ValueError): probe.fixed_bytes(path, digest, 3)
    def test_oversized_input_is_refused_before_return(self):
        path, digest = self.pin(b'12345')
        with self.assertRaises(ValueError): probe.fixed_bytes(path, digest, 4)
    def test_relative_path_is_refused(self):
        with self.assertRaises(ValueError): probe.fixed_bytes(Path('relative'), 'a' * 64, 1)
    def test_alias_parent_refused(self):
        target = self.root / 'real'; target.mkdir(); (target / 'input').write_bytes(b'a')
        alias = self.root / 'alias'
        try: alias.symlink_to(target, target_is_directory=True)
        except OSError: self.skipTest('Symlink creation unavailable on this test host')
        with self.assertRaises(ValueError): probe.fixed_bytes(alias / 'input', hashlib.sha256(b'a').hexdigest(), 1)
    def test_submit_mismatch_does_not_select_task(self):
        payload = self.submitted(); self.assertEqual(probe.one_task(payload, 'run'), ('project', 'task'))
        payload['materialization']['body']['task_ids'] = ['other']
        with self.assertRaises(ValueError): probe.one_task(payload, 'run')
    def test_submit_replay_not_confused_with_first_acceptance(self):
        payload = self.submitted(); payload['submit']['status'] = 200
        with self.assertRaises(ValueError): probe.one_task(payload, 'run')
    def test_public_bundle_matches_owner_and_attempt(self):
        output, _ = self.public(self.pages()); self.assertEqual(output['object_ref'], 'a' * 64)
    def test_foreign_page_owner_refused(self):
        pages = self.pages(); pages[2]['project_id'] = 'foreign'
        with self.assertRaises(ValueError): self.public(pages)
    def test_stale_attempt_refused(self):
        pages = self.pages(); pages[2]['items'][0]['attempt_id'] = 'old'
        with self.assertRaises(ValueError): self.public(pages)
    def test_stale_epoch_refused(self):
        pages = self.pages(); pages[2]['items'][0]['ownership_epoch'] = '1'
        with self.assertRaises(ValueError): self.public(pages)
    def test_stateful_artifact_cannot_pass_raw_inspection(self):
        pages = self.pages(); pages[3]['items'][0]['accepted_state'] = {'id': 'state'}
        with self.assertRaises(ValueError): self.public(pages)
    def test_noncanonical_revision_refused(self):
        pages = self.pages(); pages[1]['items'][0]['revision'] = '01'
        with self.assertRaises(ValueError): self.public(pages)
    def test_fingerprint_detects_existing_cas_change(self):
        path = self.root / 'object'; path.write_bytes(b'abc'); before = probe.fingerprint(self.root)
        path.write_bytes(b'abd'); self.assertNotEqual(probe.fingerprint(self.root), before)
    def test_private_clone_preserves_bytes_and_rejects_existing_destination(self):
        source = self.root / 'store'; source.mkdir(); (source / 'object').write_bytes(b'CAS')
        destination = self.root / 'clone'
        with patch.object(probe.shutil, 'disk_usage', return_value=type('Usage', (), {'free': 2 * 1024**3})()):
            probe.clone_store(source, destination)
            self.assertEqual(probe.fingerprint(source), probe.fingerprint(destination))
            with self.assertRaises(ValueError): probe.clone_store(source, destination)
    def test_bounded_process_success_and_exact_pid_record(self):
        evidence = {}; checkpoints = []
        value = probe.run_process([sys.executable, '-B', '-c', 'print("{\\"ok\\":true}")'], cwd=self.root,
            env=dict(os.environ), log_path=self.root / 'process', timeout=5, evidence=evidence,
            checkpoint=lambda: checkpoints.append(True))
        self.assertEqual(value, {'ok': True}); self.assertEqual(evidence['commands'][0]['state'], 'terminal')
        self.assertGreater(evidence['commands'][0]['pid'], 0); self.assertGreaterEqual(len(checkpoints), 3)
    def test_stderr_cap_refuses_even_zero_exit(self):
        evidence = {}
        with self.assertRaises(ValueError):
            probe.run_process([sys.executable, '-B', '-c', 'import sys;sys.stderr.write("x"*1200000);print("{}")'],
                cwd=self.root, env=dict(os.environ), log_path=self.root / 'overflow', timeout=5, evidence=evidence, checkpoint=lambda: None)
        self.assertLessEqual((self.root / 'overflow.stderr.log').stat().st_size, 1024**2)


if __name__ == '__main__':
    unittest.main()
