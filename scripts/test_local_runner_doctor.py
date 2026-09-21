import json
from pathlib import Path
import tempfile
import unittest

from local_runner.doctor import inspect_host


class DoctorTests(unittest.TestCase):
    def test_existing_gpu_job_is_reported_without_mutation(self):
        calls = []
        def docker(args):
            calls.append(args)
            if args[0] == 'info':
                return json.dumps(dict(OSType='linux', OperatingSystem='Docker Desktop', NCPU=40, MemTotal=100))
            if args[0] == 'ps':
                return 'a' * 64
            if args[0] == 'inspect':
                return json.dumps([{'Id': 'a' * 64, 'Name': '/existing-work', 'State': {'Running': True},
                    'HostConfig': {'DeviceRequests': [{'Capabilities': [['gpu']]}]}}])
            self.fail(args)
        with tempfile.TemporaryDirectory() as temp:
            result = inspect_host({'storage_root': str(Path(temp))}, call=docker)
        self.assertEqual('defer-existing-workload', result['gpu_scheduling'])
        self.assertEqual('not_assessed', result['qualification'])
        self.assertEqual(['info', 'ps', 'inspect'], [args[0] for args in calls])


if __name__ == '__main__':
    unittest.main()
