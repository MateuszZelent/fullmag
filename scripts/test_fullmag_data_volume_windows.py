"""Read-only Windows validation for the new-data-disk helper."""
import hashlib
import json
from pathlib import Path, PureWindowsPath
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
POWERSHELL = Path('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe')


@unittest.skipUnless(POWERSHELL.is_file(), 'WSL Windows PowerShell bridge')
class WindowsDataVolumePlanTests(unittest.TestCase):
    def invoke(self, *, changes=None, digest_override=None):
        with tempfile.TemporaryDirectory(prefix='fullmag-volume-test-') as directory:
            request = {
                'schema': 'fullmag.wsl-data-volume-provision.v1',
                'volume_id': 'a' * 32,
                'backing_root_windows': r'E:\git\storage',
                'backing_file_windows': r'E:\git\storage\fullmag-volume-test.vhdx',
                'backing_file_wsl': '/mnt/e/git/storage/fullmag-volume-test.vhdx',
                'capacity_bytes': 137438953472,
                'wsl_distro': 'Ubuntu2',
                'storage_root_wsl': '/home/operator/fullmag/storage',
                'result_directory_windows': str(PureWindowsPath(r'\\wsl.localhost\Ubuntu2\home\operator\fullmag\storage\migrations\data-volumes') / ('a' * 32)),
            }
            request.update(changes or {})
            path = Path(directory) / 'request.json'
            raw = (json.dumps(request, sort_keys=True) + '\n').encode()
            path.write_bytes(raw)
            windows_path = r'\\wsl.localhost\Ubuntu2' + str(path).replace('/', '\\')
            helper = r'\\wsl.localhost\Ubuntu2' + str(ROOT / 'scripts/windows/fullmag_data_volume.ps1').replace('/', '\\')
            result = subprocess.run(
                [str(POWERSHELL), '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                 '-File', helper,
                 '-Mode', 'Plan', '-RequestFile', windows_path,
                 '-RequestSha256', digest_override or hashlib.sha256(raw).hexdigest()],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30,
            )
            return result.returncode, result.stdout.decode('utf-8-sig', errors='replace'), result.stderr.decode('utf-8-sig', errors='replace')

    def test_plan_is_read_only_and_pins_one_new_image(self):
        code, output, error = self.invoke()
        self.assertEqual(code, 0, error)
        value = json.loads(output)
        self.assertEqual(value['state'], 'planned-read-only')
        self.assertFalse(value['mutated'])
        self.assertEqual(value['backing_file_windows'], r'E:\git\storage\fullmag-volume-test.vhdx')
        self.assertEqual(value['capacity_bytes'], 137438953472)
        self.assertEqual(value['allowed_image_operations'], ['create-new', 'inspect', 'attach'])

    def test_plan_rejects_hash_drift_before_any_operation(self):
        code, _, _ = self.invoke(digest_override='0' * 64)
        self.assertNotEqual(code, 0)

    def test_plan_rejects_other_parent_and_mapping_drift(self):
        for change in [
            {'backing_file_windows': r'E:\other\file.vhdx'},
            {'backing_file_wsl': '/mnt/e/other/file.vhdx'},
            {'backing_file_windows': r'E:\git\storage\..\file.vhdx'},
            {'result_directory_windows': r'E:\git\storage\result'},
            {'wsl_distro': 'Ubuntu2;Remove-Item'},
        ]:
            with self.subTest(change=change):
                code, _, _ = self.invoke(changes=change)
                self.assertNotEqual(code, 0)


if __name__ == '__main__':
    unittest.main()
