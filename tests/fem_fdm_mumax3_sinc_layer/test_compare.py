from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory


REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.analysis.compare_fdm_fem_mumax3_sinc_layer import (
    assert_no_field_snapshots,
    parse_fullmag_scalars,
    parse_mumax_table,
)


class ScalarComparisonParserTests(unittest.TestCase):
    def test_fullmag_parser_normalizes_energy_columns(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "scalars.csv"
            path.write_text(
                "step,time,mx,my,mz,E_ex,E_demag,E_ext,E_drive,E_ani,E_dmi,E_total\n"
                "1,1e-12,1,2e-3,4e-4,1e-20,2e-20,-3e-20,-4e-21,0,0,-5e-21\n",
                encoding="utf-8",
            )
            table = parse_fullmag_scalars(path)
        self.assertEqual(table.rows[0]["time_s"], 1e-12)
        self.assertEqual(table.rows[0]["mx"], 1.0)
        self.assertEqual(table.rows[0]["e_ext"], -3e-20)
        self.assertEqual(table.rows[0]["e_drive"], -4e-21)
        self.assertEqual(table.rows[0]["e_total"], -5e-21)

    def test_mumax_parser_preserves_zeeman_as_combined_external_energy(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "table.txt"
            path.write_text(
                "# t (s)\tmx ()\tmy ()\tmz ()\tE_exch (J)\tE_demag (J)\tE_zeeman (J)\tE_anis (J)\tE_total (J)\n"
                "0\t1\t0\t0\t1e-20\t2e-20\t-3e-20\t0\t0\n",
                encoding="utf-8",
            )
            table = parse_mumax_table(path)
        self.assertEqual(table.rows[0]["time_s"], 0.0)
        self.assertEqual(table.rows[0]["e_ex"], 1e-20)
        self.assertEqual(table.rows[0]["e_zeeman"], -3e-20)
        self.assertEqual(table.rows[0]["e_total"], 0.0)

    def test_mumax_parser_accepts_default_and_tableadd_magnetization_columns(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "table.txt"
            path.write_text(
                "# t (s)\tmx ()\tmy ()\tmz ()\tmx ()\tmy ()\tmz ()\tE_exch (J)\tE_demag (J)\tE_zeeman (J)\tE_anis (J)\tE_total (J)\n"
                "0\t1\t0\t0\t0.999\t0.001\t0\t1e-20\t2e-20\t-3e-20\t0\t0\n",
                encoding="utf-8",
            )
            table = parse_mumax_table(path)
        self.assertEqual(table.rows[0]["mx"], 1.0)
        self.assertEqual(table.rows[0]["my"], 0.0)
        self.assertEqual(table.rows[0]["mx__duplicate1"], 0.999)
        self.assertEqual(table.rows[0]["e_zeeman"], -3e-20)

    def test_scalar_only_zarr_bundle_is_allowed_but_magnetization_array_is_not(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "scalar_only.zarr"
            (root / "artifacts" / "fields").mkdir(parents=True)
            (root / "artifacts" / "scalars.csv").write_text("time,mx\n0,1\n", encoding="utf-8")
            assert_no_field_snapshots(root)

            (root / "artifacts" / "fields" / "m").mkdir()
            with self.assertRaises(ValueError):
                assert_no_field_snapshots(root)

    def test_parser_rejects_missing_scalar_columns_and_field_snapshots(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            bad = root / "scalars.csv"
            bad.write_text("time,mx,my\n0,1,0\n", encoding="utf-8")
            with self.assertRaises(ValueError):
                parse_fullmag_scalars(bad)

            (root / "m.npy").write_bytes(b"not a field")
            with self.assertRaises(ValueError):
                assert_no_field_snapshots(root)


if __name__ == "__main__":
    unittest.main()
