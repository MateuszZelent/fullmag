"""Fence IPC lifetime tests; no application container or filesystem mutation."""
import io
import json
import unittest
from unittest import mock
from scripts import test_data_volume_copy_fences as fixtures
from scripts.data_volume_copy_fences import hold_copy_fences

from scripts import data_volume_copy_fence_service as service


class RetentionObserved(BaseException):
    pass


class FenceProtocolTests(unittest.TestCase):
    def setUp(self):
        self.token = 'a'*32

    def command(self, **changes):
        value = {'schema':'fullmag.data-copy-fence-command.v1', 'token':self.token,
                 'action':'release', 'copy_result_sha256':'b'*64}
        value.update(changes)
        return (json.dumps(value)+'\n').encode()

    def test_release_requires_a_terminal_copy_digest_and_exact_token(self):
        output = io.StringIO()
        self.assertEqual(service.wait_for_release(io.BytesIO(self.command()), output, self.token), 'b'*64)

    def assert_retained(self, raw, *, output=None):
        output = io.StringIO() if output is None else output
        with mock.patch.object(service.time, 'sleep', side_effect=RetentionObserved), \
                self.assertRaises(RetentionObserved):
            service.wait_for_release(io.BytesIO(raw), output, self.token)
        if isinstance(output, io.StringIO):
            event = json.loads(output.getvalue())
            self.assertEqual(event['state'], 'outcome-unknown-resources-retained')

    def test_parent_eof_retains_the_fence_instead_of_returning(self):
        self.assert_retained(b'')

    def test_wrong_token_missing_digest_unknown_command_and_ambiguous_json_retain(self):
        for raw in [self.command(token='c'*32), self.command(copy_result_sha256=None),
                    self.command(action='abort'), self.command(extra=True), b'not json\n',
                    b'{"schema":"wrong","schema":"fullmag.data-copy-fence-command.v1"}\n',
                    b'x'*65537]:
            with self.subTest(raw=raw[:80]):
                self.assert_retained(raw)

    def test_broken_stdout_does_not_unwind_a_retained_fence(self):
        output = mock.Mock()
        output.write.side_effect = BrokenPipeError
        self.assert_retained(b'', output=output)

    def test_eof_retains_all_five_real_guards(self):
        fixture = fixtures.CopyFenceTests(methodName='runTest'); fixture.setUp()
        self.addCleanup(fixture.tearDown)
        authenticate, _ = fixture._authenticate(check_locked=True)
        guards = hold_copy_fences(fixture.state_root, fixture.runtime_control_root,
                                  fixture.ledger_root, authenticate=authenticate)

        def observe_retention(_delay):
            for path in fixture.paths:
                fixture._assert_locked(path)
            raise RetentionObserved

        with mock.patch.object(service.time, 'sleep', side_effect=observe_retention), \
                self.assertRaises(RetentionObserved):
            service._serve_context(guards, self.request(), io.BytesIO(b''), io.StringIO())

    def test_terminal_ack_releases_only_after_second_authentication(self):
        fixture = fixtures.CopyFenceTests(methodName='runTest'); fixture.setUp()
        self.addCleanup(fixture.tearDown)
        authenticate, calls = fixture._authenticate(check_locked=True)
        output = io.StringIO()
        guards = hold_copy_fences(fixture.state_root, fixture.runtime_control_root,
                                  fixture.ledger_root, authenticate=authenticate)
        service._serve_context(guards, self.request(), io.BytesIO(self.command()), output)
        self.assertEqual(calls, [1,2])
        self.assertEqual([json.loads(line)['state'] for line in output.getvalue().splitlines()], ['held','released'])
        for path in fixture.paths:
            fixture._assert_lockable(path)

    def test_source_request_rejects_null_pins_extra_fields_and_wrong_inode_types(self):
        request = self.request()
        self.assertEqual(service.validate_request(request), request)
        for mutate in [lambda v:v.update(token='0'*32),
                       lambda v:v.update(process_receipt_sha256=None),
                       lambda v:v.update(extra=True),
                       lambda v:v['source_roots']['state'].update(inode=True),
                       lambda v:v['components'].pop('data_volume_copy_fences.py')]:
            value = self.request(); mutate(value)
            with self.assertRaises(ValueError):
                service.validate_request(value)

    def request(self):
        return {'schema':'fullmag.data-copy-fence-request.v1', 'token':self.token,
                'volume_id':'d'*32, 'process_receipt_sha256':'e'*64,
                'source_roots':{'state':{'device':2128,'inode':97725},
                                'user_data':{'device':2128,'inode':1216773}},
                'components':{name:'f'*64 for name in service.COMPONENTS}}


if __name__ == '__main__':
    unittest.main()
