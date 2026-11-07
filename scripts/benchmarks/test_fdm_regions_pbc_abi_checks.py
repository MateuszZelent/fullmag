"""Qualification must not skip native calls or failure checks under python -O."""
from pathlib import Path
import subprocess
import sys
import unittest

PROGRAM = r'''
import ctypes as ct
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import patch
import sys
sys.path.insert(0, sys.argv[2])
import fdm_regions_pbc_abi_checks as check
status = int(sys.argv[1])
calls = 0
class Stats(ct.Structure):
    _fields_ = [('total_energy_joules', ct.c_double)]
class Grid: pass
def snapshot(*args):
    global calls
    calls += 1
    return status
@contextmanager
def backend(*args, **kwargs):
    yield object(), None
fake = SimpleNamespace(types={'fullmag_fdm_grid_desc': Grid}, stats_type=Stats,
    lib=SimpleNamespace(fullmag_fdm_backend_snapshot_stats=snapshot),
    enum=lambda name: 0, backend=backend,
    field=lambda handle, name: [[1.,0.,0.],[0.,1.,0.]] if name=='M' else [[0.,0.,0.],[0.,0.,0.]])
expected_error = RuntimeError if status else AssertionError
with patch.object(check, 'NativeFdm', return_value=fake), patch.object(check.abi, 'library_path', return_value=sys.executable):
    try:
        check.main()
    except expected_error:
        if calls != 1:
            raise SystemExit('native snapshot must execute exactly once before failure')
    else:
        raise SystemExit('qualification incorrectly passed a failed native call or wrong field/energy')
'''


class OptimizedQualificationTests(unittest.TestCase):
    def test_optimized_python_keeps_native_call_and_measurement_failures(self):
        for status in (1, 0):
            with self.subTest(native_status=status):
                result = subprocess.run([sys.executable, '-O', '-B', '-c', PROGRAM,
                    str(status), str(Path(__file__).resolve().parent)], text=True, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr[-2000:] + result.stdout[-500:])


if __name__ == '__main__':
    unittest.main()
