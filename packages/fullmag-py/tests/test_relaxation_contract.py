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
        self.assertIsNone(payload["dynamics"])

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
