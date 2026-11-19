"""The scientific gate must execute native receipt queries under python -O."""
from pathlib import Path
import subprocess
import sys
import unittest

PROGRAM = r'''
import ctypes as ct
import math
from pathlib import Path
import sys,tempfile
from unittest.mock import patch
sys.path.insert(0,sys.argv[1])
import regional_fdm_fem_convergence as check
root=Path(sys.argv[1]).parent.parent
header=root/'native/include/fullmag_fdm.h'
text=check.abi.strip_comments(header.read_text())
status=int(sys.argv[2]);nonfinite=int(sys.argv[3]);calls=0
n=8;x=(check.np.arange(n)+.5)*check.L/n
m,h,energy,_=check.exact(x,0.)
class Function:
 def __init__(self,name):self.name=name
 def __call__(self,*args):
  global calls
  if self.name.endswith('is_available'):return 1
  if self.name.endswith('backend_create_time_policy_v2'):return 1
  if self.name.endswith('backend_last_error'):return b'fake native error'
  if self.name.endswith('backend_snapshot_stats'):
   args[1]._obj.exchange_energy_joules=math.nan if nonfinite else energy
  if self.name.endswith('backend_copy_field_f64'):
   value=m if args[1]==check.abi.enum_value(text,'FULLMAG_FDM_OBSERVABLE_M') else h
   for i,v in enumerate(value.ravel()):args[2][i]=v
  if self.name.endswith('backend_execution_receipt_v1'):
   calls+=1
   # Even status=0 lacks execution evidence and must be refused.
   return status
  return 0
class Library:
 def __getattr__(self,name):return Function(name)
paths={'fdm_lib':Path(sys.executable),'fdm_header':header,
 'fdm_receipt_layout':header.parent/'fullmag_fdm_execution_receipt_v1_layout.def',
 'fdm_receipt_values':header.parent/'fullmag_fdm_execution_receipt_v1_values.def'}
check.STEPS=0
with tempfile.TemporaryDirectory() as output,patch.object(check.ct,'CDLL',return_value=Library()):
 try:check.measure('fdm_cuda',n,paths,Path(output))
 except AssertionError:
  if calls != (0 if nonfinite else 1):raise SystemExit('receipt query was omitted or repeated')
 else:raise SystemExit('invalid receipt/nonfinite energy incorrectly qualified')
'''


class OptimizedConvergenceGateTests(unittest.TestCase):
    def test_optimized_python_refuses_native_failure_missing_cuda_and_nan(self):
        for status, nonfinite in [(1, 0), (0, 0), (0, 1)]:
            with self.subTest(status=status, nonfinite=nonfinite):
                result = subprocess.run([sys.executable, '-O', '-B', '-c', PROGRAM,
                    str(Path(__file__).resolve().parent), str(status), str(nonfinite)],
                    text=True, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr[-2000:] + result.stdout[-500:])


if __name__ == '__main__':
    unittest.main()
