"""Round-trip tests: Problem → to_ir() verifies STNO fields appear in IR."""

from __future__ import annotations

import unittest

import fullmag as fm
from fullmag.model.energy import OerstedCylinder, PiecewiseLinear, ThermalNoise
from fullmag.model.spin_torque import InterfaceCppSTT, SlonczewskiSTT, ZhangLiSTT


def _base_problem(**kwargs) -> fm.Problem:
    """Build a minimal Problem for IR round-trip testing."""
    geometry = fm.Box(size=(100e-9, 100e-9, 5e-9), name="layer")
    material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.01)
    magnet = fm.Ferromagnet(name="layer", geometry=geometry, material=material)

    defaults = dict(
        name="stno_test",
        magnets=[magnet],
        energy=[fm.Exchange(), fm.Demag()],
        study=fm.TimeEvolution(
            dynamics=fm.LLG(),
            outputs=[fm.SaveScalar("E_total", every=10e-12)],
        ),
        discretization=fm.DiscretizationHints(
            fdm=fm.FDM(cell=(2e-9, 2e-9, 5e-9)),
        ),
    )
    defaults.update(kwargs)
    return fm.Problem(**defaults)  # type: ignore[arg-type]


class TestSTNOIRRoundtrip(unittest.TestCase):
    def test_slonczewski_fields_in_ir(self) -> None:
        stt = SlonczewskiSTT([0, 0, 5e10], [0, 0, 1], degree=0.6)
        p = _base_problem(spin_torque=stt)
        ir = p.to_ir()
        self.assertIn("spin_torque_modules", ir)
        self.assertEqual(ir["spin_torque_modules"][0]["kind"], "slonczewski")  # type: ignore[index]
        self.assertIn("current_density", ir)
        self.assertIn("stt_degree", ir)
        self.assertIn("stt_spin_polarization", ir)
        self.assertAlmostEqual(float(ir["stt_degree"]), 0.6)  # type: ignore[arg-type]

    def test_zhangli_fields_in_ir(self) -> None:
        stt = ZhangLiSTT([1e11, 0, 0], beta=0.04)
        p = _base_problem(spin_torque=stt)
        ir = p.to_ir()
        self.assertIn("spin_torque_modules", ir)
        self.assertEqual(ir["spin_torque_modules"][0]["kind"], "zhang_li")  # type: ignore[index]
        self.assertIn("current_density", ir)
        self.assertIn("stt_degree", ir)
        self.assertIn("stt_beta", ir)
        self.assertAlmostEqual(float(ir["stt_beta"]), 0.04)  # type: ignore[arg-type]

    def test_canonical_spin_torque_modules_preserve_multi_module_authoring(self) -> None:
        p = _base_problem(
            spin_torques=[
                SlonczewskiSTT([0, 0, 5e10], [0, 0, 1]),
                InterfaceCppSTT(
                    current_density=[0, 0, 5e10],
                    spin_polarization=[0, 0, 1],
                    interface_normal=[0, 0, 1],
                ),
            ]
        )
        ir = p.to_ir()
        modules = ir.get("spin_torque_modules", [])
        self.assertEqual(len(modules), 2)  # type: ignore[arg-type]
        self.assertNotIn("current_density", ir)
        self.assertNotIn("stt_spin_polarization", ir)

    def test_legacy_and_canonical_spin_torque_shapes_are_mutually_exclusive(self) -> None:
        with self.assertRaises(ValueError):
            _base_problem(
                spin_torque=SlonczewskiSTT([0, 0, 5e10], [0, 0, 1]),
                spin_torques=[ZhangLiSTT([1e11, 0, 0])],
            )

    def test_temperature_in_ir(self) -> None:
        p = _base_problem(temperature=300.0)
        ir = p.to_ir()
        self.assertIn("temperature", ir)
        self.assertAlmostEqual(float(ir["temperature"]), 300.0)  # type: ignore[arg-type]

    def test_oersted_cylinder_in_energy_terms(self) -> None:
        oe = OerstedCylinder(current=5e-3, radius=50e-9)
        p = _base_problem(
            energy=[fm.Exchange(), fm.Demag(), oe],
        )
        ir = p.to_ir()
        energy_irs = ir.get("energy_terms", [])
        kinds = [e["kind"] for e in energy_irs]  # type: ignore[union-attr]
        self.assertIn("oersted_cylinder", kinds)

    def test_oersted_with_piecewise_linear_td(self) -> None:
        pwl = PiecewiseLinear([(0.0, 0.0), (1e-9, 1.0), (5e-9, 0.5)])
        oe = OerstedCylinder(current=5e-3, radius=50e-9, time_dependence=pwl)
        ir_oe = oe.to_ir()
        td = ir_oe["time_dependence"]
        self.assertEqual(td["kind"], "piecewise_linear")  # type: ignore[index]
        self.assertEqual(len(td["points"]), 3)  # type: ignore[index,arg-type]

    def test_thermal_noise_in_energy_terms(self) -> None:
        tn = ThermalNoise(temperature=300.0, seed=42)
        p = _base_problem(
            energy=[fm.Exchange(), fm.Demag(), tn],
            temperature=300.0,
        )
        ir = p.to_ir()
        energy_irs = ir.get("energy_terms", [])
        kinds = [e["kind"] for e in energy_irs]  # type: ignore[union-attr]
        self.assertIn("thermal_noise", kinds)

    def test_full_stno_problem_ir(self) -> None:
        """Full STNO problem with STT + Oersted + temperature serializes."""
        stt = SlonczewskiSTT([0, 0, 5e10], [0, 0, 1])
        oe = OerstedCylinder(current=5e-3, radius=50e-9)
        tn = ThermalNoise(temperature=300.0)
        p = _base_problem(
            spin_torque=stt,
            temperature=300.0,
            energy=[fm.Exchange(), fm.Demag(), oe, tn],
        )
        ir = p.to_ir()
        # STT fields
        self.assertEqual(ir["spin_torque_modules"][0]["kind"], "slonczewski")  # type: ignore[index]
        self.assertIn("current_density", ir)
        self.assertIn("stt_spin_polarization", ir)
        # Temperature
        self.assertEqual(ir["temperature"], 300.0)
        # Energy terms include oersted and thermal
        energy_irs = ir.get("energy_terms", [])
        kinds = [e["kind"] for e in energy_irs]  # type: ignore[union-attr]
        self.assertIn("oersted_cylinder", kinds)
        self.assertIn("thermal_noise", kinds)


if __name__ == "__main__":
    unittest.main()
