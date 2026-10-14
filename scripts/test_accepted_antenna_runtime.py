"""Interpreted record-binding regressions, not native process qualification."""
import copy
import unittest

import accepted_antenna_runtime as runtime


def fixture():
    owner = dict(run_id='run-one', task_id='task-one', attempt_id='attempt-one',
                 ownership_epoch=7, case_id='case-one', package_object_ref='a' * 64)
    lease = {key: owner[key] for key in ('run_id', 'task_id', 'attempt_id', 'ownership_epoch')}
    lease.update(resource_id='host.cpu', lease_token='token-one', kind='cpu',
                 budget=dict(cpu_millis=100, memory_bytes=4096, gpu_memory_bytes=0, storage_bytes=4096))
    claim = {key: owner[key] for key in ('run_id', 'task_id', 'attempt_id', 'ownership_epoch')}
    claim['lease'] = {key: copy.deepcopy(lease[key]) for key in ('resource_id', 'lease_token', 'kind', 'budget')}
    claim['lease']['heartbeat_sequence'] = 0
    identity = dict(schema_version='fullmag.accepted_worker_execution.v1', claim=claim,
                    case_id=owner['case_id'], plan_fingerprint='b' * 64,
                    start_message_id='start-one', start_sequence=2)
    output = dict(port_id='inspection', data_kind='artifact',
                  codec_id='fullmag.antenna.inspection_package', codec_version='v1',
                  case_id=owner['case_id'], object_ref=owner['package_object_ref'], byte_count=1024)
    completed = dict(schema_version=identity['schema_version'], identity=identity,
                     status='completed', completed_step_count=1, outputs=[output])
    fenced = {key: owner[key] for key in ('run_id', 'task_id', 'attempt_id', 'ownership_epoch')}
    fenced['lease_token'] = lease['lease_token']
    starts = [dict(command=dict(kind='start'), claim=fenced,
                   message_id=identity['start_message_id'], sequence=identity['start_sequence'])]
    return dict(identity=copy.deepcopy(identity)), completed, owner, lease, starts


class AcceptedAntennaRuntimeTests(unittest.TestCase):
    def test_accepts_standalone_output_without_fictitious_magnetization(self):
        records = fixture()
        self.assertEqual(runtime.validate_worker_publication(*records), records[1]['outputs'][0])

    def test_rejects_foreign_attempt_publication_or_lease(self):
        for key in ('run_id', 'task_id', 'attempt_id', 'ownership_epoch', 'case_id', 'package_object_ref'):
            with self.subTest(key=key):
                started, completed, owner, lease, starts = fixture()
                owner[key] = 8 if key == 'ownership_epoch' else 'foreign'
                with self.assertRaises(ValueError):
                    runtime.validate_worker_publication(started, completed, owner, lease, starts)
        for key in ('resource_id', 'lease_token', 'kind'):
            with self.subTest(key=key):
                started, completed, owner, lease, starts = fixture()
                lease[key] = 'foreign'
                with self.assertRaises(ValueError):
                    runtime.validate_worker_publication(started, completed, owner, lease, starts)

    def test_rejects_magnetic_outputs_or_incomplete_execution(self):
        changes = [('status', 'cancelled'), ('completed_step_count', 0),
                   ('completed_step_count', True), ('completed_step_count', 2),
                   ('accepted_state_ref', {}), ('observation_source', {}), ('outputs', [])]
        for key, value in changes:
            with self.subTest(key=key, value=value):
                started, completed, owner, lease, starts = fixture()
                completed[key] = value
                with self.assertRaises(ValueError):
                    runtime.validate_worker_publication(started, completed, owner, lease, starts)
        for key, value in [('port_id', 'final_state'), ('data_kind', 'state'),
                           ('codec_id', 'fullmag.runner.field_json'), ('codec_version', 'v2'),
                           ('byte_count', True), ('byte_count', 0), ('byte_count', 4097)]:
            with self.subTest(key=key):
                started, completed, owner, lease, starts = fixture()
                completed['outputs'][0][key] = value
                with self.assertRaises(ValueError):
                    runtime.validate_worker_publication(started, completed, owner, lease, starts)

    def test_rejects_different_start_or_gpu_budget(self):
        started, completed, owner, lease, starts = fixture()
        started['identity']['start_message_id'] = 'other'
        with self.assertRaises(ValueError):
            runtime.validate_worker_publication(started, completed, owner, lease, starts)
        started, completed, owner, lease, starts = fixture()
        completed['identity']['claim']['lease']['budget']['gpu_memory_bytes'] = 1
        started['identity'] = copy.deepcopy(completed['identity'])
        with self.assertRaises(ValueError):
            runtime.validate_worker_publication(started, completed, owner, lease, starts)

    def test_rejects_missing_duplicate_or_foreign_journal_start(self):
        for change in ('missing', 'duplicate', 'message_id', 'sequence', 'claim'):
            with self.subTest(change=change):
                started, completed, owner, lease, starts = fixture()
                if change == 'missing':
                    starts.clear()
                elif change == 'duplicate':
                    starts.append(copy.deepcopy(starts[0]))
                elif change == 'claim':
                    starts[0]['claim']['attempt_id'] = 'foreign'
                else:
                    starts[0][change] = 3 if change == 'sequence' else 'foreign'
                with self.assertRaises(ValueError):
                    runtime.validate_worker_publication(started, completed, owner, lease, starts)


if __name__ == '__main__':
    unittest.main()
