"""Tests for OerstedCylinder, TimeDependence types, and PiecewiseLinear."""

from __future__ import annotations

import unittest

from fullmag.model.energy import (
    Constant,
    OerstedCylinder,
    OerstedField,
    PiecewiseLinear,
    Pulse,
    Sinusoidal,
    ThermalNoise,
)


class TestOerstedCylinder(unittest.TestCase):
    def test_basic_construction(self) -> None:
        oe = OerstedCylinder(current=5e-3, radius=50e-9)
        self.assertAlmostEqual(oe.current, 5e-3)
        self.assertAlmostEqual(oe.radius, 50e-9)
        self.assertEqual(oe.center, (0.0, 0.0, 0.0))
        self.assertEqual(oe.axis, (0.0, 0.0, 1.0))
        self.assertIsNone(oe.time_dependence)
        self.assertEqual(oe.id, "oersted:cylinder")

    def test_custom_geometry(self) -> None:
        oe = OerstedCylinder(
            current=10e-3,
            radius=100e-9,
            center=[1e-9, 2e-9, 0],
            axis=[0, 1, 0],
        )
        self.assertEqual(oe.center, (1e-9, 2e-9, 0.0))
        self.assertEqual(oe.axis, (0.0, 1.0, 0.0))

    def test_with_constant_time_dep(self) -> None:
        oe = OerstedCylinder(
            current=5e-3,
            radius=50e-9,
            time_dependence=Constant(),
        )
        self.assertIsInstance(oe.time_dependence, Constant)

    def test_with_sinusoidal_time_dep(self) -> None:
        oe = OerstedCylinder(
            current=5e-3,
            radius=50e-9,
            time_dependence=Sinusoidal(frequency_hz=1e9),
        )
        self.assertIsInstance(oe.time_dependence, Sinusoidal)

    def test_with_pulse_time_dep(self) -> None:
        oe = OerstedCylinder(
            current=5e-3,
            radius=50e-9,
            time_dependence=Pulse(t_on=1e-9, t_off=5e-9),
        )
        self.assertIsInstance(oe.time_dependence, Pulse)

    def test_with_piecewise_linear_time_dep(self) -> None:
        pwl = PiecewiseLinear([(0.0, 0.0), (1e-9, 1.0), (5e-9, 0.5)])
        oe = OerstedCylinder(current=5e-3, radius=50e-9, time_dependence=pwl)
        self.assertIsInstance(oe.time_dependence, PiecewiseLinear)

    def test_to_ir_basic(self) -> None:
        oe = OerstedCylinder(current=5e-3, radius=50e-9)
        ir = oe.to_ir()
        self.assertEqual(ir["kind"], "oersted_cylinder")
        self.assertEqual(ir["id"], "oersted:cylinder")
        self.assertAlmostEqual(float(ir["current"]), 5e-3)  # type: ignore[arg-type]
        self.assertAlmostEqual(float(ir["radius"]), 50e-9)  # type: ignore[arg-type]

    def test_stable_ids_are_explicit_and_validated(self) -> None:
        self.assertEqual(
            OerstedCylinder(5e-3, 50e-9, id="oe:pillar").to_ir()["id"],
            "oe:pillar",
        )
        self.assertEqual(OerstedField("drive").to_ir()["id"], "oersted:drive")
        self.assertEqual(OerstedField("drive", id="oe:drive").to_ir()["id"], "oe:drive")
        with self.assertRaises(ValueError):
            OerstedCylinder(5e-3, 50e-9, id=" ")
        with self.assertRaises(ValueError):
            OerstedField("drive", id=" ")

    def test_to_ir_with_time_dep(self) -> None:
        pwl = PiecewiseLinear([(0.0, 0.0), (1e-9, 1.0)])
        oe = OerstedCylinder(current=5e-3, radius=50e-9, time_dependence=pwl)
        ir = oe.to_ir()
        self.assertIn("time_dependence", ir)
        td = ir["time_dependence"]
        self.assertEqual(td["kind"], "piecewise_linear")  # type: ignore[index]

    def test_is_frozen(self) -> None:
        oe = OerstedCylinder(current=5e-3, radius=50e-9)
        with self.assertRaises(AttributeError):
            oe.current = 1.0  # type: ignore[misc]


class TestPiecewiseLinear(unittest.TestCase):
    def test_basic_construction(self) -> None:
        pwl = PiecewiseLinear([(0.0, 0.0), (1.0, 1.0)])
        self.assertEqual(len(pwl.points), 2)
        self.assertEqual(pwl.points[0], (0.0, 0.0))
        self.assertEqual(pwl.points[1], (1.0, 1.0))

    def test_multiple_points(self) -> None:
        pwl = PiecewiseLinear([(0, 0), (1, 0.5), (2, 1.0), (3, 0.0)])
        self.assertEqual(len(pwl.points), 4)

    def test_rejects_single_point(self) -> None:
        with self.assertRaises(ValueError):
            PiecewiseLinear([(0.0, 0.0)])

    def test_rejects_empty(self) -> None:
        with self.assertRaises(ValueError):
            PiecewiseLinear([])

    def test_rejects_non_increasing_times(self) -> None:
        with self.assertRaises(ValueError):
            PiecewiseLinear([(0.0, 0.0), (1.0, 0.5), (0.5, 1.0)])

    def test_rejects_equal_times(self) -> None:
        with self.assertRaises(ValueError):
            PiecewiseLinear([(0.0, 0.0), (1.0, 0.5), (1.0, 1.0)])

    def test_to_ir(self) -> None:
        pwl = PiecewiseLinear([(0.0, 0.0), (1e-9, 1.0), (5e-9, 0.5)])
        ir = pwl.to_ir()
        self.assertEqual(ir["kind"], "piecewise_linear")
        pts = ir["points"]
        self.assertEqual(len(pts), 3)  # type: ignore[arg-type]
        self.assertAlmostEqual(pts[0][0], 0.0)  # type: ignore[index]
        self.assertAlmostEqual(pts[2][1], 0.5)  # type: ignore[index]

    def test_is_frozen(self) -> None:
        pwl = PiecewiseLinear([(0, 0), (1, 1)])
        with self.assertRaises(AttributeError):
            pwl.points = ()  # type: ignore[misc]


class TestThermalNoise(unittest.TestCase):
    def test_basic_construction(self) -> None:
        tn = ThermalNoise(temperature=300.0)
        self.assertAlmostEqual(tn.temperature, 300.0)
        self.assertIsNone(tn.seed)

    def test_with_seed(self) -> None:
        tn = ThermalNoise(temperature=300.0, seed=42)
        self.assertEqual(tn.seed, 42)

    def test_rejects_zero_temperature(self) -> None:
        with self.assertRaises(ValueError):
            ThermalNoise(temperature=0.0)

    def test_rejects_negative_temperature(self) -> None:
        with self.assertRaises(ValueError):
            ThermalNoise(temperature=-100.0)

    def test_to_ir(self) -> None:
        tn = ThermalNoise(temperature=300.0, seed=123)
        ir = tn.to_ir()
        self.assertEqual(ir["kind"], "thermal_noise")
        self.assertAlmostEqual(float(ir["temperature"]), 300.0)  # type: ignore[arg-type]
        self.assertEqual(ir["seed"], 123)

    def test_to_ir_no_seed(self) -> None:
        tn = ThermalNoise(temperature=4.2)
        ir = tn.to_ir()
        self.assertNotIn("seed", ir)


if __name__ == "__main__":
    unittest.main()
