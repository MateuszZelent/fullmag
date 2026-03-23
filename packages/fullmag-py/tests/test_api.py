from __future__ import annotations

import contextlib
import io
import json
import textwrap
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import fullmag as fm
from fullmag.runtime import cli as runtime_cli
from fullmag.runtime import helper as runtime_helper


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
            study=fm.TimeEvolution(
                dynamics=fm.LLG(),
                outputs=[
                    fm.SaveField("m", every=10e-12),
                    fm.SaveScalar("E_total", every=10e-12),
                ],
            ),
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
        self.assertEqual(ir["backend_policy"]["execution_precision"], "double")
        self.assertEqual(ir["validation_profile"]["execution_mode"], "strict")
        self.assertEqual(ir["geometry"]["entries"][0]["kind"], "box")
        self.assertEqual(ir["geometry"]["entries"][0]["size"], [200e-9, 20e-9, 5e-9])
        self.assertEqual(ir["energy_terms"][2]["kind"], "interfacial_dmi")
        self.assertEqual(ir["study"]["kind"], "time_evolution")
        self.assertEqual(ir["study"]["dynamics"]["integrator"], "heun")
        self.assertEqual(ir["study"]["sampling"]["outputs"][0]["name"], "m")

    def test_random_initializer_serializes_to_ir(self) -> None:
        initializer = fm.init.random(seed=42)

        self.assertEqual(initializer.to_ir(), {"kind": "random_seeded", "seed": 42})

    def test_legacy_dynamics_and_outputs_are_normalized_to_time_evolution(self) -> None:
        geometry = fm.Box(size=(100e-9, 20e-9, 5e-9), name="track")
        material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.01)
        magnet = fm.Ferromagnet(name="track", geometry=geometry, material=material)

        problem = fm.Problem(
            name="legacy_shape",
            magnets=[magnet],
            energy=[fm.Exchange()],
            dynamics=fm.LLG(),
            outputs=[fm.SaveField("m", every=1e-12)],
        )

        self.assertIsInstance(problem.study, fm.TimeEvolution)
        ir = problem.to_ir()
        self.assertEqual(ir["study"]["kind"], "time_evolution")
        self.assertEqual(ir["study"]["sampling"]["outputs"][0]["name"], "m")

    def test_cylinder_serializes_to_ir(self) -> None:
        geometry = fm.Cylinder(radius=50e-9, height=10e-9, name="pillar")

        self.assertEqual(
            geometry.to_ir(),
            {"kind": "cylinder", "name": "pillar", "radius": 50e-9, "height": 10e-9},
        )

    def test_from_function_is_deferred_stub(self) -> None:
        with self.assertRaises(NotImplementedError):
            fm.init.from_function(lambda point: point)

    def test_simulation_overrides_backend_mode_and_precision(self) -> None:
        problem = self._build_problem()
        simulation = fm.Simulation(
            problem,
            backend="hybrid",
            mode="hybrid",
            precision="single",
        )

        ir = simulation.to_ir()

        self.assertEqual(ir["backend_policy"]["requested_backend"], "hybrid")
        self.assertEqual(ir["backend_policy"]["execution_precision"], "single")
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
                study=fm.TimeEvolution(
                    dynamics=fm.LLG(),
                    outputs=[fm.SaveField("m", every=1e-12)],
                ),
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
            study=fm.TimeEvolution(
                dynamics=fm.LLG(),
                outputs=[fm.SaveField("m", every=1e-12)],
            ),
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

    def test_cli_runs_script_and_preserves_script_provenance(self) -> None:
        script = """
        import fullmag as fm

        def build():
            geom = fm.Box(size=(100e-9, 20e-9, 5e-9), name="track")
            material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.1)
            magnet = fm.Ferromagnet(
                name="track",
                geometry=geom,
                material=material,
                m0=fm.init.uniform((1.0, 0.0, 0.0)),
            )
            return fm.Problem(
                name="cli_problem",
                magnets=[magnet],
                energy=[fm.Exchange()],
                study=fm.TimeEvolution(
                    dynamics=fm.LLG(),
                    outputs=[fm.SaveField("m", every=1e-12)],
                ),
                discretization=fm.DiscretizationHints(
                    fdm=fm.FDM(cell=(5e-9, 5e-9, 5e-9)),
                ),
            )
        """

        captured: dict[str, object] = {}

        def fake_run_problem_json(ir, until_seconds, output_dir):
            captured["ir"] = ir
            captured["until_seconds"] = until_seconds
            captured["output_dir"] = output_dir
            return {
                "status": "completed",
                "steps": [
                    {
                        "step": 0,
                        "time": 1e-12,
                        "dt": 1e-12,
                        "e_ex": 3.14e-20,
                        "max_dm_dt": 0.0,
                        "max_h_eff": 1.23,
                        "wall_time_ns": 42,
                    }
                ],
                "final_magnetization": [[1.0, 0.0, 0.0]],
            }

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_cli.py"
            output_dir = Path(tmp_dir) / "artifacts"
            path.write_text(textwrap.dedent(script), encoding="utf-8")

            stdout = io.StringIO()
            with patch(
                "fullmag.runtime.cli.run_problem_json",
                side_effect=fake_run_problem_json,
            ), contextlib.redirect_stdout(stdout):
                exit_code = runtime_cli.main(
                    [
                        str(path),
                        "--until",
                        "1e-12",
                        "--backend",
                        "fdm",
                        "--mode",
                        "strict",
                        "--precision",
                        "double",
                        "--output-dir",
                        str(output_dir),
                    ]
                )

        self.assertEqual(exit_code, 0)
        self.assertEqual(captured["until_seconds"], 1e-12)
        self.assertEqual(captured["output_dir"], str(output_dir))
        self.assertEqual(captured["ir"]["problem_meta"]["entrypoint_kind"], "build")
        self.assertIn("def build()", captured["ir"]["problem_meta"]["script_source"])
        self.assertIn("fullmag run summary", stdout.getvalue())
        self.assertIn("backend=fdm", stdout.getvalue())

    def test_cli_json_mode_prints_machine_readable_summary(self) -> None:
        script = """
        import fullmag as fm

        geom = fm.Box(size=(100e-9, 20e-9, 5e-9), name="track")
        material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.1)
        magnet = fm.Ferromagnet(name="track", geometry=geom, material=material)
        problem = fm.Problem(
            name="json_problem",
            magnets=[magnet],
            energy=[fm.Exchange()],
            study=fm.TimeEvolution(
                dynamics=fm.LLG(),
                outputs=[fm.SaveField("m", every=1e-12)],
            ),
            discretization=fm.DiscretizationHints(
                fdm=fm.FDM(cell=(5e-9, 5e-9, 5e-9)),
            ),
        )
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_json.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")

            stdout = io.StringIO()
            with patch(
                "fullmag.runtime.cli.run_problem_json",
                return_value={
                    "status": "completed",
                    "steps": [],
                    "final_magnetization": None,
                },
            ), contextlib.redirect_stdout(stdout):
                exit_code = runtime_cli.main(
                    [str(path), "--until", "1e-12", "--json"]
                )

        self.assertEqual(exit_code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["problem_name"], "json_problem")
        self.assertEqual(payload["status"], "completed")
        self.assertEqual(payload["precision"], "double")

    def test_helper_exports_ir_for_rust_host(self) -> None:
        script = """
        import fullmag as fm

        def build():
            geom = fm.Box(size=(100e-9, 20e-9, 5e-9), name="track")
            material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.1)
            magnet = fm.Ferromagnet(name="track", geometry=geom, material=material)
            return fm.Problem(
                name="helper_problem",
                magnets=[magnet],
                energy=[fm.Exchange()],
                study=fm.TimeEvolution(
                    dynamics=fm.LLG(),
                    outputs=[fm.SaveField("m", every=1e-12)],
                ),
                discretization=fm.DiscretizationHints(
                    fdm=fm.FDM(cell=(5e-9, 5e-9, 5e-9)),
                ),
            )
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_helper.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")

            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                exit_code = runtime_helper.main(
                    [
                        "export-ir",
                        "--script",
                        str(path),
                        "--backend",
                        "fdm",
                        "--mode",
                        "strict",
                        "--precision",
                        "double",
                    ]
                )

        self.assertEqual(exit_code, 0)
        ir = json.loads(stdout.getvalue())
        self.assertEqual(ir["problem_meta"]["name"], "helper_problem")
        self.assertEqual(ir["study"]["kind"], "time_evolution")


if __name__ == "__main__":
    unittest.main()
