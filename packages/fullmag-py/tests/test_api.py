from __future__ import annotations

import textwrap
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import fullmag as fm


class ProblemApiTests(unittest.TestCase):
    def _build_problem(self) -> fm.Problem:
        geometry = fm.Box(size=(200e-9, 20e-9, 5e-9), name="track")
        material = fm.Material(
            name="Py",
            Ms=800e3,
            A=13e-12,
            alpha=0.01,
            Ku1=0.5e6,
            anisU=(0.0, 0.0, 1.0),
        )
        magnet = fm.Ferromagnet(
            name="track",
            geometry=geometry,
            material=material,
            m0=fm.init.uniform((1.0, 0.0, 0.0)),
        )
        return fm.Problem(
            name="dw_track",
            magnets=[magnet],
            energy=[
                fm.Exchange(),
                fm.Demag(),
                fm.InterfacialDMI(D=3e-3),
                fm.Zeeman(B=(0.0, 0.0, 0.1)),
            ],
            dynamics=fm.LLG(),
            outputs=[
                fm.SaveField("m", every=10e-12),
                fm.SaveScalar("E_total", every=10e-12),
            ],
            discretization=fm.DiscretizationHints(
                fdm=fm.FDM(cell=(2e-9, 2e-9, 1e-9)),
                fem=fm.FEM(order=1, hmax=2e-9),
                hybrid=fm.Hybrid(demag="fft_aux_grid"),
            ),
        )

    def test_problem_to_ir_contains_canonical_sections(self) -> None:
        problem = self._build_problem()
        ir = problem.to_ir()

        self.assertEqual(ir["ir_version"], "0.2.0")
        self.assertEqual(ir["problem_meta"]["script_language"], "python")
        self.assertEqual(ir["backend_policy"]["requested_backend"], "auto")
        self.assertEqual(ir["validation_profile"]["execution_mode"], "strict")
        self.assertEqual(ir["geometry"]["entries"][0]["kind"], "box")
        self.assertEqual(ir["geometry"]["entries"][0]["size"], [200e-9, 20e-9, 5e-9])
        self.assertEqual(ir["energy_terms"][2]["kind"], "interfacial_dmi")
        self.assertEqual(ir["dynamics"]["integrator"], "heun")
        self.assertEqual(ir["sampling"]["outputs"][0]["name"], "m")

    def test_random_initializer_serializes_to_ir(self) -> None:
        initializer = fm.init.random(seed=42)

        self.assertEqual(initializer.to_ir(), {"kind": "random_seeded", "seed": 42})

    def test_cylinder_serializes_to_ir(self) -> None:
        geometry = fm.Cylinder(radius=50e-9, height=10e-9, name="pillar")

        self.assertEqual(
            geometry.to_ir(),
            {"kind": "cylinder", "name": "pillar", "radius": 50e-9, "height": 10e-9},
        )

    def test_from_function_is_deferred_stub(self) -> None:
        with self.assertRaises(NotImplementedError):
            fm.init.from_function(lambda point: point)

    def test_simulation_overrides_backend_and_mode(self) -> None:
        problem = self._build_problem()
        simulation = fm.Simulation(problem, backend="hybrid", mode="hybrid")

        ir = simulation.to_ir()

        self.assertEqual(ir["backend_policy"]["requested_backend"], "hybrid")
        self.assertEqual(ir["validation_profile"]["execution_mode"], "hybrid")

    def test_build_entrypoint_is_preferred(self) -> None:
        script = """
        import fullmag as fm

        def build():
            geom = fm.Box(size=(200e-9, 20e-9, 5e-9), name="track")
            material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.01)
            magnet = fm.Ferromagnet(name="track", geometry=geom, material=material)
            return fm.Problem(
                name="from_build",
                magnets=[magnet],
                energy=[fm.Exchange(), fm.Demag()],
                dynamics=fm.LLG(),
                outputs=[fm.SaveField("m", every=1e-12)],
            )

        problem = build()
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_build.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path)

        self.assertEqual(loaded.problem.name, "from_build")
        self.assertEqual(loaded.entrypoint_kind, "build")

    def test_top_level_problem_entrypoint_is_supported(self) -> None:
        script = """
        import fullmag as fm

        geom = fm.Box(size=(200e-9, 20e-9, 5e-9), name="track")
        material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.01)
        magnet = fm.Ferromagnet(name="track", geometry=geom, material=material)
        problem = fm.Problem(
            name="from_problem",
            magnets=[magnet],
            energy=[fm.Exchange(), fm.Demag()],
            dynamics=fm.LLG(),
            outputs=[fm.SaveField("m", every=1e-12)],
        )
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_problem.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path)

        self.assertEqual(loaded.problem.name, "from_problem")
        self.assertEqual(loaded.entrypoint_kind, "problem")

    def test_llg_requires_supported_integrator_and_positive_timestep(self) -> None:
        with self.assertRaisesRegex(ValueError, "integrator must be one of"):
            fm.LLG(integrator="rk4")

        with self.assertRaisesRegex(ValueError, "fixed_timestep"):
            fm.LLG(fixed_timestep=0.0)


if __name__ == "__main__":
    unittest.main()
