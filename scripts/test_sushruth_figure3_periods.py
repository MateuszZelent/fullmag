"""Independent known-period and ambiguity checks for Figure 3 postprocessing."""
import math
import unittest
from pathlib import Path

from verify_sushruth_2020_figure3_periods import _pixel_events, audit_periods, crossings, sampled_events, spacings


class Figure3PeriodTests(unittest.TestCase):
    def test_known_sinusoid_has_one_full_period_per_same_kind(self):
        frequency = [i * 1e6 for i in range(121)]
        values = [math.sin(2 * math.pi * i / 20) for i in range(121)]
        values = [0.0 if abs(x) < 1e-12 else x for x in values]
        events = sampled_events(frequency, values)
        for kind in ("maxima", "minima", "rising", "falling"):
            periods = spacings(events[kind])
            self.assertGreaterEqual(len(periods), 4, kind)
            for period in periods:
                self.assertAlmostEqual(period["spacing_hz"], 20e6, delta=1e-7)
                self.assertLessEqual(period["bounds_hz"][0], 20e6)
                self.assertGreaterEqual(period["bounds_hz"][1], 20e6)

    def test_large_gap_does_not_invent_a_zero(self):
        found = crossings([0, 1, 8, 9, 10], [-1, -1, 1, 1, -1], max_gap=5)
        self.assertEqual(found["rising"], [])
        self.assertEqual(found["falling"], [[9.0, 10.0]])

    def test_zero_plateau_is_bracketed_by_certain_signs(self):
        found = crossings([0, 1, 2, 3, 4], [-1, 0, 0, 1, -1], max_gap=3)
        self.assertEqual(found["rising"], [[0.0, 3.0]])
        self.assertEqual(found["falling"], [[3.0, 4.0]])

    def test_spacing_preserves_endpoint_bounds(self):
        events = [
            {"frequency_hz": 10.0, "bounds_hz": [9.0, 11.0]},
            {"frequency_hz": 30.0, "bounds_hz": [28.0, 32.0]},
        ]
        self.assertEqual(spacings(events), [{"spacing_hz": 20.0, "bounds_hz": [17.0, 23.0]}])

    def test_known_pixel_trace_has_correct_period_and_zero_direction(self):
        import numpy as np
        image = np.full((1524, 1015, 3), 255, dtype=np.uint8)
        for x in range(285, 376):
            y = round(206 - 60 * math.cos(2 * math.pi * (x - 289) / 40))
            image[y, x] = [0, 0, 255]
        events, _ = _pixel_events(image, "S", [92, 534])
        expected = 40 * 3e9 / 442
        self.assertEqual([e["pixel_span"] for e in events["maxima"]], [[289, 289], [329, 329], [369, 369]])
        for kind in ("maxima", "minima", "rising", "falling"):
            periods = spacings(events[kind])
            self.assertTrue(periods, kind)
            for period in periods:
                self.assertAlmostEqual(period["spacing_hz"], expected, delta=1e-5)
                self.assertLessEqual(period["bounds_hz"][0], expected)
                self.assertGreaterEqual(period["bounds_hz"][1], expected)
        self.assertTrue(all(e["pixel_span"][0] > 310 for e in events["rising"]))

    def test_unknown_input_is_rejected_before_analysis(self):
        with self.assertRaisesRegex(ValueError, "identity"):
            audit_periods(Path("/dev/null"), Path("/dev/null"))


if __name__ == "__main__":
    unittest.main()
