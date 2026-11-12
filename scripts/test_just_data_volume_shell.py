"""Actual recipes dispatch as literal argv before generic storage preparation."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class DataVolumeShellTests(unittest.TestCase):
    def dispatch(self, recipe, script):
        repo = Path(__file__).resolve().parents[1]
        source = (repo/'scripts/just_storage_shell.sh').read_text()
        marker = '  *"scripts/'+script+'"*)\n'
        self.assertIn(marker, source, 'Managed stage must precede generic prepare-links')
        body = source.split(marker, 1)[1].split('\n    ;;', 1)[0]
        self.assertLess(source.index(marker), source.index('prepare_args=(--compat)'))
        with tempfile.TemporaryDirectory() as directory:
            scripts = Path(directory)/'scripts'; scripts.mkdir()
            (scripts/script).write_text('import sys; sys.stdout.buffer.write(b"\\0".join(s.encode() for s in sys.argv[1:]))\n')
            program = ('set -euo pipefail\nrecipe="$RECIPE_LITERAL"\n'
                       'python_cmd="$FIXED_PYTHON"\nscript_dir="$FIXED_SCRIPT_DIR"\n'+body)
            return subprocess.run(['/bin/bash', '--noprofile', '--norc', '-c', program],
                env={**os.environ, 'RECIPE_LITERAL': recipe, 'FIXED_PYTHON': os.sys.executable,
                     'FIXED_SCRIPT_DIR': str(scripts)}, capture_output=True, timeout=15)

    def test_linux_stage_recipes_keep_shell_characters_as_data(self):
        source = '/selected/worktree with spaces/$(printf injected);literal'
        request = '/storage/migrations/$(printf injected);literal/request.json'
        for stage, args in [('probe', [source, 'Ubuntu2']),
                            ('preflight', [source, 'Ubuntu2', request, 'a'*64]),
                            ('format', [source, 'Ubuntu2', request, 'a'*64, 'b'*64])]:
            with self.subTest(stage=stage):
                repo = Path(__file__).resolve().parents[1]
                dry = subprocess.run(['just', '--justfile', str(repo/'justfile'), '--dry-run',
                    'docker-dev-data-volume-'+stage, *args], capture_output=True, timeout=15)
                self.assertEqual(dry.returncode, 0, dry.stderr)
                recipe = dry.stderr.decode().strip()
                result = self.dispatch(recipe, 'docker_data_volume_linux.py')
                self.assertEqual(result.returncode, 0, result.stderr)
                argv = result.stdout.split(b'\0')
                self.assertEqual(argv[:5], [(stage if stage != 'format' else 'format-mount').encode(),
                                           b'--source-root', source.encode(), b'--wsl-distro', b'Ubuntu2'])
                if stage != 'probe':
                    self.assertEqual(argv[5:9], [b'--request', request.encode(), b'--request-sha256', b'a'*64])
                for tail in ('; printf injected', ' --force', ' --request bad'):
                    refused = self.dispatch(recipe+tail, 'docker_data_volume_linux.py')
                    self.assertEqual(refused.returncode, 2)
                    self.assertFalse(refused.stdout)

    def test_plan_recipe_preserves_windows_backing_path_without_preparing_storage(self):
        repo = Path(__file__).resolve().parents[1]
        args = ['/selected/checkout', '/storage/runtime-pins.json', r'E:\git\storage\new.vhdx',
                '/mnt/new-volume', 'Ubuntu2', '128']
        dry = subprocess.run(['just', '--justfile', str(repo/'justfile'), '--dry-run',
            'docker-dev-data-volume-plan', *args], capture_output=True, timeout=15)
        self.assertEqual(dry.returncode, 0, dry.stderr)
        recipe = dry.stderr.decode().strip()
        result = self.dispatch(recipe, 'docker_dev_data_volume.py')
        self.assertEqual(result.returncode, 0, result.stderr)
        argv = result.stdout.split(b'\0')
        self.assertEqual(argv, [b'plan', b'--source-root', args[0].encode(), b'--runtime-pins',
            args[1].encode(), b'--backing-file', args[2].encode(), b'--mount-root', args[3].encode(),
            b'--wsl-distro', b'Ubuntu2', b'--capacity-gib', b'128'])
        self.assertEqual(self.dispatch(recipe+'; printf injected', 'docker_dev_data_volume.py').returncode, 2)

    def test_stage_authority_cannot_be_mixed_or_omitted(self):
        base = ('python3 "/selected/scripts/docker_data_volume_linux.py" '
                "STAGE --source-root '/selected' --wsl-distro 'Ubuntu2'")
        pins = " --request '/storage/request.json' --request-sha256 '"+'a'*64+"'"
        formatter = " --formatter-sha256 '"+'b'*64+"'"
        invalid = [base.replace('STAGE', 'probe')+pins,
                   base.replace('STAGE', 'preflight'),
                   base.replace('STAGE', 'preflight')+pins+formatter,
                   base.replace('STAGE', 'format-mount')+pins,
                   base.replace('STAGE', 'erase')+pins+formatter]
        for recipe in invalid:
            with self.subTest(recipe=recipe):
                result = self.dispatch(recipe, 'docker_data_volume_linux.py')
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse(result.stdout)


if __name__ == '__main__':
    unittest.main()
