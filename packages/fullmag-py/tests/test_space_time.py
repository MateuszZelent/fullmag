"""One function f(x, y, z, t) split into mask and time functions (design layer L2)."""

from __future__ import annotations

import math
import unittest
from math import cos, exp, pi, sin

import fullmag as fm
from fullmag.model.mask_function import MaskFunctionError


def product(x, y, z, t, B, k, f):
    return (B * sin(k * x) * cos(2 * pi * f * t), 0.0, 0.0)


def travelling(x, y, z, t, B, k, f):
    return (B * sin(k * x - 2 * pi * f * t), 0.0, 0.0)


def with_locals(x, y, z, t, B, k, f, sigma):
    envelope = B * exp(-(y ** 2) / (2 * sigma ** 2))
    phase = k * x - 2 * pi * f * t
    return (envelope * cos(phase), 0.0, envelope * sin(phase))


def same_time(x, y, z, t, B, k, f):
    drive = cos(2 * pi * f * t)
    return (B * sin(k * x) * drive, 0.0, B * cos(k * x) * drive)


def decaying(x, y, z, t, B, s, tau):
    return (0.0, B * exp(-(x ** 2) / s ** 2 - t / tau), 0.0)


def static_plus_wave(x, y, z, t, B, k, f):
    return (B * x + B * sin(k * x) * sin(2 * pi * f * t) ** 2, 0.0, 0.0)


def moving_gaussian(x, y, z, t, B, v, s):
    return (B * exp(-((x - v * t) ** 2) / s ** 2), 0.0, 0.0)


def four_waves(x, y, z, t, B, k, f):
    wave = sin(k * x - 2 * pi * f * t)
    return (B * wave * sin(2 * k * x - 3 * f * t) * sin(3 * k * x - 5 * f * t) * sin(5 * k * x - 7 * f * t), 0.0, 0.0)


def zero(x, y, z, t, B):
    return (0.0, 0.0, 0.0)


def evaluate(function, variables: dict[str, float]) -> list[float]:
    """Outputs of a transpiled function at given variable values."""
    names = {name: getattr(math, name) for name in ("sin", "cos", "exp", "sqrt", "log", "pi")}
    names.update(variables)
    names.update({parameter.name: parameter.value for parameter in function.parameters})
    return [eval(output.replace("^", "**"), {"__builtins__": {}}, names) for output in function.outputs]


def summed(pairs, x: float, y: float, z: float, t: float) -> list[float]:
    total = [0.0, 0.0, 0.0]
    for mask, time in pairs:
        factor = 1.0 if time is None else evaluate(time, {"t": t})[0]
        for component, value in enumerate(evaluate(mask, {"x": x, "y": y, "z": z})):
            total[component] += factor * value
    return total


POINTS = [(-37e-9, 12e-9, 3e-9), (0.0, 0.0, 0.0), (18e-9, -7e-9, -2e-9), (55e-9, 20e-9, 9e-9), (91e-9, -15e-9, 0.0)]
TIMES = [0.0, 1.3e-11, 7.7e-11, 2.5e-10, 1.1e-9]


class SpaceTimeTests(unittest.TestCase):
    def assert_equals_function(self, function, pairs, **values) -> None:
        for x, y, z in POINTS:
            for t in TIMES:
                direct = function(x, y, z, t, **values)
                split = summed(pairs, x, y, z, t)
                scale = max(abs(value) for value in direct) or 1.0
                for got, want in zip(split, direct):
                    self.assertAlmostEqual(got, want, delta=1e-12 * scale + 1e-300)

    def test_product_of_space_and_time_is_one_term(self) -> None:
        values = dict(B=1e-3, k=2 * pi / 196e-9, f=4.5e9)
        pairs = fm.space_time(product, **values)
        self.assertEqual(len(pairs), 1)
        mask, time = pairs[0]
        self.assertEqual(mask.outputs[1:], ("0.0", "0.0"))
        self.assertEqual([parameter.name for parameter in mask.parameters], ["B", "k"])
        self.assertEqual([parameter.name for parameter in time.parameters], ["f"])
        self.assert_equals_function(product, pairs, **values)

    def test_travelling_wave_expands_to_two_terms(self) -> None:
        values = dict(B=1e-3, k=2 * pi / 196e-9, f=4.5e9)
        pairs = fm.space_time(travelling, **values)
        self.assertEqual(len(pairs), 2)
        self.assertEqual([time.outputs[0] for _, time in pairs], ["cos(2 * pi * f * t)", "sin(2 * pi * f * t)"])
        self.assert_equals_function(travelling, pairs, **values)

    def test_locals_are_substituted(self) -> None:
        values = dict(B=1e-3, k=2 * pi / 196e-9, f=4.5e9, sigma=30e-9)
        pairs = fm.space_time(with_locals, **values)
        self.assertEqual(len(pairs), 2)
        for mask, time in pairs:
            self.assertEqual(mask.locals, ())
            self.assertEqual(time.locals, ())
        self.assert_equals_function(with_locals, pairs, **values)

    def test_components_with_the_same_time_factor_share_a_term(self) -> None:
        values = dict(B=1e-3, k=2 * pi / 196e-9, f=4.5e9)
        pairs = fm.space_time(same_time, **values)
        self.assertEqual(len(pairs), 1)
        self.assertNotEqual(pairs[0][0].outputs[0], "0.0")
        self.assertNotEqual(pairs[0][0].outputs[2], "0.0")
        self.assert_equals_function(same_time, pairs, **values)

    def test_exp_of_a_sum_factorizes(self) -> None:
        values = dict(B=1e-3, s=40e-9, tau=2e-10)
        pairs = fm.space_time(decaying, **values)
        self.assertEqual(len(pairs), 1)
        self.assert_equals_function(decaying, pairs, **values)

    def test_static_part_and_powers(self) -> None:
        values = dict(B=1e-3, k=2 * pi / 196e-9, f=4.5e9)
        pairs = fm.space_time(static_plus_wave, **values)
        self.assertEqual(len(pairs), 2)
        self.assertIsNone(pairs[0][1])
        self.assert_equals_function(static_plus_wave, pairs, **values)

    def test_a_moving_gaussian_is_rejected_with_its_sub_expression(self) -> None:
        with self.assertRaisesRegex(MaskFunctionError, r"mask_not_separable: 'exp\(.*x - v \* t.*\)'"):
            fm.space_time(moving_gaussian, B=1e-3, v=1e3, s=40e-9)

    def test_more_than_eight_terms_are_rejected(self) -> None:
        with self.assertRaisesRegex(MaskFunctionError, "mask_too_many_terms: four_waves expands to 16 terms"):
            fm.space_time(four_waves, B=1e-3, k=2 * pi / 196e-9, f=4.5e9)

    def test_a_zero_field_and_a_missing_value_are_rejected(self) -> None:
        with self.assertRaisesRegex(MaskFunctionError, "mask_not_separable: zero returns a zero field"):
            fm.space_time(zero, B=1.0)
        with self.assertRaisesRegex(MaskFunctionError, "parameter 'f': no value"):
            fm.space_time(travelling, B=1e-3, k=1.0)

    def test_antenna_takes_the_function(self) -> None:
        fm.reset()
        self.addCleanup(fm.reset)
        study = fm.study("space-time")
        study.universe(mode="manual", size=(80e-9, 40e-9, 20e-9), center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0))
        study.cell(5e-9, 5e-9, 5e-9)
        film = study.geometry(fm.Box(size=(80e-9, 40e-9, 20e-9), name="film"), name="film")
        antenna = film.add_simpleantenna.arbitrary_mask(fm.Box(80e-9, 40e-9, 20e-9), frame="world")
        antenna.add_space_time(travelling, B=1e-3, k=2 * pi / 196e-9, f=4.5e9)
        terms = antenna.to_ir()["terms"]
        self.assertEqual(len(terms), 2)
        self.assertEqual(terms[0]["mask"]["function"]["name"], "travelling_space_1")
        self.assertEqual(terms[1]["time"]["name"], "travelling_time_2")
        self.assertNotIn("origin", terms[0])


if __name__ == "__main__":
    unittest.main()
