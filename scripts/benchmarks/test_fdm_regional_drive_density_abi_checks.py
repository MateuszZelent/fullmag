"""Guard native scientific qualification against optimized and nonfinite false passes."""
import ast
from pathlib import Path
import subprocess
import sys
import unittest

ORACLE = Path(__file__).with_name('fdm_regional_drive_density_abi_checks.py')


class DensityOracleGuards(unittest.TestCase):
    def test_native_snapshot_is_checked_with_and_without_optimization(self):
        program = r'''
import ctypes as ct
import importlib.util
import sys
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location('density_oracle', sys.argv[1])
oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oracle)
class Stats(ct.Structure):
    _fields_ = [('total_energy_joules', ct.c_double)]
calls = []
def snapshot(handle, target):
    calls.append(handle)
    ct.cast(target, ct.POINTER(Stats)).contents.total_energy_joules = value
    return status
native = SimpleNamespace(stats_type=Stats, lib=SimpleNamespace(fullmag_fdm_backend_snapshot_stats=snapshot))
for status, value, expected in [(0, 3.0, None), (7, 3.0, RuntimeError), (0, float('nan'), ValueError), (0, float('inf'), ValueError), (0, float('-inf'), ValueError)]:
    before = len(calls)
    try:
        result = oracle.snapshot_total_energy(native, 123)
    except Exception as error:
        if expected is None or not isinstance(error, expected):
            raise
    else:
        if expected is not None or result != 3.0:
            raise RuntimeError('invalid native snapshot passed')
    if len(calls) != before + 1:
        raise RuntimeError('native snapshot was skipped or replayed')
'''
        for flags in ([], ['-O']):
            with self.subTest(flags=flags):
                result = subprocess.run([sys.executable, *flags, '-B', '-c', program, str(ORACLE)], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_qualification_has_no_optimization_sensitive_assertions(self):
        self.assertFalse(any(isinstance(node, ast.Assert) for node in ast.walk(ast.parse(ORACLE.read_text()))))


if __name__ == '__main__':
    unittest.main()
