"""Cooperative Ctrl+C never interrupts activation before its accepted run is known."""
from contextlib import ExitStack
import unittest
from unittest.mock import patch

import docker_dev_run_script as subject
import test_docker_dev_run_script as fixtures
from test_docker_dev_run_script import API_INSTANCE, SESSION_ID, RUN_ID, _observation


class CooperativeCancellationTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.DockerDevRunScriptTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)

    def test_cancel_before_activation_sends_neither_post_nor_stop(self):
        with ExitStack() as stack:
            self.fixture._patch_admission(stack)
            activate = self.fixture._patch_activation(stack)
            stack.enter_context(patch.object(subject, '_probe_with_retry', return_value={
                'api_instance_id': API_INSTANCE}))
            stop = stack.enter_context(patch.object(subject, '_cancel_run'))
            result = subject.run_script(self.fixture.repo, 'case.py', cancel_requested=lambda: True, output=lambda _: None)
        self.assertEqual(result['outcome'], 'interrupted_before_activation')
        self.assertEqual(result['state'], 'terminal')
        self.assertEqual(result['exit_code'], 130)
        activate.assert_not_called()
        stop.assert_not_called()

    def test_interrupt_during_post_waits_for_accepted_run_then_cancels_once(self):
        requested = False
        accepted = False
        def activate(_args):
            nonlocal requested, accepted
            requested = True
            accepted = True
            return self.fixture._activation()
        def stop(_backend, base, *_pins, **kwargs):
            self.assertTrue(accepted)
            self.assertEqual(base['run_id'], RUN_ID)
            self.assertEqual(base['session_id'], SESSION_ID)
            self.assertEqual(base['api_instance_id'], API_INSTANCE)
            return {'state': 'terminal', 'outcome': 'interrupted', 'exit_code': 130}
        with ExitStack() as stack:
            self.fixture._patch_admission(stack)
            post = self.fixture._patch_activation(stack, side_effect=activate)
            observe = stack.enter_context(patch.object(subject, '_probe_with_retry', return_value={
                'api_instance_id': API_INSTANCE}))
            cancel = stack.enter_context(patch.object(subject, '_cancel_run', side_effect=stop))
            result = subject.run_script(self.fixture.repo, 'case.py', cancel_requested=lambda: requested, output=lambda _: None)
        post.assert_called_once()
        observe.assert_called_once()  # Pin only; no ambiguous run was observed.
        cancel.assert_called_once()
        self.assertEqual(result['outcome'], 'interrupted')

    def test_callback_observation_failure_does_not_authorize_post_or_stop(self):
        def unreadable():
            raise OSError('signal state unavailable')
        for callback in (lambda: None, unreadable):
            with self.subTest(callback=callback), ExitStack() as stack:
                self.fixture._patch_admission(stack)
                post = self.fixture._patch_activation(stack)
                stack.enter_context(patch.object(subject, '_probe_with_retry', return_value={
                    'api_instance_id': API_INSTANCE}))
                cancel = stack.enter_context(patch.object(subject, '_cancel_run'))
                result = subject.run_script(self.fixture.repo, 'case.py', cancel_requested=callback, output=lambda _: None)
            self.assertEqual(result['state'], 'unknown')
            self.assertEqual(result['outcome'], 'cancel_request_unknown')
            post.assert_not_called()
            cancel.assert_not_called()

    def test_interrupt_after_progress_reaches_exact_run_stop_without_sleep(self):
        requests = iter((False, False, True))
        with ExitStack() as stack:
            self.fixture._patch_admission(stack)
            self.fixture._patch_activation(stack)
            stack.enter_context(patch.object(subject, '_probe_with_retry', side_effect=[
                {'api_instance_id': API_INSTANCE}, _observation('running')]))
            cancel = stack.enter_context(patch.object(subject, '_cancel_run', return_value={
                'state': 'terminal', 'outcome': 'interrupted', 'exit_code': 130}))
            sleep = stack.enter_context(patch.object(subject.time, 'sleep'))
            result = subject.run_script(self.fixture.repo, 'case.py', cancel_requested=lambda: next(requests), output=lambda _: None)
        self.assertEqual(cancel.call_args.args[1]['run_id'], RUN_ID)
        cancel.assert_called_once()
        sleep.assert_not_called()
        self.assertEqual(result['outcome'], 'interrupted')


if __name__ == '__main__':
    unittest.main()
