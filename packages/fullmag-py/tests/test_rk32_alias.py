from __future__ import annotations

import unittest

import fullmag as fm
import fullmag.world as flat_world


class Rk32AliasTests(unittest.TestCase):
    def tearDown(self) -> None:
        fm.reset()

    def test_model_exports_canonical_embedded_bogacki_shampine(self) -> None:
        dynamics = fm.LLG(
            integrator="rk32",
            adaptive_timestep=fm.AdaptiveTimestep(atol=1e-6, rtol=0.0),
        ).to_ir()
        self.assertEqual(dynamics["integrator"], "rk23")
        self.assertIsNone(dynamics["fixed_timestep"])
        self.assertEqual(dynamics["adaptive_timestep"]["atol"], 1e-6)

    def test_study_solver_round_trip_uses_rk23_and_preserves_error_policy(self) -> None:
        study = fm.study("rk32_alias")
        study.engine("fdm")
        study.cell(5e-9, 5e-9, 5e-9)
        body = study.geometry(fm.Box(20e-9, 10e-9, 5e-9), name="film")
        body.Ms, body.Aex, body.alpha = 800e3, 13e-12, 1.0
        body.m = fm.texture.uniform(1, 0, 0)
        study.solver(integrator="rk32", dt_initial=1e-14, max_err=1e-6)
        ir = flat_world._build_problem().to_ir(include_geometry_assets=False)
        dynamics = ir["study"]["dynamics"]
        self.assertEqual(dynamics["integrator"], "rk23")
        self.assertEqual(dynamics["adaptive_timestep"]["dt_initial"], 1e-14)
        self.assertEqual(dynamics["adaptive_timestep"]["atol"], 1e-6)
        self.assertIsNone(dynamics["fixed_timestep"])

    def test_alias_does_not_bypass_fixed_adaptive_exclusion(self) -> None:
        with self.assertRaisesRegex(ValueError, "mutually exclusive"):
            fm.LLG(
                integrator="rk32",
                fixed_timestep=1e-14,
                adaptive_timestep=fm.AdaptiveTimestep(atol=1e-6),
            )


if __name__ == "__main__":
    unittest.main()
