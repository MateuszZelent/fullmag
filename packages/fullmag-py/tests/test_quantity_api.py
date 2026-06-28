from __future__ import annotations

import unittest
from unittest.mock import patch

import fullmag as fm
import fullmag.world as flat_world
from fullmag.runtime.simulation import Result, StepStats, result_from_run_payload


def _step(
    *,
    step: int,
    time: float,
    e_total: float,
    mx: float = 0.0,
    my: float = 0.0,
    mz: float = 0.0,
    per_object_scalars: dict[str, dict[str, float]] | None = None,
) -> StepStats:
    return StepStats(
        step=step,
        time=time,
        dt=1e-12,
        e_ex=0.1,
        e_demag=0.2,
        e_ext=0.3,
        e_total=e_total,
        max_dm_dt=1.0,
        max_h_eff=2.0,
        wall_time_ns=1,
        mx=mx,
        my=my,
        mz=mz,
        per_object_scalars=per_object_scalars or {},
    )


def _result(*steps: StepStats) -> Result:
    return Result(
        status="completed",
        backend=fm.BackendTarget.FDM,
        mode=fm.ExecutionMode.STRICT,
        precision=fm.ExecutionPrecision.DOUBLE,
        steps=list(steps),
        final_magnetization=[[1.0, 0.0, 0.0]],
        output_dir="run_output",
    )


class QuantityApiTests(unittest.TestCase):
    def setUp(self) -> None:
        fm.reset()

    def _prepare_single_magnet(self) -> None:
        fm.engine("fdm")
        fm.cell(5e-9, 5e-9, 5e-9)
        body = fm.geometry(fm.Box(size=(20e-9, 10e-9, 5e-9), name="body"), name="body")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.01
        body.m = fm.texture.uniform(1.0, 0.0, 0.0)

    def test_result_series_and_last_support_global_and_region_scalars(self) -> None:
        result = _result(
            _step(
                step=1,
                time=1e-12,
                e_total=5.0,
                mx=0.8,
                per_object_scalars={"free": {"e_total": 2.0, "mx": 0.3}},
            ),
            _step(
                step=2,
                time=2e-12,
                e_total=3.0,
                mx=0.6,
                per_object_scalars={"free": {"e_total": 1.5, "mx": 0.2}},
            ),
        )

        self.assertEqual(result.series("E_total"), [5.0, 3.0])
        self.assertEqual(result.series("mx"), [0.8, 0.6])
        self.assertEqual(result.series("E_total", region="free"), [2.0, 1.5])
        self.assertEqual(result.last("E_total"), 3.0)
        self.assertEqual(result.last("mx", region="free"), 0.2)

    def test_quantity_handles_support_print_and_if_comparisons(self) -> None:
        flat_world._record_result(_result(_step(step=1, time=1e-12, e_total=1.25, mx=0.4, my=0.5, mz=0.6)))

        self.assertAlmostEqual(float(fm.E_total), 1.25)
        self.assertTrue(fm.E_total < 2.0)
        self.assertFalse(fm.E_total > 2.0)
        self.assertEqual(fm.m.average(), (0.4, 0.5, 0.6))
        self.assertAlmostEqual(float(fm.m.comp("x")), 0.4)
        self.assertIn("E_total=", repr(fm.E_total))

    def test_region_quantity_view_reads_per_object_scalars(self) -> None:
        flat_world._record_result(
            _result(
                _step(
                    step=1,
                    time=1e-12,
                    e_total=4.0,
                    per_object_scalars={"free": {"e_total": 1.0, "mx": 0.25}},
                )
            )
        )

        self.assertAlmostEqual(float(fm.E_total.region("free")), 1.0)
        self.assertAlmostEqual(float(fm.mx.region("free")), 0.25)

    def test_result_payload_preserves_demag_phase_telemetry(self) -> None:
        result = result_from_run_payload(
            {
                "status": "completed",
                "steps": [
                    {
                        "step": 1,
                        "time": 1.0e-12,
                        "dt": 1.0e-12,
                        "e_ex": 0.1,
                        "e_demag": 0.2,
                        "e_ext": 0.3,
                        "e_total": 0.6,
                        "max_dm_dt": 1.0,
                        "max_h_eff": 2.0,
                        "wall_time_ns": 100,
                        "demag_wall_time_ns": 70,
                        "demag_assemble_wall_time_ns": 11,
                        "demag_solve_wall_time_ns": 22,
                        "demag_solver_setup_wall_time_ns": 7,
                        "demag_solver_apply_wall_time_ns": 15,
                        "demag_solver_setup_reused": True,
                        "demag_recover_wall_time_ns": 33,
                        "demag_energy_wall_time_ns": 4,
                        "demag_solves": 1,
                        "poisson_iterations": 9,
                        "poisson_final_residual": 1.0e-8,
                        "demag_solver": "CG",
                    }
                ],
            },
            backend=fm.BackendTarget.FDM,
            mode=fm.ExecutionMode.STRICT,
            precision=fm.ExecutionPrecision.DOUBLE,
            output_dir="run_output",
        )

        step = result.steps[0]
        self.assertEqual(step.demag_wall_time_ns, 70)
        self.assertEqual(step.demag_assemble_wall_time_ns, 11)
        self.assertEqual(step.demag_solve_wall_time_ns, 22)
        self.assertEqual(step.demag_solver_setup_wall_time_ns, 7)
        self.assertEqual(step.demag_solver_apply_wall_time_ns, 15)
        self.assertTrue(step.demag_solver_setup_reused)
        self.assertEqual(step.demag_recover_wall_time_ns, 33)
        self.assertEqual(step.demag_energy_wall_time_ns, 4)
        self.assertEqual(step.demag_solves, 1)
        self.assertEqual(step.poisson_iterations, 9)
        self.assertAlmostEqual(step.poisson_final_residual, 1.0e-8)
        self.assertEqual(step.demag_solver, "CG")

    def test_run_while_requires_explicit_guard(self) -> None:
        with self.assertRaisesRegex(ValueError, "max_time or max_steps"):
            fm.run_while(True, chunk_time=1e-12)

    def test_run_while_evaluates_quantity_condition_chunk_by_chunk(self) -> None:
        self._prepare_single_magnet()

        energies = [5.0, 3.0, 1.0]
        calls: list[float] = []

        def fake_run(until: float):
            calls.append(until)
            energy = energies[min(len(calls) - 1, len(energies) - 1)]
            result = _result(_step(step=len(calls), time=float(len(calls)) * until, e_total=energy))
            flat_world._record_result(result)
            return result

        with patch("fullmag.world.run", side_effect=fake_run):
            result = fm.RunWhile(
                fm.E_total > 2.0,
                chunk_time=5e-12,
                max_time=5e-9,
            )

        self.assertEqual(len(calls), 3)
        self.assertAlmostEqual(result.last("E_total"), 1.0)

    def test_run_while_relax_mode_uses_chunked_relaxation(self) -> None:
        self._prepare_single_magnet()

        energies = [4.0, 2.0, 0.5]
        step_limits: list[int] = []

        def fake_relax(
            *,
            tol: float = 1e-6,
            max_steps: int = 50_000,
            algorithm: str = "llg_overdamped",
            energy_tolerance: float | None = None,
            relax_alpha: float | None = 1.0,
            solver: str | None = None,
            dt: float | str | None = None,
            max_error: float | None = None,
        ):
            del tol, algorithm, energy_tolerance, relax_alpha, solver, dt, max_error
            step_limits.append(max_steps)
            energy = energies[min(len(step_limits) - 1, len(energies) - 1)]
            result = _result(_step(step=len(step_limits), time=1e-12, e_total=energy))
            flat_world._record_result(result)
            return result

        with patch("fullmag.world.relax", side_effect=fake_relax):
            result = fm.RunWhile(
                fm.E_total > 1.0,
                chunk_time=2e-12,
                max_steps=100,
                relax=True,
            )

        self.assertGreaterEqual(len(step_limits), 2)
        self.assertTrue(all(limit > 0 for limit in step_limits))
        self.assertAlmostEqual(result.last("E_total"), 0.5)


if __name__ == "__main__":
    unittest.main()
