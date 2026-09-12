from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory


REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.analysis.compare_fdm_fem_mumax3_sinc_layer import (
    _build_parser,
    assert_no_field_snapshots,
    compare_tables,
    load_lane_stage,
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

    def test_fullmag_external_energy_uses_e_ext_once(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "scalars.csv"
            path.write_text(
                "step,time,mx,my,mz,E_ex,E_demag,E_ext,E_drive,E_ani,E_dmi,E_total\n"
                "1,0,1,0,0,1e-20,2e-20,-3e-20,-4e-21,0,0,-1e-20\n",
                encoding="utf-8",
            )
            table = parse_fullmag_scalars(path)
            comparison = compare_tables({"fdm": table, "fem": table})

        row = comparison["aligned_rows"][0]
        self.assertEqual(row["fdm_e_external_total"], -3e-20)
        self.assertEqual(comparison["mapping"]["fullmag_e_ext"], "Fullmag e_ext (bias + drive)")

    def test_cli_allows_fdm_mumax3_comparison_without_fem(self) -> None:
        args = _build_parser().parse_args([
            "--fdm",
            "fdm-table.csv",
            "--mumax",
            "mumax-table.txt",
            "--verify-only",
        ])
        self.assertIsNone(args.fem)

    def test_cli_accepts_all_cpu_gpu_solver_lanes(self) -> None:
        args = _build_parser().parse_args([
            "--fdm",
            "fdm-cpu.csv",
            "--fdm-gpu",
            "fdm-gpu.csv",
            "--fem",
            "fem-cpu.csv",
            "--fem-gpu",
            "fem-gpu.csv",
            "--mumax",
            "mumax.txt",
            "--verify-only",
        ])
        self.assertEqual(args.fdm_gpu, Path("fdm-gpu.csv"))
        self.assertEqual(args.fem, Path("fem-cpu.csv"))
        self.assertEqual(args.fem_gpu, Path("fem-gpu.csv"))

    def test_cli_accepts_named_poisson_robin_and_fredkin_koehler_lanes(self) -> None:
        args = _build_parser().parse_args([
            "--fdm", "fdm-cpu.csv",
            "--fdm-gpu", "fdm-gpu.csv",
            "--fem-pr-cpu", "fem-pr-cpu.zarr",
            "--fem-pr-gpu", "fem-pr-gpu.zarr",
            "--fem-fk-cpu", "fem-fk-cpu.zarr",
            "--fem-fk-gpu", "fem-fk-gpu.zarr",
            "--mumax", "mumax.txt",
            "--verify-only",
        ])
        self.assertEqual(args.fem_pr_cpu, Path("fem-pr-cpu.zarr"))
        self.assertEqual(args.fem_pr_gpu, Path("fem-pr-gpu.zarr"))
        self.assertEqual(args.fem_fk_cpu, Path("fem-fk-cpu.zarr"))
        self.assertEqual(args.fem_fk_gpu, Path("fem-fk-gpu.zarr"))

    def test_cli_can_require_passed_fem_fk_qualification_reports(self) -> None:
        args = _build_parser().parse_args([
            "--fdm", "fdm-cpu.csv",
            "--fem-fk-cpu", "fem-fk-cpu.zarr",
            "--fem-fk-gpu", "fem-fk-gpu.zarr",
            "--mumax", "mumax.txt",
            "--require-qualified-fk",
            "--verify-only",
        ])
        self.assertTrue(args.require_qualified_fk)

    def test_bundle_loader_separates_relaxation_and_dynamic_tables(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "fem-pr-cpu.zarr"
            relaxation = root / "artifacts" / "tables" / "relaxation" / "table.csv"
            dynamic = root / "artifacts" / "tables" / "default" / "table.csv"
            relaxation.parent.mkdir(parents=True)
            dynamic.parent.mkdir(parents=True)
            header = "step,time,mx,my,mz,E_ex,E_demag,E_ext,E_drive,E_ani,E_dmi,E_total\n"
            relaxation.write_text(
                header + "0,0,1,0,0,1e-20,2e-20,-3e-20,0,0,0,-1e-20\n"
                "4,2e-12,.99,1e-3,0,1e-20,2e-20,-3e-20,0,0,0,-1e-20\n",
                encoding="utf-8",
            )
            dynamic.write_text(
                header + "0,0,.99,1e-3,0,1e-20,2e-20,-3e-20,0,0,0,-1e-20\n"
                "5,4e-9,.98,2e-3,0,1e-20,2e-20,-3e-20,0,0,0,-1e-20\n",
                encoding="utf-8",
            )

            static = load_lane_stage(root, "fem_pr_cpu", "relaxation")
            dynamic_table = load_lane_stage(root, "fem_pr_cpu", "dynamic")

        self.assertEqual(len(static.rows), 2)
        self.assertEqual(static.last_time_s, 2e-12)
        self.assertEqual(len(dynamic_table.rows), 2)
        self.assertEqual(dynamic_table.last_time_s, 4e-9)

    def test_multi_lane_cli_uses_stable_backend_ids(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            fullmag = (
                "step,time,mx,my,mz,E_ex,E_demag,E_ext,E_drive,E_ani,E_dmi,E_total\n"
                "0,0,1,0,0,1e-20,2e-20,-3e-20,0,0,0,-1e-20\n"
            )
            paths = {}
            for lane in ("fdm-cpu", "fdm-gpu", "fem-cpu", "fem-gpu"):
                paths[lane] = root / f"{lane}.csv"
                paths[lane].write_text(fullmag, encoding="utf-8")
            mumax = root / "mumax.txt"
            mumax.write_text(
                "# t (s)\tmx ()\tmy ()\tmz ()\tE_exch (J)\tE_demag (J)\tE_zeeman (J)\tE_anis (J)\tE_total (J)\n"
                "0\t1\t0\t0\t1e-20\t2e-20\t-3e-20\t0\t-1e-20\n",
                encoding="utf-8",
            )
            from contextlib import redirect_stdout
            from io import StringIO
            from scripts.analysis.compare_fdm_fem_mumax3_sinc_layer import main

            output = StringIO()
            with redirect_stdout(output):
                exit_code = main([
                    "--fdm", str(paths["fdm-cpu"]),
                    "--fdm-gpu", str(paths["fdm-gpu"]),
                    "--fem", str(paths["fem-cpu"]),
                    "--fem-gpu", str(paths["fem-gpu"]),
                    "--mumax", str(mumax),
                    "--verify-only",
                ])

        self.assertEqual(exit_code, 0)
        payload = __import__("json").loads(output.getvalue())
        self.assertEqual(payload["reference_backend"], "fdm_cpu")
        self.assertIn("fdm_cpu_vs_mumax3", payload["pair_metrics"])
        self.assertIn("fem_gpu_vs_mumax3", payload["pair_metrics"])

    def test_row_alignment_compares_relaxation_endpoints_with_duplicate_times(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            fdm_path = root / "fdm.csv"
            fdm_path.write_text(
                "step,time,mx,my,mz,E_ex,E_demag,E_ext,E_drive,E_ani,E_dmi,E_total\n"
                "0,0,1,0,0,0,2e-20,-3e-20,0,0,0,-1e-20\n"
                "10,0,0.99,1e-6,2e-6,1e-21,1.9e-20,-2.9e-20,0,0,0,-9e-21\n",
                encoding="utf-8",
            )
            mumax_path = root / "mumax.txt"
            mumax_path.write_text(
                "# t (s)\tmx ()\tmy ()\tmz ()\tE_exch (J)\tE_demag (J)\tE_zeeman (J)\tE_anis (J)\tE_total (J)\n"
                "0\t1\t0\t0\t0\t2e-20\t-3e-20\t0\t-1e-20\n"
                "0\t0.991\t2e-6\t3e-6\t2e-21\t1.8e-20\t-2.8e-20\t0\t-8e-21\n",
                encoding="utf-8",
            )
            comparison = compare_tables(
                {
                    "fdm": parse_fullmag_scalars(fdm_path),
                    "mumax3": parse_mumax_table(mumax_path),
                },
                alignment="row",
            )

        self.assertEqual(comparison["alignment"], "row")
        self.assertEqual(comparison["grid_rows"], 2)
        self.assertEqual(comparison["aligned_rows"][-1]["fdm_mx"], 0.99)
        self.assertEqual(comparison["aligned_rows"][-1]["mumax3_mx"], 0.991)
        self.assertAlmostEqual(
            comparison["pair_metrics"]["fdm_vs_mumax3"]["mx"]["final_abs"],
            0.001,
        )


if __name__ == "__main__":
    unittest.main()
