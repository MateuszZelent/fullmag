"""Interpreted regressions for offline BORIS profile removal and recovery."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from local_runner import boris_transition as transition, container_client as client
from local_runner.queue import JobQueue
from test_local_runner_container_client import FakeDocker, CONTAINER_ID, IMAGE


class OfflineDocker(FakeDocker):
    def __init__(self, storage):
        super().__init__(storage)
        self.container_id = CONTAINER_ID
        self.inspection = self._inspection(running=False)
        self.inspection['State']['Status'] = 'exited'
        self.worker = None

    def __call__(self, arguments):
        if arguments == ['ps', '-a', '--no-trunc', '--format', '{{.ID}}']:
            return CONTAINER_ID + ('\n' + self.worker['Id'] if self.worker else '')
        if arguments == ['inspect', CONTAINER_ID] or arguments == ['inspect', CONTAINER_ID, 'd' * 64]:
            return json.dumps([self.inspection] + ([self.worker] if self.worker and len(arguments) == 3 else []))
        return super().__call__(arguments)


class OfflineTransitionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.layout = {'storage_root': str(self.root)}
        client.configure(self.layout, IMAGE, 'alice', enable_boris_cpu=True)
        self.catalog = {'schema': 'fullmag.runner-build-config.v1', 'operator': 'alice', 'profiles': {
            'fem-cpu-release': {'image_digest': IMAGE, 'cpus': 2, 'memory_bytes': 8589934592},
            'boris-cpu-v1': {'image_digest': 'sha256:' + 'c' * 64, 'cpus': 2, 'memory_bytes': 8589934592}}}
        self.path = self.root / 'index' / transition.NAMES[2]
        self.path.write_text(json.dumps(self.catalog) + '\n')
        self.queue = JobQueue(self.root / 'index' / 'runner-jobs.sqlite')
        self.queue.submit(owner='alice', worktree_id='wt', source_digest='a' * 64,
                          profile='fem-cpu-release', operation='build', request_key='fem', payload={})
        self.before = [self.bytes(name) for name in transition.NAMES]
        self.docker = OfflineDocker(self.root)

    def bytes(self, name):
        return (self.root / 'index' / name).read_bytes()

    def disable(self, **kwargs):
        return client.disable_boris_cpu(self.layout, 'alice', hashlib.sha256(self.before[1]).hexdigest(),
            hashlib.sha256(self.before[2]).hexdigest(), transition.entry_sha(self.catalog['profiles']['boris-cpu-v1']),
            docker_call=self.docker, **kwargs)

    def pending(self):
        return json.loads(transition._journal_path(self.root).read_bytes())

    def test_removes_only_boris_and_preserves_token_image_profiles_jobs(self):
        jobs = self.queue.list()
        result = self.disable()
        after = [json.loads(self.bytes(name)) for name in transition.NAMES]
        expected = [json.loads(value) for value in self.before]
        for value in expected[:2]: value['allowed_profiles'].remove('boris-cpu-v1')
        del expected[2]['profiles']['boris-cpu-v1']
        self.assertEqual(expected, after)
        self.assertEqual(jobs, self.queue.list())
        self.assertFalse(transition._journal_path(self.root).exists())
        self.assertNotIn('token', json.dumps(result))
        self.assertNotIn(json.loads(self.before[0])['token'], json.dumps(result))
        self.assertEqual('after', result['direction'])

    def test_public_and_catalog_cas_refuse_without_writes(self):
        for index in (1, 2):
            with self.subTest(index=index):
                path = self.root / 'index' / transition.NAMES[index]
                path.write_bytes(self.before[index] + b' ')
                with self.assertRaisesRegex(client.ContainerClientError, 'compare-and-swap'):
                    self.disable()
                path.write_bytes(self.before[index])
                self.assertFalse(transition._journal_path(self.root).exists())

    def test_boris_entry_cas_refuses(self):
        with self.assertRaises(client.ContainerClientError):
            client.disable_boris_cpu(self.layout, 'alice', hashlib.sha256(self.before[1]).hexdigest(),
                hashlib.sha256(self.before[2]).hexdigest(), '0' * 64, docker_call=self.docker)
        self.assertEqual(self.before, [self.bytes(name) for name in transition.NAMES])

    def test_unpaired_secret_refuses_without_publication(self):
        value = json.loads(self.before[0]);value['allowed_profiles'].remove('boris-cpu-v1')
        (self.root / 'index' / transition.NAMES[0]).write_text(json.dumps(value))
        with self.assertRaisesRegex(client.ContainerClientError, 'pair differs'):
            self.disable()
        self.assertFalse(transition._journal_path(self.root).exists())

    def test_running_paused_created_restart_coordinator_refuses(self):
        for state in ('running', 'paused', 'created', 'restarting'):
            with self.subTest(state=state):
                self.docker.inspection['State'].update(Status=state, Running=state != 'created')
                with self.assertRaisesRegex(client.ContainerClientError, 'exited'):
                    self.disable()
        self.assertEqual(self.before, [self.bytes(name) for name in transition.NAMES])

    def test_active_worker_refuses(self):
        self.docker.worker = {'Id': 'd' * 64, 'Name': '/fullmag-worker-private-test',
            'State': {'Status': 'running', 'Running': True}, 'Config': {'Labels': {}}}
        with self.assertRaisesRegex(client.ContainerClientError, 'active Fullmag worker'):
            self.disable()

    def test_nonterminal_boris_and_other_active_lease_refuse(self):
        boris = self.queue.submit(owner='alice', worktree_id='wt', source_digest='b' * 64,
            profile='boris-cpu-v1', operation='build', request_key='boris', payload={})
        with self.assertRaisesRegex(client.ContainerClientError, 'nonterminal BORIS'):
            self.disable()
        self.queue.cancel(boris['job_id'], 'alice')
        self.queue.claim('private-coordinator')
        with self.assertRaisesRegex(client.ContainerClientError, 'Active leases'):
            self.disable()

    def crash_after_write(self, position):
        original = transition._write_bytes
        count = 0
        def injected(path, data, **kwargs):
            nonlocal count
            original(path, data, **kwargs)
            if path.name in transition.NAMES:
                count += 1
                if count == position:
                    raise SystemExit('injected process crash')
        with patch.object(transition, '_write_bytes', side_effect=injected):
            with self.assertRaises(SystemExit):
                self.disable()
        self.assertTrue(transition._journal_path(self.root).exists())

    def test_recover_both_directions_after_each_config_write(self):
        for position in (1, 2, 3):
            for direction in ('before', 'after'):
                with self.subTest(position=position, direction=direction):
                    for name, data in zip(transition.NAMES, self.before):
                        (self.root / 'index' / name).write_bytes(data)
                    self.crash_after_write(position)
                    journal = self.pending()
                    result = client.recover_boris_profile(self.layout, 'alice', journal['transaction_id'], direction, docker_call=self.docker)
                    self.assertEqual(direction, result['direction'])
                    self.assertEqual([bytes.fromhex(item[direction]) for item in journal['files']], [self.bytes(name) for name in transition.NAMES])
                    self.assertFalse(transition._journal_path(self.root).exists())

    def test_foreign_change_blocks_recovery_and_is_preserved(self):
        self.crash_after_write(1);journal = self.pending()
        foreign = self.before[2] + b' '
        self.path.write_bytes(foreign)
        with self.assertRaisesRegex(client.ContainerClientError, 'Foreign config'):
            client.recover_boris_profile(self.layout, 'alice', journal['transaction_id'], 'before', docker_call=self.docker)
        self.assertEqual(foreign, self.path.read_bytes())
        self.assertTrue(transition._journal_path(self.root).exists())

    def test_exception_rolls_back_bytes(self):
        original = transition._write_bytes;failed = False
        def injected(path, data, **kwargs):
            nonlocal failed
            if path.name == transition.NAMES[1] and not failed:
                failed = True
                raise OSError('injected write refusal')
            original(path, data, **kwargs)
        with patch.object(transition, '_write_bytes', side_effect=injected):
            with self.assertRaises(OSError): self.disable()
        self.assertEqual(self.before, [self.bytes(name) for name in transition.NAMES])
        self.assertFalse(transition._journal_path(self.root).exists())

    def test_pending_blocks_load_config_configure_start_replace_and_build(self):
        self.crash_after_write(1)
        from local_runner import build_executor
        calls = [lambda: client._load_config(self.layout, 'alice'),
            lambda: client.configure(self.layout, IMAGE, 'alice'),
            lambda: client.start(self.layout, 'alice', docker_call=self.docker),
            lambda: client.replace(self.layout, IMAGE, 'alice', docker_call=self.docker),
            lambda: build_executor.configured_build(self.layout, 'alice', 'fem-cpu-release')]
        for call in calls:
            with self.assertRaisesRegex(client.ContainerClientError, 'explicit offline recovery'):
                call()
        with patch.object(build_executor, 'initialize'), patch.object(build_executor, 'docker'):
            with self.assertRaisesRegex(client.ContainerClientError, 'explicit offline recovery'):
                build_executor.configure_build(self.layout, 'fem-cpu-release', IMAGE, owner='alice',
                    call=lambda args: json.dumps([{'Id': IMAGE, 'Config': {}}]))

    def test_recovery_wrong_id_and_incarnation_refuses(self):
        self.crash_after_write(1);journal = self.pending()
        with self.assertRaises(client.ContainerClientError):
            client.recover_boris_profile(self.layout, 'alice', '0' * 32, 'before', docker_call=self.docker)
        self.docker.container_id = 'd' * 64
        with self.assertRaises(client.ContainerClientError):
            client.recover_boris_profile(self.layout, 'alice', journal['transaction_id'], 'before', docker_call=self.docker)


    def test_tampered_journal_cannot_change_token_or_image(self):
        self.crash_after_write(1)
        path = transition._journal_path(self.root)
        journal = self.pending()
        for index, key, replacement in ((0, 'token', 'Z' * 48), (1, 'image_id', 'sha256:' + 'e' * 64)):
            with self.subTest(key=key):
                modified = json.loads(json.dumps(journal))
                value = json.loads(bytes.fromhex(modified['files'][index]['after']))
                value[key] = replacement
                modified['files'][index]['after'] = json.dumps(value).encode().hex()
                path.write_text(json.dumps(modified))
                with self.assertRaisesRegex(client.ContainerClientError, 'outside BORIS'):
                    client.recover_boris_profile(self.layout, 'alice', journal['transaction_id'], 'after', docker_call=self.docker)
        path.write_text(json.dumps(journal))

    def test_cli_routes_disable_and_recovery_without_secret_parameters(self):
        import contextlib
        import io
        import local_runner_cli
        output = io.StringIO()
        with patch.object(local_runner_cli, 'resolve_layout', return_value=self.layout), \
             patch.object(local_runner_cli.getpass, 'getuser', return_value='alice'), \
             patch.object(client, 'disable_boris_cpu', return_value={'state': 'completed'}) as disable, \
             contextlib.redirect_stdout(output):
            code = local_runner_cli.main(['container-disable-boris-cpu', '--expected-container-sha256', 'a' * 64,
                '--expected-build-config-sha256', 'b' * 64, '--expected-boris-entry-sha256', 'c' * 64])
        self.assertEqual(0, code)
        disable.assert_called_once_with(self.layout, 'alice', 'a' * 64, 'b' * 64, 'c' * 64)
        with patch.object(local_runner_cli, 'resolve_layout', return_value=self.layout), \
             patch.object(local_runner_cli.getpass, 'getuser', return_value='alice'), \
             patch.object(client, 'recover_boris_profile', return_value={'state': 'completed'}) as recover, \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(0, local_runner_cli.main(['container-recover-boris-profile', '--transaction-id', 'd' * 32, '--direction', 'before']))
        recover.assert_called_once_with(self.layout, 'alice', 'd' * 32, 'before')


if __name__ == '__main__':
    unittest.main()