"""Tests for spin-torque dataclasses and their IR serialisation."""

from __future__ import annotations

import unittest

import fullmag as fm

from fullmag.model.spin_torque import (
    DriftDiffusionSpinTorque,
    InterfaceCppSTT,
    SlonczewskiSTT,
    SpinOrbitTorque,
    SpinTorque,
    RegionRef,
    ZhangLiSTT,
)


class TestSlonczewskiSTT(unittest.TestCase):
    # ── construction ────────────────────────────────────────────
    def test_basic_construction(self) -> None:
        stt = SlonczewskiSTT(
            current_density=[0.0, 0.0, 5e10],
            spin_polarization=[0.0, 0.0, 1.0],
        )
        self.assertEqual(stt.current_density, (0.0, 0.0, 5e10))
        self.assertEqual(stt.spin_polarization, (0.0, 0.0, 1.0))
        self.assertAlmostEqual(stt.degree, 0.4)
        self.assertAlmostEqual(stt.lambda_asymmetry, 1.0)
        self.assertAlmostEqual(stt.epsilon_prime, 0.0)

    def test_custom_parameters(self) -> None:
        stt = SlonczewskiSTT(
            current_density=[1e11, 0, 0],
            spin_polarization=[1, 0, 0],
            degree=0.7,
            lambda_asymmetry=2.0,
            epsilon_prime=0.01,
        )
        self.assertAlmostEqual(stt.degree, 0.7)
        self.assertAlmostEqual(stt.lambda_asymmetry, 2.0)
        self.assertAlmostEqual(stt.epsilon_prime, 0.01)

    def test_is_frozen(self) -> None:
        stt = SlonczewskiSTT([0, 0, 1e10], [0, 0, 1])
        with self.assertRaises(AttributeError):
            stt.degree = 0.5  # type: ignore[misc]

    def test_time_expression_preserves_current_scale_and_authored_constants(self) -> None:
        drive = fm.TimeExpression(
            "heaviside(t-on) * sin(2*pi*f*t)",
            constants={"f": 4e9, "on": 70e-9},
            event_times_s=(70e-9,),
        )
        stt = fm.SlonczewskiSTT(
            current_density=(0, 0, -2.6e10),
            id="torque",
            target=fm.RegionRef("film"),
            stack_normal=(0, 0, 1),
            free_layer_thickness_m=1.7e-9,
            time_expression=drive,
        )
        payload = stt.to_ir_module()
        self.assertEqual(payload["current_density"], [0.0, 0.0, -2.6e10])
        self.assertEqual(payload["time_expression"], {
            "source": "heaviside(t-on) * sin(2*pi*f*t)",
            "constants": {"f": 4e9, "on": 70e-9},
            "event_times_s": [70e-9],
        })
        self.assertEqual(stt.to_ir_fields(), {})

    def test_time_expression_rejects_ambiguous_or_nonfinite_bindings(self) -> None:
        for name, value in (("t", 1.0), ("pi", 3.0), ("f", float("inf"))):
            with self.subTest(name=name, value=value), self.assertRaises(ValueError):
                fm.TimeExpression("sin(t)", constants={name: value})
        with self.assertRaises(ValueError):
            fm.TimeExpression("heaviside(t)", event_times_s=(5e-9, 3e-9))
        with self.assertRaisesRegex(ValueError, "at most 4096 event times"):
            fm.TimeExpression("sin(t)", event_times_s=tuple(float(i) for i in range(4097)))
        with self.assertRaisesRegex(ValueError, "canonical thin-layer"):
            fm.SlonczewskiSTT(
                current_density=(0, 0, 1), time_expression=fm.TimeExpression("sin(t)"),
            )

    # ── IR round-trip ───────────────────────────────────────────
    def test_to_ir_fields_keys(self) -> None:
        stt = SlonczewskiSTT([0, 0, 5e10], [0, 0, 1])
        ir = stt.to_ir_fields()
        for key in (
            "current_density",
            "stt_degree",
            "stt_spin_polarization",
            "stt_lambda",
            "stt_epsilon_prime",
        ):
            self.assertIn(key, ir)

    def test_to_ir_values(self) -> None:
        stt = SlonczewskiSTT([0, 0, 5e10], [0, 0, 1], degree=0.6)
        ir = stt.to_ir_fields()
        self.assertEqual(ir["current_density"], [0.0, 0.0, 5e10])
        self.assertEqual(ir["stt_spin_polarization"], [0.0, 0.0, 1.0])
        self.assertAlmostEqual(float(ir["stt_degree"]), 0.6)  # type: ignore[arg-type]

    def test_to_ir_module_kind(self) -> None:
        stt = SlonczewskiSTT([0, 0, 5e10], [0, 0, 1], degree=0.6)
        ir = stt.to_ir_module()
        self.assertEqual(ir["kind"], "slonczewski")
        self.assertEqual(ir["spin_polarization"], [0.0, 0.0, 1.0])

    def test_current_source_serializes_without_legacy_fields(self) -> None:
        stt = SlonczewskiSTT(
            spin_polarization=[0.0, 0.0, 1.0],
            current_source="drive",
            degree=0.6,
        )
        ir = stt.to_ir_module()
        self.assertEqual(ir["current_source"], "drive")
        self.assertNotIn("current_density", ir)
        self.assertEqual(stt.to_ir_fields(), {})


class TestZhangLiSTT(unittest.TestCase):
    def test_basic_construction(self) -> None:
        stt = ZhangLiSTT(current_density=[1e11, 0, 0])
        self.assertEqual(stt.current_density, (1e11, 0.0, 0.0))
        self.assertAlmostEqual(stt.degree, 0.4)
        self.assertAlmostEqual(stt.beta, 0.0)

    def test_to_ir_fields_keys(self) -> None:
        stt = ZhangLiSTT([1e11, 0, 0], beta=0.04)
        ir = stt.to_ir_fields()
        self.assertIn("current_density", ir)
        self.assertIn("stt_degree", ir)
        self.assertIn("stt_beta", ir)
        self.assertAlmostEqual(float(ir["stt_beta"]), 0.04)  # type: ignore[arg-type]

    def test_is_frozen(self) -> None:
        stt = ZhangLiSTT([1e11, 0, 0])
        with self.assertRaises(AttributeError):
            stt.beta = 0.1  # type: ignore[misc]

    def test_to_ir_module_kind(self) -> None:
        stt = ZhangLiSTT([1e11, 0, 0], beta=0.04)
        ir = stt.to_ir_module()
        self.assertEqual(ir["kind"], "zhang_li")
        self.assertAlmostEqual(float(ir["beta"]), 0.04)  # type: ignore[arg-type]

    def test_current_source_requires_exclusive_binding(self) -> None:
        with self.assertRaises(ValueError):
            ZhangLiSTT([1e11, 0, 0], current_source="drive")

    def test_mumax3_central_operator_is_explicitly_versioned(self) -> None:
        stt = ZhangLiSTT(
            [1e11, 0, 0],
            beta=0.05,
            id="cip",
            target=RegionRef("free"),
            lande_g=2.0,
            operator_version="zl_mumax3_central_v1",
        )
        self.assertEqual(stt.formula_version, "zhang_li.mumax3.v1")
        self.assertEqual(stt.operator_version, "zl_mumax3_central_v1")
        self.assertEqual(stt.to_ir_module()["schema_version"], "zhang_li_torque.v1")

    def test_mumax3_central_operator_rejects_non_source_g_factor(self) -> None:
        with self.assertRaisesRegex(ValueError, "lande_g=2.0"):
            ZhangLiSTT(
                [1e11, 0, 0],
                id="cip",
                target=RegionRef("free"),
                lande_g=1.9,
                operator_version="zl_mumax3_central_v1",
            )


class TestSemanticSpinTorquePlaceholders(unittest.TestCase):
    def test_interface_cpp_to_ir_module(self) -> None:
        stt = InterfaceCppSTT(
            current_density=[0.0, 0.0, 5e10],
            spin_polarization=[0.0, 0.0, 1.0],
            interface_normal=[0.0, 0.0, 1.0],
        )
        ir = stt.to_ir_module()
        self.assertEqual(ir["kind"], "interface_cpp")
        self.assertEqual(ir["interface_normal"], [0.0, 0.0, 1.0])

    def test_drift_diffusion_to_ir_module(self) -> None:
        stt = DriftDiffusionSpinTorque(
            current_density=[1e11, 0.0, 0.0],
            spin_polarization=[0.0, 1.0, 0.0],
            degree=0.5,
            beta=0.02,
            spin_diffusion_length_m=6e-9,
        )
        ir = stt.to_ir_module()
        self.assertEqual(ir["kind"], "drift_diffusion")
        self.assertAlmostEqual(float(ir["spin_diffusion_length_m"]), 6e-9)  # type: ignore[arg-type]

    def test_spin_orbit_torque_to_ir_module(self) -> None:
        torque = SpinOrbitTorque(
            name="compat_sot",
            target=RegionRef("free_layer"),
            charge_current_density_a_per_m2=2e11,
            damping_like_efficiency=0.12,
            field_like_efficiency=0.01,
            spin_polarization=[0.0, 1.0, 0.0],
            ferromagnet_thickness_m=1.5e-9,
        )
        ir = torque.to_ir_module()
        self.assertEqual(ir["kind"], "prescribed_sot")
        self.assertEqual(ir["formula_version"], "prescribed_sot.fullmag.v1")
        self.assertAlmostEqual(float(ir["xi_fl"]), 0.01)  # type: ignore[arg-type]


class TestSpinTorqueUnion(unittest.TestCase):
    def test_isinstance_slonczewski(self) -> None:
        stt: SpinTorque = SlonczewskiSTT([0, 0, 5e10], [0, 0, 1])
        self.assertIsInstance(stt, SlonczewskiSTT)

    def test_isinstance_zhangli(self) -> None:
        stt: SpinTorque = ZhangLiSTT([1e11, 0, 0])
        self.assertIsInstance(stt, ZhangLiSTT)


if __name__ == "__main__":
    unittest.main()
