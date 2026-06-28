"""Unit checks for FEM demag runtime-validation acceptance helpers."""

from __future__ import annotations

import math
import sys
import tempfile
import unittest
import struct
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from helpers import (  # noqa: E402
    ValidationFailure,
    effective_demag_factor_from_energy,
    require_finite_metrics,
    require_grouped_error_improvement,
    require_grouped_sum_close,
    require_periodic_pair_continuity,
    require_solver_telemetry,
    require_relative_error_below,
    require_supercell_reference_close,
)
from periodic_airbox_validation import (  # noqa: E402
    MS,
    MU0,
    apply_periodic_airbox_mesh_policy,
    demag_energy_from_field_artifacts,
    demag_energy_stats_from_field_artifacts,
    periodic_pair_max_abs,
    periodic_scalar_pair_max_abs,
    periodic_airbox_comparison_summary,
    periodic_airbox_model_uses_lateral_pbc,
    read_scalar_field_artifact,
    read_vector_field_artifact,
    robin_periodic_seam_face_count,
    validate_sweep_improves,
    validate_periodic_airbox_artifact,
)
from telemetry_validation import read_csv_rows, validate_runtime_artifact  # noqa: E402


class DemagValidationAcceptanceTests(unittest.TestCase):
    def test_periodic_airbox_mesh_policy_uses_thin_film_and_repeated_hole_refinement(self) -> None:
        class FakeMesh:
            def __init__(self) -> None:
                self.thin_film_calls = []

            def thin_film(self, **kwargs):
                self.thin_film_calls.append(kwargs)

        class FakeRegion:
            def __init__(self) -> None:
                self.mesh_calls = []

            def mesh(self, **kwargs):
                self.mesh_calls.append(kwargs)

        class FakeBody:
            def __init__(self) -> None:
                self.mesh = FakeMesh()
                self.regions = []

            def add_region(self, name, geometry, priority):
                region = FakeRegion()
                self.regions.append((name, geometry, priority, region))
                return region

        body = FakeBody()

        apply_periodic_airbox_mesh_policy(body, hole_refinement_geometries=["hole_a", "hole_b"])

        self.assertEqual(len(body.mesh.thin_film_calls), 1)
        thin_film = body.mesh.thin_film_calls[0]
        self.assertLessEqual(thin_film["maximum_element_size"], 8.0e-9)
        self.assertLessEqual(thin_film["edge_maximum_element_size"], 4.0e-9)
        self.assertEqual(thin_film["layers"], 2)
        self.assertEqual(len(body.regions), 2)
        for index, (name, geometry, priority, region) in enumerate(body.regions):
            self.assertEqual(name, f"hole_refinement_{index}")
            self.assertEqual(geometry, f"hole_{chr(ord('a') + index)}")
            self.assertGreaterEqual(priority, 10)
            self.assertEqual(len(region.mesh_calls), 1)
            self.assertLessEqual(region.mesh_calls[0]["maximum_element_size"], 4.0e-9)

    def test_periodic_airbox_supercell_reference_uses_lateral_pbc(self) -> None:
        self.assertTrue(periodic_airbox_model_uses_lateral_pbc("primitive_periodic"))
        self.assertTrue(periodic_airbox_model_uses_lateral_pbc("supercell_reference"))
        self.assertFalse(periodic_airbox_model_uses_lateral_pbc("finite_array_diagnostic"))

    def test_effective_demag_factor_from_energy_inverts_uniform_energy(self) -> None:
        mu0 = 4.0e-7 * math.pi
        ms = 800e3
        volume = 4.0e-21
        expected_n = 1.0 / 3.0
        e_demag = 0.5 * mu0 * expected_n * ms * ms * volume

        n_eff = effective_demag_factor_from_energy(
            e_demag=e_demag,
            ms=ms,
            volume=volume,
        )

        self.assertAlmostEqual(n_eff, expected_n, places=14)

    def test_finite_metrics_reject_nan_rows(self) -> None:
        rows = [{"case": "bad", "n_rel_error": math.nan}]

        with self.assertRaisesRegex(ValidationFailure, "bad.*n_rel_error"):
            require_finite_metrics(rows, ["n_rel_error"], label_key="case")

    def test_relative_error_threshold_rejects_failure(self) -> None:
        row = {"case": "sphere", "n_rel_error": 0.051}

        with self.assertRaisesRegex(ValidationFailure, "sphere.*5.00%"):
            require_relative_error_below(
                row,
                error_key="n_rel_error",
                threshold=0.05,
                label="sphere",
            )

    def test_grouped_error_improvement_rejects_non_convergent_group(self) -> None:
        rows = [
            {"bc": "poisson_robin", "scale": 1.2, "n_rel_error": 0.08},
            {"bc": "poisson_robin", "scale": 4.0, "n_rel_error": 0.09},
        ]

        with self.assertRaisesRegex(ValidationFailure, "poisson_robin.*not convergent"):
            require_grouped_error_improvement(
                rows,
                group_key="bc",
                order_key="scale",
                error_key="n_rel_error",
            )

    def test_grouped_sum_close_rejects_missing_group_axes(self) -> None:
        rows = [
            {"shape": "prolate", "m_axis": "x", "n_effective": 0.20},
            {"shape": "prolate", "m_axis": "z", "n_effective": 0.60},
        ]

        with self.assertRaisesRegex(ValidationFailure, "prolate.*expected axes"):
            require_grouped_sum_close(
                rows,
                group_key="shape",
                value_key="n_effective",
                expected_sum=1.0,
                tolerance=0.15,
                required_axis_key="m_axis",
                required_axes=("x", "y", "z"),
            )

    def test_grouped_sum_close_rejects_bad_demag_factor_sum(self) -> None:
        rows = [
            {"shape": "oblate", "m_axis": "x", "n_effective": 0.20},
            {"shape": "oblate", "m_axis": "y", "n_effective": 0.20},
            {"shape": "oblate", "m_axis": "z", "n_effective": 0.30},
        ]

        with self.assertRaisesRegex(ValidationFailure, "oblate.*sum"):
            require_grouped_sum_close(
                rows,
                group_key="shape",
                value_key="n_effective",
                expected_sum=1.0,
                tolerance=0.15,
                required_axis_key="m_axis",
                required_axes=("x", "y", "z"),
            )

    def test_grouped_sum_close_accepts_complete_demag_factor_group(self) -> None:
        rows = [
            {"shape": "general", "m_axis": "x", "n_effective": 0.20},
            {"shape": "general", "m_axis": "y", "n_effective": 0.30},
            {"shape": "general", "m_axis": "z", "n_effective": 0.49},
        ]

        require_grouped_sum_close(
            rows,
            group_key="shape",
            value_key="n_effective",
            expected_sum=1.0,
            tolerance=0.15,
            required_axis_key="m_axis",
            required_axes=("x", "y", "z"),
        )

    def test_solver_telemetry_rejects_missing_residual(self) -> None:
        rows = [
            {
                "case": "poisson",
                "demag_linear_iterations": 4,
                "demag_linear_residual": math.nan,
                "demag_wall_time_ns": 10,
                "demag_assemble_wall_time_ns": 2,
                "demag_solve_wall_time_ns": 4,
                "demag_recover_wall_time_ns": 3,
                "demag_energy_wall_time_ns": 1,
            }
        ]

        with self.assertRaisesRegex(ValidationFailure, "poisson.*demag_linear_residual"):
            require_solver_telemetry(rows, label_key="case")

    def test_solver_telemetry_rejects_negative_iterations(self) -> None:
        rows = [
            {
                "case": "poisson",
                "demag_linear_iterations": -1,
                "demag_linear_residual": 1.0e-8,
                "demag_wall_time_ns": 10,
                "demag_assemble_wall_time_ns": 2,
                "demag_solve_wall_time_ns": 4,
                "demag_recover_wall_time_ns": 3,
                "demag_energy_wall_time_ns": 1,
            }
        ]

        with self.assertRaisesRegex(ValidationFailure, "poisson.*iterations"):
            require_solver_telemetry(rows, label_key="case")

    def test_solver_telemetry_accepts_complete_phase_timings(self) -> None:
        rows = [
            {
                "case": "poisson",
                "demag_linear_iterations": 4,
                "demag_linear_residual": 1.0e-8,
                "demag_wall_time_ns": 10,
                "demag_assemble_wall_time_ns": 2,
                "demag_solve_wall_time_ns": 4,
                "demag_recover_wall_time_ns": 3,
                "demag_energy_wall_time_ns": 1,
            }
        ]

        require_solver_telemetry(rows, label_key="case")

    def test_periodic_pair_continuity_accepts_bounded_seam_metrics(self) -> None:
        rows = [
            {
                "case": "primitive-x",
                "h_demag_pair_max_abs_Apm": 2.0e-4,
                "phi_pair_max_abs": 4.0e-12,
            }
        ]

        require_periodic_pair_continuity(
            rows,
            label_key="case",
            h_tolerance=1.0e-3,
            phi_tolerance=1.0e-11,
        )

    def test_periodic_pair_continuity_rejects_bad_h_demag_metric(self) -> None:
        rows = [
            {
                "case": "primitive-x",
                "h_demag_pair_max_abs_Apm": 2.0e-2,
                "phi_pair_max_abs": 4.0e-12,
            }
        ]

        with self.assertRaisesRegex(ValidationFailure, "primitive-x.*h_demag_pair"):
            require_periodic_pair_continuity(
                rows,
                label_key="case",
                h_tolerance=1.0e-3,
                phi_tolerance=1.0e-11,
            )

    def test_periodic_pair_continuity_rejects_bad_phi_metric(self) -> None:
        rows = [
            {
                "case": "primitive-x",
                "h_demag_pair_max_abs_Apm": 2.0e-4,
                "phi_pair_max_abs": 4.0e-9,
            }
        ]

        with self.assertRaisesRegex(ValidationFailure, "primitive-x.*phi_pair"):
            require_periodic_pair_continuity(
                rows,
                label_key="case",
                h_tolerance=1.0e-3,
                phi_tolerance=1.0e-11,
            )

    def test_supercell_reference_accepts_close_periodic_energy(self) -> None:
        rows = [
            {
                "comparison_group": "hole-film-10mt",
                "model": "primitive_periodic",
                "e_demag_J": 1.01e-18,
            },
            {
                "comparison_group": "hole-film-10mt",
                "model": "supercell_reference",
                "e_demag_J": 1.00e-18,
            },
        ]

        require_supercell_reference_close(rows, relative_tolerance=0.02)

    def test_supercell_reference_rejects_missing_reference_model(self) -> None:
        rows = [
            {
                "comparison_group": "hole-film-10mt",
                "model": "primitive_periodic",
                "e_demag_J": 1.01e-18,
            }
        ]

        with self.assertRaisesRegex(ValidationFailure, "missing required models"):
            require_supercell_reference_close(rows, relative_tolerance=0.02)

    def test_supercell_reference_rejects_high_relative_error(self) -> None:
        rows = [
            {
                "comparison_group": "hole-film-10mt",
                "model": "primitive_periodic",
                "e_demag_J": 1.20e-18,
            },
            {
                "comparison_group": "hole-film-10mt",
                "model": "supercell_reference",
                "e_demag_J": 1.00e-18,
            },
        ]

        with self.assertRaisesRegex(ValidationFailure, "relative error"):
            require_supercell_reference_close(rows, relative_tolerance=0.02)

    def test_periodic_airbox_artifact_validator_accepts_complete_rows(self) -> None:
        telemetry = {
            "demag_linear_iterations": 5,
            "demag_linear_residual": 1.0e-8,
            "demag_wall_time_ns": 10,
            "demag_assemble_wall_time_ns": 2,
            "demag_solve_wall_time_ns": 4,
            "demag_recover_wall_time_ns": 3,
            "demag_energy_wall_time_ns": 1,
        }
        rows = [
            {
                **telemetry,
                "case": "primitive-x",
                "comparison_group": "hole-film-10mt",
                "model": "primitive_periodic",
                "e_demag_J": 1.01e-18,
                "h_demag_pair_max_abs_Apm": 2.0e-4,
                "robin_periodic_seam_face_count": 0,
                "phi_pair_max_abs": 4.0e-12,
            },
            {
                **telemetry,
                "case": "supercell-x",
                "comparison_group": "hole-film-10mt",
                "model": "supercell_reference",
                "e_demag_J": 1.00e-18,
                "h_demag_pair_max_abs_Apm": 0.0,
                "robin_periodic_seam_face_count": 0,
                "phi_pair_max_abs": 0.0,
            },
        ]

        validate_periodic_airbox_artifact(rows)

    def test_periodic_airbox_artifact_validator_partial_mode_allows_missing_phi(self) -> None:
        telemetry = {
            "demag_linear_iterations": 5,
            "demag_linear_residual": 1.0e-8,
            "demag_wall_time_ns": 10,
            "demag_assemble_wall_time_ns": 2,
            "demag_solve_wall_time_ns": 4,
            "demag_recover_wall_time_ns": 3,
            "demag_energy_wall_time_ns": 1,
        }
        rows = [
            {
                **telemetry,
                "case": "primitive-x",
                "comparison_group": "hole-film-10mt",
                "model": "primitive_periodic",
                "e_demag_J": 1.01e-18,
                "h_demag_pair_max_abs_Apm": 2.0e-4,
                "robin_periodic_seam_face_count": 0,
                "phi_pair_max_abs": math.nan,
                "phi_pair_status": "not_emitted_by_runtime",
            },
            {
                **telemetry,
                "case": "supercell-x",
                "comparison_group": "hole-film-10mt",
                "model": "supercell_reference",
                "e_demag_J": 1.00e-18,
                "h_demag_pair_max_abs_Apm": 0.0,
                "robin_periodic_seam_face_count": 0,
                "phi_pair_max_abs": math.nan,
                "phi_pair_status": "not_emitted_by_runtime",
            },
        ]

        validate_periodic_airbox_artifact(rows, require_phi=False)
        with self.assertRaisesRegex(ValidationFailure, "phi_pair_max_abs"):
            validate_periodic_airbox_artifact(rows, require_phi=True)

    def test_field_artifact_loader_and_periodic_pair_metric(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "step_000002.json"
            path.write_text(
                "\n".join([
                    "{",
                    '  "observable": "H_demag",',
                    '  "values": [[1.0, 2.0, 3.0], [1.0, 2.0, 3.0005], [0.0, 0.0, 0.0]]',
                    "}",
                ])
            )

            values = read_vector_field_artifact(path)

        mismatch = periodic_pair_max_abs(
            values,
            [{"pair_id": "x_faces", "node_a": 0, "node_b": 1}],
        )
        self.assertAlmostEqual(mismatch, 5.0e-4)

    def test_field_artifact_loader_reads_component_major_zarr(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            zarr_dir = Path(tmpdir) / "H_demag.zarr"
            zarr_dir.mkdir()
            (zarr_dir / ".zarray").write_text(
                "\n".join([
                    "{",
                    '  "zarr_format": 2,',
                    '  "shape": [1, 3, 2],',
                    '  "chunks": [1, 3, 2],',
                    '  "dtype": "<f8",',
                    '  "compressor": null,',
                    '  "order": "C"',
                    "}",
                ])
            )
            (zarr_dir / "samples.csv").write_text(
                "sample,step,time,solver_dt,chunk_key,dtype,scalar_bytes,cell_count\n"
                "0,2,0.0,1e-13,0.0.0,<f8,8,2\n"
            )
            (zarr_dir / "0.0.0").write_bytes(
                struct.pack("<6d", 1.0, 2.0, 10.0, 20.0, 100.0, 200.0)
            )

            values = read_vector_field_artifact(zarr_dir)

        self.assertEqual(values, [(1.0, 10.0, 100.0), (2.0, 20.0, 200.0)])

    def test_scalar_field_artifact_loader_reads_component_major_zarr(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            zarr_dir = Path(tmpdir) / "demag_phi.zarr"
            zarr_dir.mkdir()
            (zarr_dir / ".zarray").write_text(
                "\n".join([
                    "{",
                    '  "zarr_format": 2,',
                    '  "shape": [1, 1, 3],',
                    '  "chunks": [1, 1, 3],',
                    '  "dtype": "<f8",',
                    '  "compressor": null,',
                    '  "order": "C"',
                    "}",
                ])
            )
            (zarr_dir / "samples.csv").write_text(
                "sample,step,time,solver_dt,chunk_key,dtype,scalar_bytes,cell_count\n"
                "0,2,0.0,1e-13,0.0.0,<f8,8,3\n"
            )
            (zarr_dir / "0.0.0").write_bytes(struct.pack("<3d", 1.0, 2.0, 3.0))

            values = read_scalar_field_artifact(zarr_dir)

        self.assertEqual(values, [1.0, 2.0, 3.0])
        self.assertAlmostEqual(
            periodic_scalar_pair_max_abs(
                values,
                [{"pair_id": "x_faces", "node_a": 0, "node_b": 2}],
            ),
            2.0,
        )

    def test_periodic_airbox_energy_extraction_can_select_central_cell(self) -> None:
        mesh_ir = {
            "nodes": [
                [0.0, 0.0, 0.0],
                [1.0e-9, 0.0, 0.0],
                [0.0, 1.0e-9, 0.0],
                [0.0, 0.0, 1.0e-9],
                [1.0e-7, 0.0, 0.0],
                [1.01e-7, 0.0, 0.0],
                [1.0e-7, 1.0e-9, 0.0],
                [1.0e-7, 0.0, 1.0e-9],
            ],
            "elements": [[0, 1, 2, 3], [4, 5, 6, 7]],
            "element_markers": [1, 1],
        }
        m_values = [(1.0, 0.0, 0.0)] * 8
        h_values = [(-1.0, 0.0, 0.0)] * 8
        one_tet_volume = 1.0e-27 / 6.0
        expected_one_tet = 0.5 * MU0 * MS * one_tet_volume

        central_energy = demag_energy_from_field_artifacts(
            mesh_ir,
            m_values,
            h_values,
            central_cell_only=True,
        )
        full_energy = demag_energy_from_field_artifacts(
            mesh_ir,
            m_values,
            h_values,
            central_cell_only=False,
        )

        self.assertAlmostEqual(central_energy, expected_one_tet)
        self.assertAlmostEqual(full_energy, 2.0 * expected_one_tet)

    def test_periodic_airbox_energy_stats_report_scope_geometry(self) -> None:
        mesh_ir = {
            "nodes": [
                [0.0, 0.0, 0.0],
                [1.0e-9, 0.0, 0.0],
                [0.0, 1.0e-9, 0.0],
                [0.0, 0.0, 1.0e-9],
                [1.0e-7, 0.0, 0.0],
                [1.01e-7, 0.0, 0.0],
                [1.0e-7, 1.0e-9, 0.0],
                [1.0e-7, 0.0, 1.0e-9],
            ],
            "elements": [[0, 1, 2, 3], [4, 5, 6, 7]],
            "element_markers": [1, 1],
        }
        m_values = [(1.0, 0.0, 0.0)] * 8
        h_values = [(-1.0, 0.0, 0.0)] * 8
        one_tet_volume = 1.0e-27 / 6.0

        stats = demag_energy_stats_from_field_artifacts(
            mesh_ir,
            m_values,
            h_values,
            central_cell_only=True,
        )

        self.assertAlmostEqual(stats["e_demag_J"], 0.5 * MU0 * MS * one_tet_volume)
        self.assertAlmostEqual(stats["magnetic_volume_m3"], one_tet_volume)
        self.assertEqual(stats["magnetic_element_count"], 1)
        self.assertEqual(stats["magnetic_node_count"], 4)
        self.assertEqual(stats["energy_scope"], "central_cell")

    def test_periodic_airbox_robin_seam_counter_detects_lateral_robin_faces(self) -> None:
        mesh_ir = {
            "nodes": [
                [-1.0, -1.0, 0.0],
                [-1.0, 1.0, 0.0],
                [-1.0, 0.0, 1.0],
                [1.0, -1.0, 0.0],
                [1.0, 1.0, 0.0],
                [1.0, 0.0, 1.0],
                [0.0, -1.0, -1.0],
                [0.0, 1.0, -1.0],
                [0.0, 0.0, -1.0],
            ],
            "boundary_faces": [[0, 1, 2], [3, 4, 5], [6, 7, 8]],
            "boundary_markers": [99, 100, 99],
            "periodic_boundary_pairs": [
                {"pair_id": "x_faces", "translation": [2.0, 0.0, 0.0]},
            ],
        }

        self.assertEqual(robin_periodic_seam_face_count(mesh_ir), 1)

    def test_periodic_airbox_comparison_summary_reports_relative_error(self) -> None:
        rows = [
            {
                "comparison_group": "periodic_airbox_3x3",
                "model": "primitive_periodic",
                "supercell_repetitions": 1,
                "e_demag_J": 8.0e-20,
                "h_demag_pair_max_abs_Apm": 0.0,
                "robin_periodic_seam_face_count": 0,
                "demag_linear_iterations": 13.0,
                "phi_pair_status": "not_emitted_by_runtime",
            },
            {
                "comparison_group": "periodic_airbox_3x3",
                "model": "supercell_reference",
                "supercell_repetitions": 3,
                "e_demag_J": 1.0e-19,
                "h_demag_pair_max_abs_Apm": 0.0,
                "robin_periodic_seam_face_count": 0,
                "demag_linear_iterations": 20.0,
                "phi_pair_status": "not_emitted_by_runtime",
            },
        ]

        summary = periodic_airbox_comparison_summary(rows)

        self.assertEqual(summary[0]["supercell_repetitions"], 3)
        self.assertAlmostEqual(summary[0]["relative_error"], 0.2)
        self.assertEqual(summary[0]["robin_periodic_seam_face_count"], 0.0)
        self.assertEqual(summary[0]["primitive_demag_linear_iterations"], 13.0)
        self.assertEqual(summary[0]["reference_demag_linear_iterations"], 20.0)

    def test_periodic_airbox_sweep_requires_largest_reference_to_improve(self) -> None:
        validate_sweep_improves(
            [
                {"supercell_repetitions": 3, "relative_error": 0.8},
                {"supercell_repetitions": 5, "relative_error": 0.6},
                {"supercell_repetitions": 7, "relative_error": 0.4},
            ]
        )

        with self.assertRaisesRegex(ValidationFailure, "did not improve"):
            validate_sweep_improves(
                [
                    {"supercell_repetitions": 3, "relative_error": 0.8},
                    {"supercell_repetitions": 7, "relative_error": 0.9},
                ]
            )

    def test_telemetry_artifact_validator_rejects_missing_rows(self) -> None:
        with self.assertRaisesRegex(ValidationFailure, "no demag telemetry rows"):
            validate_runtime_artifact([])

    def test_telemetry_artifact_validator_accepts_complete_rows(self) -> None:
        rows = [
            {
                "case": "poisson-robin",
                "demag_linear_iterations": 4,
                "demag_linear_residual": 1.0e-8,
                "demag_wall_time_ns": 10,
                "demag_assemble_wall_time_ns": 2,
                "demag_solve_wall_time_ns": 4,
                "demag_recover_wall_time_ns": 3,
                "demag_energy_wall_time_ns": 1,
            }
        ]

        validate_runtime_artifact(rows)

    def test_telemetry_csv_loader_parses_numeric_columns(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "demag_telemetry.csv"
            path.write_text(
                "\n".join([
                    "case,e_demag_J,h_demag_pair_max_abs_Apm,phi_pair_max_abs,"
                    "robin_periodic_seam_face_count,"
                    "demag_linear_iterations,demag_linear_residual,"
                    "demag_wall_time_ns,demag_assemble_wall_time_ns,"
                    "demag_solve_wall_time_ns,demag_recover_wall_time_ns,"
                    "demag_energy_wall_time_ns",
                    "poisson-robin,1e-18,2e-4,4e-12,0,4,1e-8,10,2,4,3,1",
                ])
                + "\n"
            )

            rows = read_csv_rows(path)

        self.assertIsInstance(rows[0]["demag_linear_iterations"], float)
        self.assertIsInstance(rows[0]["e_demag_J"], float)
        self.assertIsInstance(rows[0]["robin_periodic_seam_face_count"], float)
        validate_runtime_artifact(rows)


if __name__ == "__main__":
    unittest.main()
