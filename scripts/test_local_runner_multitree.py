"""Real Git worktree fixture: capture identity stays isolated across edits."""
from pathlib import Path
import subprocess
import tempfile
import unittest

from local_runner.source import capture_source
from local_runner.worker_entrypoint import verify_source


class MultipleWorktreeTests(unittest.TestCase):
    def test_two_worktrees_keep_independent_immutable_snapshots(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / 'main'
            repo.mkdir()
            def git(*args):
                subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True)
            git('init', '-q')
            git('config', 'user.name', 'Runner fixture')
            git('config', 'user.email', 'runner@example.invalid')
            (repo / 'code.txt').write_bytes(b'base\n')
            git('add', 'code.txt')
            git('commit', '-qm', 'fixture')
            other = root / 'other'
            git('worktree', 'add', '--detach', str(other), 'HEAD')
            (repo / 'code.txt').write_bytes(b'worktree A\n')
            (other / 'code.txt').write_bytes(b'worktree B\n')
            first, second = root / 'capsule-a', root / 'capsule-b'
            first.mkdir()
            second.mkdir()
            a = capture_source(repo, first)
            b = capture_source(other, second)
            self.assertEqual(a['resolved_commit'], b['resolved_commit'])
            self.assertNotEqual(a['source_digest'], b['source_digest'])
            self.assertNotEqual(a['repo_root'], b['repo_root'])
            (repo / 'code.txt').write_bytes(b'edited after submit\n')
            self.assertEqual(b'worktree A\n', (first / 'tree' / 'code.txt').read_bytes())
            self.assertEqual(b'worktree B\n', (second / 'tree' / 'code.txt').read_bytes())
            verify_source(first, a['source_digest'])
            verify_source(second, b['source_digest'])


if __name__ == '__main__':
    unittest.main()
