import math
import unittest
import csv
from pathlib import Path
from tempfile import TemporaryDirectory
from compare_de_100nm_pilot import compare_branch, reference, read_modes, finite_airbox_gamma_hz

class ComparisonTests(unittest.TestCase):
    def test_csv_requires_complete_finite_de_sampling(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "dispersion.csv"
            rows = [dict(sample_index=i, raw_mode_index=0, branch_id=2,
                         kx_rad_per_m=0, ky_rad_per_m=k*1e6, kz_rad_per_m=0,
                         frequency_hz=reference(k*1e6), residual_norm=1e-9)
                    for i,k in enumerate(range(-40,41,10))]
            def write():
                with path.open("w", newline="") as stream:
                    writer=csv.DictWriter(stream,fieldnames=list(rows[0]))
                    writer.writeheader();writer.writerows(rows)
            write()
            self.assertEqual(len(read_modes(path)),9)
            rows[0]["frequency_hz"] = float("nan")
            write()
            with self.assertRaises(ValueError):
                read_modes(path)
            rows[0]["frequency_hz"] = reference(-40e6)
            rows.pop()
            write()
            with self.assertRaises(ValueError):
                read_modes(path)

    def test_finite_airbox_control_is_distinct_and_converges(self):
        finite = finite_airbox_gamma_hz()
        self.assertAlmostEqual(finite/1e9,9.205971992409074,places=9)
        self.assertLess(finite,finite_airbox_gamma_hz(4e-6))
        self.assertLess(finite_airbox_gamma_hz(4e-6),reference(0))
        self.assertAlmostEqual(finite_airbox_gamma_hz(1.0)/reference(0),1.0,places=7)

    def test_gamma_and_reciprocity(self):
        expected=221100/(2*math.pi)*math.sqrt((.1/(4e-7*math.pi))*(.1/(4e-7*math.pi)+800000))
        self.assertAlmostEqual(reference(0),expected,places=4)
        self.assertEqual(reference(-40e6),reference(40e6))

    def test_no_automatic_branch_substitution(self):
        rows=[dict(branch_id=4,ky_rad_per_m=k*1e6,frequency_hz=reference(k*1e6)) for k in range(-40,41,10)]
        with self.assertRaises(ValueError):
            compare_branch(rows,3)
        self.assertEqual(len(compare_branch(rows,4)),9)

    def test_partial_branch_is_rejected(self):
        with self.assertRaises(ValueError):
            compare_branch([dict(branch_id=4,ky_rad_per_m=0,frequency_hz=reference(0))],4)

if __name__ == "__main__":
    unittest.main()
