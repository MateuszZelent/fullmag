from __future__ import annotations

import textwrap
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import fullmag as fm
from fullmag.runtime.loader import load_problem_from_script
from fullmag.runtime.script_builder import rewrite_loaded_problem_script


def _base_problem(**kwargs) -> fm.Problem:
    geometry = fm.Box(size=(100e-9, 100e-9, 5e-9), name="layer")
    material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.01)
    magnet = fm.Ferromagnet(name="layer", geometry=geometry, material=material)
    defaults = dict(
        name="current_transport_test",
        magnets=[magnet],
        energy=[fm.Exchange(), fm.Demag()],
        study=fm.TimeEvolution(
            dynamics=fm.LLG(),
            outputs=[fm.SaveScalar("E_total", every=10e-12)],
        ),
        discretization=fm.DiscretizationHints(fdm=fm.FDM(cell=(2e-9, 2e-9, 5e-9))),
    )
    defaults.update(kwargs)
    return fm.Problem(**defaults)  # type: ignore[arg-type]


class CurrentTransportTests(unittest.TestCase):
    def test_prescribed_density_serializes_to_ir(self) -> None:
        transport = fm.CurrentTransport(
            name="drive",
            current_density=(0.0, 0.0, 5e10),
        )
        ir = transport.to_ir()
        self.assertEqual(ir["kind"], "current_transport")
        self.assertEqual(ir["model"], "prescribed_density")
        self.assertEqual(ir["current_density"], [0.0, 0.0, 5e10])

    def test_source_bound_slonczewski_preserves_current_source(self) -> None:
        transport = fm.CurrentTransport(
            name="drive",
            current_density=(0.0, 0.0, 5e10),
        )
        problem = _base_problem(
            current_modules=[transport],
            spin_torque=fm.SlonczewskiSTT(
                spin_polarization=(0.0, 0.0, 1.0),
                current_source="drive",
                degree=0.6,
            ),
        )
        ir = problem.to_ir()
        self.assertEqual(ir["current_modules"][0]["kind"], "current_transport")  # type: ignore[index]
        self.assertEqual(ir["spin_torque_modules"][0]["current_source"], "drive")  # type: ignore[index]
        self.assertNotIn("current_density", ir)

    def test_oersted_field_from_current_solution_serializes_to_ir(self) -> None:
        transport = fm.CurrentTransport(
            name="drive",
            current_density=(0.0, 0.0, 5e10),
            solve_region="pillar",
        )
        problem = _base_problem(
            current_modules=[transport],
            energy=[fm.Exchange(), fm.Demag(), fm.OerstedField(source="drive")],
        )
        ir = problem.to_ir()
        self.assertEqual(ir["energy_terms"][2]["kind"], "oersted_field")  # type: ignore[index]
        self.assertEqual(ir["energy_terms"][2]["model"], "from_current_solution")  # type: ignore[index]
        self.assertEqual(ir["energy_terms"][2]["source"], "drive")  # type: ignore[index]

    def test_oersted_field_requires_current_transport_source(self) -> None:
        with self.assertRaises(ValueError):
            _base_problem(
                current_modules=[
                    fm.AntennaFieldSource(
                        name="antenna",
                        antenna=fm.CPWAntenna(
                            signal_width=10e-9,
                            gap=5e-9,
                            ground_width=10e-9,
                            thickness=10e-9,
                            height_above_magnet=20e-9,
                            preview_length=100e-9,
                        ),
                        drive=fm.RfDrive(current_a=0.01, frequency_hz=10e9),
                    )
                ],
                energy=[fm.Exchange(), fm.Demag(), fm.OerstedField(source="antenna")],
            )

    def test_excitation_analysis_must_reference_antenna(self) -> None:
        with self.assertRaises(ValueError):
            _base_problem(
                current_modules=[
                    fm.CurrentTransport(
                        name="drive",
                        current_density=(0.0, 0.0, 5e10),
                    )
                ],
                excitation_analysis=fm.SpinWaveExcitationAnalysis(source="drive"),
            )

    def test_flat_script_round_trip_renders_current_transport(self) -> None:
        script = textwrap.dedent(
            """
            import fullmag as fm

            fm.name("transport_flat")
            fm.cell(2e-9, 2e-9, 5e-9)

            layer = fm.geometry(fm.Box(100e-9, 100e-9, 5e-9), name="layer")
            layer.Ms = 800e3
            layer.Aex = 13e-12
            layer.alpha = 0.01
            layer.m = fm.texture.uniform(1, 0, 0)

            fm.current_transport(name="drive", current_density=(0.0, 0.0, 5e10))
            fm.tableautosave(10e-12, ["E_total"])
            fm.run(20e-12)
            """
        )
        with TemporaryDirectory() as tmpdir:
            script_path = Path(tmpdir) / "transport_flat.py"
            script_path.write_text(script, encoding="utf-8")
            loaded = load_problem_from_script(script_path)
            rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]

        self.assertIn('fm.current_transport(name="drive"', rewritten)
        self.assertIn("current_density=(0, 0, 50000000000)", rewritten)

    def test_flat_script_round_trip_renders_spin_torques(self) -> None:
        """Spin torques are emitted into the canonical script rewrite."""
        transport = fm.CurrentTransport(
            name="drive",
            current_density=(0.0, 0.0, 5e10),
        )
        problem = _base_problem(
            current_modules=[transport],
            spin_torques=[
                fm.SlonczewskiSTT(
                    spin_polarization=(0.0, 0.0, 1.0),
                    current_source="drive",
                    degree=0.6,
                ),
            ],
        )
        from fullmag.runtime.script_builder import _render_spin_torques

        lines = _render_spin_torques(problem, surface="flat")
        rendered = "\n".join(lines)
        self.assertIn("SlonczewskiSTT", rendered)
        self.assertIn('current_source="drive"', rendered)
        self.assertIn("degree=0.6", rendered)

    def test_export_builder_draft_includes_spin_torques(self) -> None:
        """Builder draft export includes spin_torque entries."""
        transport = fm.CurrentTransport(
            name="drive",
            current_density=(0.0, 0.0, 5e10),
        )
        problem = _base_problem(
            current_modules=[transport],
            spin_torques=[
                fm.SlonczewskiSTT(
                    spin_polarization=(0.0, 0.0, 1.0),
                    current_source="drive",
                ),
                fm.ZhangLiSTT(
                    current_density=(1e10, 0.0, 0.0),
                    beta=0.05,
                ),
            ],
        )
        from fullmag.runtime.script_builder import _export_spin_torque_entry

        entries = [_export_spin_torque_entry(m) for m in problem.spin_torques]
        self.assertEqual(len(entries), 2)
        self.assertEqual(entries[0]["kind"], "slonczewski")
        self.assertEqual(entries[0]["current_source"], "drive")
        self.assertEqual(entries[1]["kind"], "zhang_li")
        self.assertAlmostEqual(entries[1]["beta"], 0.05)


if __name__ == "__main__":
    unittest.main()
