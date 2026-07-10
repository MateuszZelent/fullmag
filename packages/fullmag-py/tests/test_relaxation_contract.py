import math
import unittest

import fullmag as fm


def _outputs():
    return [fm.SaveField("m", every=1e-12)]


class RelaxationContractTests(unittest.TestCase):
    def test_canonical_defaults_are_shared(self):
        stop = fm.RelaxStop()
        self.assertEqual(stop.torque_tolerance_apm, 1e-4)
        self.assertEqual(stop.max_steps, 50_000)

    def test_direct_minimizer_rejects_llg_dynamics(self):
        with self.assertRaisesRegex(ValueError, "does not accept dynamics"):
            fm.Relaxation(
                algorithm="projected_gradient_bb",
                dynamics=fm.LLG(integrator="rk23"),
                outputs=_outputs(),
            )

    def test_direct_minimizer_rejects_seconds_budget(self):
        with self.assertRaisesRegex(ValueError, "max_relaxation_time_s"):
            fm.Relaxation(
                algorithm="nonlinear_cg",
                stop=fm.RelaxStop(max_relaxation_time_s=1e-9),
                outputs=_outputs(),
            )

    def test_direct_minimizer_serializes_without_dynamics(self):
        study = fm.Relaxation(
            algorithm="nonlinear_cg",
            outputs=_outputs(),
        )
        payload = study.to_ir()
        self.assertNotIn("dynamics", payload)

    def test_flat_facade_rejects_conflicting_stop_scalars(self):
        cases = (
            (
                fm.RelaxStop(torque_tolerance_apm=1e-4),
                {"tol": 2e-4},
                "torque_tolerance",
            ),
            (
                fm.RelaxStop(energy_tolerance_j=1e-20),
                {"energy_tolerance": 2e-20},
                "energy_tolerance",
            ),
            (fm.RelaxStop(max_steps=10), {"max_steps": 20}, "max_steps"),
            (
                fm.RelaxStop(max_relaxation_time_s=1e-9),
                {"max_relaxation_time_s": 2e-9},
                "max_relaxation_time_s",
            ),
            (
                fm.RelaxStop(max_relaxation_time_s=1e-9),
                {"max_pseudotime_s": 2e-9},
                "max_pseudotime_s",
            ),
            (
                fm.RelaxStop(max_relaxation_time_s=1e-9),
                {"max_physical_time_s": 2e-9},
                "max_physical_time_s",
            ),
        )
        for stop, kwargs, field in cases:
            with self.subTest(field=field):
                with self.assertRaisesRegex(ValueError, "conflicts"):
                    fm.relax_stage(stop=stop, **kwargs)

    def test_flat_facade_rejects_non_integer_max_steps(self):
        for value in (1.5, True):
            with self.subTest(value=value):
                with self.assertRaises(TypeError):
                    fm.relax_stage(max_steps=value)

    def test_invalid_authored_max_steps_cannot_match_after_coercion(self):
        with self.assertRaises((TypeError, ValueError)):
            fm.relax_stage(stop=fm.RelaxStop(max_steps=1), max_steps=1.5)

    def test_flat_facade_preserves_explicit_canonical_time_none(self):
        stop = fm.RelaxStop(
            torque_tolerance_apm=None,
            energy_tolerance_j=1e-20,
            max_steps=None,
            max_relaxation_time_s=None,
        )
        spec = fm.relax_stage(stop=stop, max_relaxation_time_s=None)
        self.assertIsNone(spec.stop.max_relaxation_time_s)

        with self.assertRaisesRegex(ValueError, "max_pseudotime_s conflicts"):
            fm.relax_stage(stop=stop, max_pseudotime_s=1e-9)

    def test_direct_minimizer_facade_rejects_every_llg_control(self):
        cases = (
            {"relax_alpha": 0.5},
            {"field_refresh": fm.FieldRefreshPolicy(demag_interval_s=1e-12)},
            {"solver": "rk45"},
            {"dt": 1e-13},
            {"max_error": 1e-6},
            {"dt_min": 1e-15},
            {"dt_max": 1e-12},
            {"max_relaxation_time_s": 1e-9},
            {"max_pseudotime_s": 1e-9},
            {"max_physical_time_s": 1e-9},
        )
        for kwargs in cases:
            with self.subTest(field=next(iter(kwargs))):
                with self.assertRaises((TypeError, ValueError)):
                    fm.relax_stage(algorithm="nonlinear_cg", **kwargs)

        spec = fm.relax_stage(algorithm="nonlinear_cg")
        self.assertEqual(spec.algorithm, "nonlinear_cg")

    def test_legacy_time_alias_serializes_canonically(self):
        stop = fm.RelaxStop(max_pseudotime_s=1e-9)
        self.assertEqual(stop.max_relaxation_time_s, 1e-9)
        self.assertEqual(stop.to_ir()["max_relaxation_time_s"], 1e-9)
        self.assertNotIn("max_pseudotime_s", stop.to_ir())

    def test_conflicting_time_aliases_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "conflicts"):
            fm.RelaxStop(
                max_relaxation_time_s=1e-9,
                max_physical_time_s=2e-9,
            )

    def test_explicit_none_is_not_refilled_by_flat_facade(self):
        stop = fm.RelaxStop(
            torque_tolerance_apm=None,
            energy_tolerance_j=1e-20,
            max_steps=None,
        )
        spec = fm.relax_stage(stop=stop)
        self.assertIsNone(spec.stop.torque_tolerance_apm)
        self.assertIsNone(spec.stop.max_steps)

    def test_nonfinite_stop_values_are_rejected(self):
        for value in (math.nan, math.inf, -math.inf):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    fm.RelaxStop(torque_tolerance_apm=value)


if __name__ == "__main__":
    unittest.main()
