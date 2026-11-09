"""Contracts for the source-selected foreground console without Docker."""
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import Mock, patch

import fullmag_console as console


class InvocationTests(unittest.TestCase):
    def test_default_gui_and_explicit_modes(self):
        self.assertEqual(console.invocation('master', 'case.py'), console.Invocation('gui', 'master', 'case.py'))
        for mode in ('gui', 'headless'):
            self.assertEqual(console.invocation(mode, 'codex/branch', 'case.py'),
                             console.Invocation(mode, 'codex/branch', 'case.py'))

    def test_incomplete_or_ambiguous_mode_is_rejected(self):
        for args in (('headless', 'case.py'), ('gui', 'master'), ('other', 'master', 'case.py'), ('', 'case.py')):
            with self.subTest(args=args), self.assertRaises(ValueError):
                console.invocation(*args)

    def test_source_selects_exact_master_branch_or_registered_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            master, worktree = root / 'main', root / 'experiment' / 'fullmag'
            master.mkdir()
            worktree.mkdir(parents=True)
            records = [{'worktree': str(master), 'branch': 'refs/heads/master'},
                       {'worktree': str(worktree), 'branch': 'refs/heads/codex/experiment'}]
            with patch.object(console.storage, 'worktree_records', return_value=records):
                for selector, expected in (('master', master), ('codex/experiment', worktree),
                                           ('experiment', worktree), (str(worktree), worktree)):
                    with self.subTest(selector=selector):
                        self.assertEqual(console.resolve_source(master, selector), expected)

    def test_master_selection_never_switches_another_checkout(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(console.storage, 'worktree_records', return_value=[
                    {'worktree': directory, 'branch': 'refs/heads/another-branch'}]), \
                 patch.object(console.subprocess, 'run') as mutation:
                with self.assertRaisesRegex(ValueError, 'Master must have'):
                    console.resolve_source(Path(directory), 'master')
                mutation.assert_not_called()

    def test_unchecked_local_branch_gets_a_pinned_registered_source_checkout(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            master = root / 'main'
            master.mkdir()
            layout = {'worktrees_root': str(root / 'worktrees')}
            def create(command, **kwargs):
                Path(command[-2]).mkdir()
            with patch.object(console.storage, 'worktree_records', return_value=[
                    {'worktree': str(master), 'branch': 'refs/heads/master'}]), \
                 patch.object(console.storage, 'git', return_value='a' * 40) as git, \
                 patch.object(console.storage, 'resolve_layout', return_value=layout), \
                 patch.object(console.storage, 'register') as register, \
                 patch.object(console.subprocess, 'run', side_effect=create) as mutation:
                selected = console.resolve_source(master, 'codex/model')
                git.assert_called_once_with(master, 'rev-parse', '--verify', 'refs/heads/codex/model^{commit}')
                self.assertEqual(mutation.call_args.args[0][-1], 'a' * 40)
                self.assertEqual(mutation.call_args.args[0][3:6], ['worktree', 'add', '--detach'])
                self.assertTrue(selected.is_dir())
                register.assert_called_once()


    def test_generated_branch_checkout_is_reused_only_if_registered_and_unchanged(self):
        import hashlib
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            commit, reference = 'a' * 40, 'refs/heads/codex/model'
            identity = hashlib.sha256((reference + '\0' + commit).encode()).hexdigest()[:16]
            generated = root / ('console-' + identity) / 'fullmag'
            generated.mkdir(parents=True)
            records = [{'worktree': str(root), 'branch': 'refs/heads/master'},
                       {'worktree': str(generated), 'detached': True}]
            with patch.object(console.storage, 'worktree_records', return_value=records), \
                 patch.object(console.storage, 'resolve_layout', return_value={'worktrees_root': str(root)}), \
                 patch.object(console.storage, 'git', side_effect=[commit, commit, '', commit, commit, ' M changed.py']), \
                 patch.object(console.subprocess, 'run') as mutation:
                self.assertEqual(console.resolve_source(root, 'codex/model'), generated)
                with self.assertRaisesRegex(ValueError, 'changed or is unregistered'):
                    console.resolve_source(root, 'codex/model')
                mutation.assert_not_called()


class FakeRuntime:
    def __init__(self, result=None, interrupt_start=False):
        self.events = []
        self.result = result or {'state': 'terminal', 'outcome': 'completed', 'exit_code': 0}
        self.interrupt_start = interrupt_start
        self.stopping = False

    def start(self):
        self.events.append('start')
        if self.interrupt_start:
            raise KeyboardInterrupt

    def run(self):
        self.events.append('run')
        return self.result

    def output(self, value):
        self.events.append(('output', value))

    def begin_shutdown(self):
        self.stopping = True
        self.events.append('begin-shutdown')

    def shutdown(self, result=None):
        self.events.append(('shutdown', result))

    def cancel_start(self):
        self.events.append('cancel-start')

    def close_observers(self):
        self.events.append('close-observers')


class ForegroundTests(unittest.TestCase):
    def test_completed_simulation_stays_attached_until_operator_interrupt(self):
        runtime = FakeRuntime()
        waits = []
        def wait(seconds):
            waits.append(seconds)
            self.assertFalse(any(isinstance(event, tuple) and event[0] == 'shutdown' for event in runtime.events))
            raise KeyboardInterrupt
        self.assertEqual(console.execute(runtime, wait=wait), 130)
        self.assertEqual(waits, [0.25])
        self.assertIn(('shutdown', runtime.result), runtime.events)
        self.assertEqual(runtime.events[-1], 'close-observers')

    def test_failed_post_start_observation_cleans_owned_startup_before_return(self):
        runtime = FakeRuntime()
        def failed_start():
            runtime.events.append('start')
            raise ValueError('observation failed after spawn')
        runtime.start = failed_start
        with self.assertRaisesRegex(ValueError, 'observation failed'):
            console.execute(runtime)
        self.assertIn('cancel-start', runtime.events)
        self.assertEqual(runtime.events[-1], 'close-observers')

    def test_interrupt_during_start_cancels_owned_startup(self):
        runtime = FakeRuntime(interrupt_start=True)
        self.assertEqual(console.execute(runtime), 130)
        self.assertIn('cancel-start', runtime.events)
        self.assertNotIn('run', runtime.events)
        self.assertEqual(runtime.events[-1], 'close-observers')

    def test_confirmed_run_cancellation_closes_the_group_once(self):
        runtime = FakeRuntime({'state': 'terminal', 'outcome': 'interrupted', 'exit_code': 130})
        self.assertEqual(console.execute(runtime), 130)
        self.assertTrue(runtime.stopping)
        self.assertEqual([event for event in runtime.events if isinstance(event, tuple) and event[0] == 'shutdown'],
                         [('shutdown', runtime.result)])

    def test_unknown_run_identity_preserves_services_and_returns_diagnostic_failure(self):
        runtime = FakeRuntime({'state': 'unknown', 'outcome': 'run_identity_changed', 'exit_code': 75})
        self.assertEqual(console.execute(runtime), 75)
        self.assertFalse(any(isinstance(event, tuple) and event[0] == 'shutdown' for event in runtime.events))
        self.assertEqual(runtime.events[-1], 'close-observers')

    def test_failed_simulation_stays_available_for_ui_inspection_until_interrupt(self):
        runtime = FakeRuntime({'state': 'terminal', 'outcome': 'failed', 'exit_code': 1})
        def interrupt(_):
            raise KeyboardInterrupt
        self.assertEqual(console.execute(runtime, wait=interrupt), 130)
        self.assertIn(('shutdown', runtime.result), runtime.events)


if __name__ == '__main__':
    unittest.main()
