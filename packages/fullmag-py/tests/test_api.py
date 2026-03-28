from __future__ import annotations

import contextlib
import io
import json
import textwrap
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import numpy as np

import fullmag as fm
import fullmag.world as flat_world
from fullmag.meshing.voxelization import VoxelMaskData
from fullmag.runtime import cli as runtime_cli
from fullmag.runtime import helper as runtime_helper
from fullmag.meshing.gmsh_bridge import MeshData


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
        self.assertEqual(ir["study"]["dynamics"]["integrator"], "auto")
        self.assertEqual(ir["study"]["sampling"]["outputs"][0]["name"], "m")
        self.assertEqual(
            ir["problem_meta"]["runtime_metadata"]["runtime_selection"]["device"], "auto"
        )

    def test_problem_runtime_selection_serializes_to_ir(self) -> None:
        problem = self._build_problem()
        problem = fm.Problem(
            name=problem.name,
            magnets=problem.magnets,
            energy=problem.energy,
            study=problem.study,
            discretization=problem.discretization,
            runtime=fm.backend.cuda(1).device(0).threads(8).engine("fdm").precision("single"),
        )

        ir = problem.to_ir()

        self.assertEqual(ir["backend_policy"]["requested_backend"], "fdm")
        self.assertEqual(ir["backend_policy"]["execution_precision"], "single")
        runtime = ir["problem_meta"]["runtime_metadata"]["runtime_selection"]
        self.assertEqual(runtime["device"], "cuda")
        self.assertEqual(runtime["gpu_count"], 1)
        self.assertEqual(runtime["device_index"], 0)
        self.assertEqual(runtime["cpu_threads"], 8)

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

    def test_relaxation_serializes_to_ir(self) -> None:
        geometry = fm.Box(size=(100e-9, 20e-9, 5e-9), name="track")
        material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.1)
        magnet = fm.Ferromagnet(name="track", geometry=geometry, material=material)

        problem = fm.Problem(
            name="relax_problem",
            magnets=[magnet],
            energy=[fm.Exchange(), fm.Demag()],
            study=fm.Relaxation(
                algorithm="llg_overdamped",
                torque_tolerance=1e-3,
                energy_tolerance=1e-12,
                max_steps=500,
                dynamics=fm.LLG(fixed_timestep=2e-13),
                outputs=[fm.SaveField("m", every=1e-12)],
            ),
        )

        ir = problem.to_ir()
        self.assertEqual(ir["study"]["kind"], "relaxation")
        self.assertEqual(ir["study"]["algorithm"], "llg_overdamped")
        self.assertEqual(ir["study"]["torque_tolerance"], 1e-3)
        self.assertEqual(ir["study"]["energy_tolerance"], 1e-12)
        self.assertEqual(ir["study"]["max_steps"], 500)
        self.assertEqual(ir["study"]["dynamics"]["fixed_timestep"], 2e-13)

    def test_relaxation_requires_supported_algorithm_and_positive_limits(self) -> None:
        with self.assertRaisesRegex(ValueError, "algorithm must be one of"):
            fm.Relaxation(
                algorithm="made_up",
                outputs=[fm.SaveField("m", every=1e-12)],
            )

        with self.assertRaisesRegex(ValueError, "torque_tolerance"):
            fm.Relaxation(
                torque_tolerance=0.0,
                outputs=[fm.SaveField("m", every=1e-12)],
            )

        with self.assertRaisesRegex(ValueError, "max_steps"):
            fm.Relaxation(
                max_steps=0,
                outputs=[fm.SaveField("m", every=1e-12)],
            )

    def test_flat_tableautosave_registers_default_scalar_table(self) -> None:
        fm.reset()
        fm.engine("fdm")
        fm.cell(2e-9, 2e-9, 2e-9)
        track = fm.geometry(fm.Box(size=(20e-9, 10e-9, 2e-9), name="track"), name="track")
        track.Ms = 800e3
        track.Aex = 13e-12
        track.alpha = 0.1
        track.m = fm.uniform(1.0, 0.0, 0.0)

        fm.tableautosave(5e-12)
        problem = flat_world._build_problem()
        ir = problem.to_ir()
        outputs = ir["study"]["sampling"]["outputs"]
        scalar_names = [output["name"] for output in outputs if output["kind"] == "scalar"]

        self.assertEqual(
            scalar_names,
            ["time", "step", "solver_dt", "mx", "my", "mz", "E_total", "max_dm_dt", "max_h_eff"],
        )
        self.assertTrue(all(output["every_seconds"] == 5e-12 for output in outputs if output["kind"] == "scalar"))

    def test_cylinder_serializes_to_ir(self) -> None:
        geometry = fm.Cylinder(radius=50e-9, height=10e-9, name="pillar")

        self.assertEqual(
            geometry.to_ir(),
            {"kind": "cylinder", "name": "pillar", "radius": 50e-9, "height": 10e-9},
        )

    def test_translated_geometries_derive_distinct_names(self) -> None:
        free_geom = fm.Box(size=(40e-9, 20e-9, 2e-9), name="free").translate((0.0, 0.0, 0.0))
        ref_geom = fm.Box(size=(40e-9, 20e-9, 2e-9), name="ref").translate((0.0, 0.0, 4e-9))
        material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.2)
        problem = fm.Problem(
            name="translated_multibody",
            magnets=[
                fm.Ferromagnet(name="free", geometry=free_geom, material=material),
                fm.Ferromagnet(name="ref", geometry=ref_geom, material=material),
            ],
            energy=[fm.Exchange(), fm.Demag()],
            study=fm.TimeEvolution(
                dynamics=fm.LLG(fixed_timestep=1e-13),
                outputs=[fm.SaveScalar("E_total", every=1e-13)],
            ),
            discretization=fm.DiscretizationHints(
                fdm=fm.FDM(default_cell=(2e-9, 2e-9, 2e-9)),
            ),
        )

        ir = problem.to_ir()
        names = [entry["name"] for entry in ir["geometry"]["entries"]]

        self.assertEqual(len(names), 2)
        self.assertEqual(len(set(names)), 2)
        self.assertIn("base", ir["geometry"]["entries"][0])
        self.assertIn("by", ir["geometry"]["entries"][0])

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

    def test_simulation_uses_problem_runtime_by_default(self) -> None:
        problem = self._build_problem()
        problem = fm.Problem(
            name=problem.name,
            magnets=problem.magnets,
            energy=problem.energy,
            study=problem.study,
            discretization=problem.discretization,
            runtime=fm.backend.cuda(1).device(0).threads(4).engine("fdm").precision("single"),
        )

        simulation = fm.Simulation(problem)
        ir = simulation.to_ir()

        self.assertEqual(simulation.backend, fm.BackendTarget.FDM)
        self.assertEqual(simulation.precision, fm.ExecutionPrecision.SINGLE)
        self.assertEqual(ir["backend_policy"]["requested_backend"], "fdm")
        self.assertEqual(
            ir["problem_meta"]["runtime_metadata"]["runtime_selection"]["device_index"], 0
        )
        self.assertEqual(
            ir["problem_meta"]["runtime_metadata"]["runtime_selection"]["cpu_threads"], 4
        )

    def test_fem_hint_accepts_optional_mesh_reference(self) -> None:
        fem = fm.FEM(order=1, hmax=2e-9, mesh="meshes/sample.msh")

        self.assertEqual(
            fem.to_ir(),
            {"order": 1, "hmax": 2e-9, "mesh": "meshes/sample.msh"},
        )

    def test_cylinder_problem_exports_fdm_grid_asset(self) -> None:
        geometry = fm.Cylinder(radius=50e-9, height=20e-9, name="pillar")
        material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.01)
        magnet = fm.Ferromagnet(name="pillar", geometry=geometry, material=material)
        problem = fm.Problem(
            name="pillar_problem",
            magnets=[magnet],
            energy=[fm.Exchange()],
            study=fm.TimeEvolution(
                dynamics=fm.LLG(),
                outputs=[fm.SaveField("m", every=1e-12)],
            ),
            discretization=fm.DiscretizationHints(fdm=fm.FDM(cell=(5e-9, 5e-9, 5e-9))),
        )

        ir = problem.to_ir(requested_backend=fm.BackendTarget.FDM)
        assets = ir["geometry_assets"]["fdm_grid_assets"]

        self.assertEqual(len(assets), 1)
        self.assertEqual(assets[0]["geometry_name"], "pillar")
        self.assertEqual(assets[0]["cell_size"], [5e-9, 5e-9, 5e-9])
        self.assertLess(sum(assets[0]["active_mask"]), len(assets[0]["active_mask"]))

    def test_imported_geometry_problem_exports_fdm_grid_asset(self) -> None:
        geometry = fm.ImportedGeometry(source="examples/nanoflower.stl", name="flower")
        material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.01)
        magnet = fm.Ferromagnet(name="flower", geometry=geometry, material=material)
        problem = fm.Problem(
            name="flower_problem",
            magnets=[magnet],
            energy=[fm.Exchange()],
            study=fm.TimeEvolution(
                dynamics=fm.LLG(),
                outputs=[fm.SaveField("m", every=1e-12)],
            ),
            discretization=fm.DiscretizationHints(fdm=fm.FDM(cell=(5e-9, 5e-9, 5e-9))),
        )

        voxels = VoxelMaskData(
            mask=np.asarray([[[True, False], [False, True]]], dtype=np.bool_),
            cell_size=(5e-9, 5e-9, 5e-9),
            origin=(0.0, 0.0, 0.0),
        )

        with patch("fullmag.meshing.realize_fdm_grid_asset", return_value=voxels):
            ir = problem.to_ir(requested_backend=fm.BackendTarget.FDM)

        assets = ir["geometry_assets"]["fdm_grid_assets"]
        self.assertEqual(len(assets), 1)
        self.assertEqual(assets[0]["geometry_name"], "flower")
        self.assertEqual(assets[0]["cell_size"], [5e-9, 5e-9, 5e-9])
        self.assertEqual(
            ir["geometry"]["entries"][0]["source"],
            "examples/nanoflower.stl",
        )

    def test_imported_nanoflower_problem_preserves_xyz_axis_order_in_fdm_grid_asset(self) -> None:
        geometry = fm.ImportedGeometry(source="examples/nanoflower.stl", name="flower", units="nm")
        material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.01)
        magnet = fm.Ferromagnet(name="flower", geometry=geometry, material=material)
        problem = fm.Problem(
            name="flower_problem_real_asset",
            magnets=[magnet],
            energy=[fm.Exchange()],
            study=fm.TimeEvolution(
                dynamics=fm.LLG(),
                outputs=[fm.SaveField("m", every=1e-12)],
            ),
            discretization=fm.DiscretizationHints(fdm=fm.FDM(cell=(5e-9, 5e-9, 5e-9))),
        )

        ir = problem.to_ir(requested_backend=fm.BackendTarget.FDM)

        assets = ir["geometry_assets"]["fdm_grid_assets"]
        self.assertEqual(len(assets), 1)
        self.assertEqual(assets[0]["cells"], [66, 66, 23])
        self.assertEqual(len(assets[0]["active_mask"]), 66 * 66 * 23)

    def test_imported_geometry_supports_anisotropic_scale_in_ir(self) -> None:
        geometry = fm.ImportedGeometry(
            source="examples/nanoflower.stl",
            name="flower",
            scale=(1.0, 2.0, 0.5),
        )

        self.assertEqual(
            geometry.to_ir()["scale"],
            [1.0, 2.0, 0.5],
        )

    def test_imported_geometry_units_are_converted_to_scale(self) -> None:
        geometry = fm.ImportedGeometry(
            source="examples/nanoflower.stl",
            name="flower",
            units="nm",
        )

        self.assertEqual(geometry.to_ir()["scale"], 1e-9)

    def test_imported_geometry_units_compose_with_explicit_scale(self) -> None:
        geometry = fm.ImportedGeometry(
            source="examples/nanoflower.stl",
            name="flower",
            units="nm",
            scale=(2.0, 2.0, 0.5),
        )

        self.assertEqual(
            geometry.to_ir()["scale"],
            [2e-9, 2e-9, 5e-10],
        )

    def test_fem_backend_exports_mesh_asset(self) -> None:
        geometry = fm.Box(size=(10e-9, 10e-9, 10e-9), name="box")
        material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.01)
        magnet = fm.Ferromagnet(name="box", geometry=geometry, material=material)
        problem = fm.Problem(
            name="mesh_problem",
            magnets=[magnet],
            energy=[fm.Exchange()],
            study=fm.TimeEvolution(
                dynamics=fm.LLG(),
                outputs=[fm.SaveField("m", every=1e-12)],
            ),
            discretization=fm.DiscretizationHints(fem=fm.FEM(order=1, hmax=2e-9)),
        )

        mesh = MeshData(
            nodes=np.asarray(
                [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ]
            ),
            elements=np.asarray([[0, 1, 2, 3]], dtype=np.int32),
            element_markers=np.asarray([1], dtype=np.int32),
            boundary_faces=np.asarray([[0, 1, 2]], dtype=np.int32),
            boundary_markers=np.asarray([1], dtype=np.int32),
        )

        with patch("fullmag.meshing.realize_fem_mesh_asset", return_value=mesh), patch(
            "fullmag._core.validate_mesh_ir", return_value=True
        ):
            ir = problem.to_ir(requested_backend=fm.BackendTarget.FEM)

        assets = ir["geometry_assets"]["fem_mesh_assets"]
        self.assertEqual(len(assets), 1)
        self.assertEqual(assets[0]["geometry_name"], "box")
        self.assertEqual(assets[0]["mesh"]["mesh_name"], "box")

    def test_fem_backend_derives_mesh_hints_from_fdm_cell_when_missing(self) -> None:
        geometry = fm.Box(size=(40e-9, 20e-9, 10e-9), name="box")
        material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.01)
        magnet = fm.Ferromagnet(name="box", geometry=geometry, material=material)
        problem = fm.Problem(
            name="derived_fem_hints_problem",
            magnets=[magnet],
            energy=[fm.Exchange()],
            study=fm.TimeEvolution(
                dynamics=fm.LLG(),
                outputs=[fm.SaveField("m", every=1e-12)],
            ),
            discretization=fm.DiscretizationHints(
                fdm=fm.FDM(cell=(5e-9, 5e-9, 10e-9)),
            ),
        )

        mesh = MeshData(
            nodes=np.asarray(
                [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ]
            ),
            elements=np.asarray([[0, 1, 2, 3]], dtype=np.int32),
            element_markers=np.asarray([1], dtype=np.int32),
            boundary_faces=np.asarray([[0, 1, 2]], dtype=np.int32),
            boundary_markers=np.asarray([1], dtype=np.int32),
        )

        with patch("fullmag.meshing.realize_fem_mesh_asset", return_value=mesh), patch(
            "fullmag._core.validate_mesh_ir", return_value=True
        ):
            ir = problem.to_ir(requested_backend=fm.BackendTarget.FEM)

        fem_hints = ir["backend_policy"]["discretization_hints"]["fem"]
        self.assertEqual(fem_hints["order"], 1)
        self.assertEqual(fem_hints["hmax"], 5e-9)
        self.assertEqual(
            ir["problem_meta"]["runtime_metadata"]["derived_discretization"]["policy"],
            "fem_from_fdm_cell",
        )
        assets = ir["geometry_assets"]["fem_mesh_assets"]
        self.assertEqual(len(assets), 1)
        self.assertEqual(assets[0]["geometry_name"], "box")

    def test_build_entrypoint_is_preferred(self) -> None:
        script = """
        import fullmag as fm

        DEFAULT_UNTIL = 1e-12

        def build():
            geom = fm.Box(size=(200e-9, 20e-9, 5e-9), name="track")
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

    def test_script_relative_imported_geometry_is_resolved_for_ir_and_assets(self) -> None:
        script = """
        import fullmag as fm

        def build():
            geom = fm.ImportedGeometry(source="flower.stl", name="flower")
            material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.01)
            magnet = fm.Ferromagnet(name="flower", geometry=geom, material=material)
            return fm.Problem(
                name="flower_problem",
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

        voxels = VoxelMaskData(
            mask=np.asarray([[[True]]], dtype=np.bool_),
            cell_size=(5e-9, 5e-9, 5e-9),
            origin=(0.0, 0.0, 0.0),
        )

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_imported_geometry.py"
            stl = Path(tmp_dir) / "flower.stl"
            stl.write_text("solid flower\nendsolid flower\n", encoding="utf-8")
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path)

            with patch("fullmag.meshing.realize_fdm_grid_asset", return_value=voxels) as mocked:
                ir = loaded.to_ir(
                    requested_backend=fm.BackendTarget.FDM,
                    execution_mode=fm.ExecutionMode.STRICT,
                    execution_precision=fm.ExecutionPrecision.DOUBLE,
                )

        resolved_source = str(stl.resolve())
        self.assertEqual(ir["geometry"]["entries"][0]["source"], resolved_source)
        self.assertEqual(
            mocked.call_args.args[0].source,
            resolved_source,
        )
        self.assertEqual(
            ir["geometry_assets"]["fdm_grid_assets"][0]["geometry_name"],
            "flower",
        )

    def test_flat_run_entrypoint_is_supported(self) -> None:
        script = """
        import fullmag as fm

        fm.engine("fdm")
        fm.device("cpu")
        fm.cell(5e-9, 5e-9, 5e-9)
        body = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.uniform(1, 0, 0)
        fm.solver(dt=1e-13)
        fm.save("m", every=1e-12)
        fm.run(2.5e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_flat_run.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path)

        self.assertEqual(loaded.problem.name, "fullmag_sim")
        self.assertEqual(loaded.entrypoint_kind, "flat_run")
        self.assertEqual(loaded.default_until_seconds, 2.5e-12)

    def test_flat_relax_entrypoint_is_supported(self) -> None:
        script = """
        import fullmag as fm

        fm.engine("fdm")
        fm.cell(5e-9, 5e-9, 5e-9)
        body = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.uniform(1, 0, 0)
        fm.solver(dt=2e-13)
        fm.save("m", every=1e-12)
        fm.relax(tol=1e-4, max_steps=250)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_flat_relax.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path)

        self.assertEqual(loaded.entrypoint_kind, "flat_relax")
        self.assertIsNone(loaded.default_until_seconds)
        self.assertEqual(loaded.problem.study.to_ir()["kind"], "relaxation")

    def test_flat_solver_max_error_lowers_to_adaptive_timestep(self) -> None:
        script = """
        import fullmag as fm

        fm.engine("fdm")
        fm.cell(5e-9, 5e-9, 5e-9)
        body = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.uniform(1, 0, 0)
        fm.solver(dt=2e-15, max_error=1e-6, integrator="rk23")
        fm.save("m", every=1e-12)
        fm.run(2.5e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_flat_adaptive_solver.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path)

        dynamics = loaded.problem.study.to_ir()["dynamics"]
        self.assertIsNone(dynamics["fixed_timestep"])
        self.assertEqual(dynamics["adaptive_timestep"]["atol"], 1e-6)
        self.assertEqual(dynamics["adaptive_timestep"]["dt_initial"], 2e-15)
        self.assertEqual(dynamics["integrator"], "rk23")

    def test_flat_stage_sequence_is_supported(self) -> None:
        script = """
        import fullmag as fm

        fm.engine("fdm")
        fm.cell(5e-9, 5e-9, 5e-9)
        body = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.uniform(1, 0, 0)
        fm.solver(dt=1e-13)
        fm.save("m", every=1e-12)
        fm.relax(max_steps=25)
        fm.run(4e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_flat_sequence.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path)

        self.assertEqual(loaded.entrypoint_kind, "flat_sequence")
        self.assertEqual(loaded.default_until_seconds, 4e-12)
        self.assertEqual(len(loaded.stages), 2)
        self.assertEqual(loaded.stages[0].entrypoint_kind, "flat_relax")
        self.assertEqual(loaded.stages[1].entrypoint_kind, "flat_run")
        self.assertEqual(loaded.stages[0].problem.study.to_ir()["kind"], "relaxation")
        self.assertEqual(loaded.stages[1].problem.study.to_ir()["kind"], "time_evolution")

    def test_flat_geometry_mesh_api_builds_explicit_mesh_asset(self) -> None:
        script = """
        import fullmag as fm

        fm.engine("fem")
        body = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.uniform(1, 0, 0)
        body.mesh(hmax=4e-9, order=2).build()
        fm.solver(dt=1e-13)
        fm.relax(max_steps=25)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_flat_geometry_mesh.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            with patch("fullmag.world.build_geometry_assets_for_request", return_value=None) as mocked:
                loaded = fm.load_problem_from_script(path)

        self.assertEqual(mocked.call_count, 1)
        self.assertEqual(mocked.call_args.kwargs["requested_backend"], fm.BackendTarget.FEM)
        fem = mocked.call_args.kwargs["discretization"].fem
        self.assertIsNotNone(fem)
        self.assertEqual(fem.order, 2)
        self.assertEqual(fem.hmax, 4e-9)
        workflow = loaded.problem.runtime_metadata["mesh_workflow"]
        self.assertTrue(workflow["explicit_mesh_api"])
        self.assertTrue(workflow["build_requested"])
        self.assertEqual(workflow["fem"]["order"], 2)
        self.assertEqual(workflow["fem"]["hmax"], 4e-9)

    def test_flat_geometry_mesh_api_rejects_conflicting_per_geometry_mesh_settings(self) -> None:
        script = """
        import fullmag as fm

        fm.engine("fem")
        a = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="a")
        b = fm.geometry(fm.Box(80e-9, 20e-9, 5e-9), name="b")
        a.Ms = 800e3
        a.Aex = 13e-12
        b.Ms = 800e3
        b.Aex = 13e-12
        a.mesh(hmax=4e-9, order=1)
        b.mesh(hmax=8e-9, order=1)
        fm.run(1e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_flat_geometry_mesh_conflict.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Per-geometry FEM mesh settings are not yet supported"):
                fm.load_problem_from_script(path)

    def test_flat_solver_accepts_g_factor(self) -> None:
        script = """
        import fullmag as fm

        fm.engine("fdm")
        fm.cell(5e-9, 5e-9, 5e-9)
        body = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.uniform(1, 0, 0)
        fm.solver(dt=1e-13, g=2.115)
        fm.run(1e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_flat_solver_g.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path)

        gamma = loaded.problem.study.to_ir()["dynamics"]["gyromagnetic_ratio"]
        self.assertGreater(gamma, 2.211e5)

    def test_flat_script_can_request_interactive_session(self) -> None:
        script = """
        import fullmag as fm

        fm.engine("fdm")
        fm.interactive(True)
        fm.cell(5e-9, 5e-9, 5e-9)
        body = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.uniform(1, 0, 0)
        fm.solver(dt=1e-13)
        fm.save("m", every=1e-12)
        fm.run(4e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_flat_interactive.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path)

        ir = loaded.stages[0].to_ir(
            requested_backend=fm.BackendTarget.FDM,
            execution_mode=fm.ExecutionMode.STRICT,
            execution_precision=fm.ExecutionPrecision.DOUBLE,
            script_source=loaded.script_source,
        )
        self.assertTrue(
            ir["problem_meta"]["runtime_metadata"]["interactive_session_requested"]
        )

    def test_llg_requires_supported_integrator_and_positive_timestep(self) -> None:
        with self.assertRaisesRegex(ValueError, "integrator must be one of"):
            fm.LLG(integrator="bogus")

        with self.assertRaisesRegex(ValueError, "fixed_timestep"):
            fm.LLG(fixed_timestep=0.0)

    def test_helper_exports_ir_for_flat_workspace_script(self) -> None:
        script = """
        import fullmag as fm

        fm.engine("fdm")
        fm.cell(5e-9, 5e-9, 5e-9)
        body = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.uniform(1, 0, 0)
        fm.solver(dt=1e-13)
        fm.save("m", every=1e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_flat_workspace.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")

            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                exit_code = runtime_helper.main(
                    [
                        "export-ir",
                        "--script",
                        str(path),
                    ]
                )

        self.assertEqual(exit_code, 0)
        ir = json.loads(stdout.getvalue())
        self.assertEqual(ir["problem_meta"]["entrypoint_kind"], "flat_workspace")
        self.assertEqual(ir["study"]["dynamics"]["integrator"], "auto")

    def test_cli_runs_script_and_preserves_script_provenance(self) -> None:
        script = """
        import fullmag as fm

        DEFAULT_UNTIL = 1e-12

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

    def test_cli_uses_until_from_flat_run_script(self) -> None:
        script = """
        import fullmag as fm

        fm.engine("fdm")
        fm.cell(5e-9, 5e-9, 5e-9)
        body = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.uniform(1, 0, 0)
        fm.solver(dt=1e-13)
        fm.save("m", every=1e-12)
        fm.run(4e-12)
        """

        captured: dict[str, object] = {}

        def fake_run_problem_json(ir, until_seconds, output_dir):
            captured["until_seconds"] = until_seconds
            captured["entrypoint_kind"] = ir["problem_meta"]["entrypoint_kind"]
            return {
                "status": "completed",
                "steps": [],
                "final_magnetization": None,
            }

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_cli_flat_run.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")

            with patch(
                "fullmag.runtime.cli.run_problem_json",
                side_effect=fake_run_problem_json,
            ):
                exit_code = runtime_cli.main([str(path), "--json"])

        self.assertEqual(exit_code, 0)
        self.assertEqual(captured["until_seconds"], 4e-12)
        self.assertEqual(captured["entrypoint_kind"], "flat_run")

    def test_cli_executes_flat_stage_sequence_with_continuation(self) -> None:
        script = """
        import fullmag as fm

        fm.engine("fdm")
        fm.cell(5e-9, 5e-9, 5e-9)
        body = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.uniform(1, 0, 0)
        fm.solver(dt=1e-13)
        fm.save("m", every=1e-12)
        fm.relax(max_steps=25)
        fm.run(4e-12)
        """

        calls: list[tuple[dict[str, object], float, str | None]] = []

        def fake_run_problem_json(ir, until_seconds, output_dir):
            calls.append((ir, until_seconds, output_dir))
            return {
                "status": "completed",
                "steps": [
                    {
                        "step": 1,
                        "time": until_seconds,
                        "dt": until_seconds,
                        "e_ex": 1.0,
                        "e_demag": 2.0,
                        "e_ext": 0.0,
                        "e_total": 3.0,
                        "max_dm_dt": 4.0,
                        "max_h_eff": 5.0,
                        "wall_time_ns": 42,
                    }
                ],
                "final_magnetization": [[1.0, 0.0, 0.0]],
            }

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_cli_flat_sequence.py"
            output_dir = Path(tmp_dir) / "artifacts"
            path.write_text(textwrap.dedent(script), encoding="utf-8")

            with patch(
                "fullmag.runtime.cli.run_problem_json",
                side_effect=fake_run_problem_json,
            ):
                exit_code = runtime_cli.main(
                    [str(path), "--json", "--output-dir", str(output_dir)]
                )
            manifest = json.loads(
                (output_dir / "sequence_manifest.json").read_text(encoding="utf-8")
            )

        self.assertEqual(exit_code, 0)
        self.assertEqual(len(calls), 2)
        self.assertAlmostEqual(calls[1][1], 4e-12)
        self.assertEqual(calls[0][0]["problem_meta"]["entrypoint_kind"], "flat_relax")
        self.assertEqual(calls[1][0]["problem_meta"]["entrypoint_kind"], "flat_run")
        self.assertEqual(
            calls[1][0]["magnets"][0]["initial_magnetization"]["kind"],
            "sampled_field",
        )
        self.assertEqual(
            calls[0][2],
            str(output_dir / "stage_01_flat_relax"),
        )
        self.assertEqual(
            calls[1][2],
            str(output_dir / "stage_02_flat_run"),
        )
        self.assertEqual(manifest["kind"], "flat_sequence")
        self.assertEqual(len(manifest["stages"]), 2)
        self.assertEqual(manifest["stages"][0]["output_dir"], str(output_dir / "stage_01_flat_relax"))
        self.assertEqual(manifest["stages"][1]["output_dir"], str(output_dir / "stage_02_flat_run"))

    def test_cli_json_mode_prints_machine_readable_summary(self) -> None:
        script = """
        import fullmag as fm

        DEFAULT_UNTIL = 1e-12

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
                exit_code = runtime_cli.main([str(path), "--json"])

        self.assertEqual(exit_code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["problem_name"], "json_problem")
        self.assertEqual(payload["status"], "completed")
        self.assertEqual(payload["precision"], "double")

    def test_cli_uses_default_until_from_script_when_flag_is_omitted(self) -> None:
        script = """
        import fullmag as fm

        DEFAULT_UNTIL = 2.5e-12

        problem = fm.Problem(
            name="default_until_problem",
            magnets=[
                fm.Ferromagnet(
                    name="track",
                    geometry=fm.Box(size=(100e-9, 20e-9, 5e-9), name="track"),
                    material=fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.1),
                )
            ],
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
            captured["until_seconds"] = until_seconds
            return {
                "status": "completed",
                "steps": [],
                "final_magnetization": None,
            }

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_default_until.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            with patch(
                "fullmag.runtime.cli.run_problem_json",
                side_effect=fake_run_problem_json,
            ):
                exit_code = runtime_cli.main([str(path), "--json"])

        self.assertEqual(exit_code, 0)
        self.assertEqual(captured["until_seconds"], 2.5e-12)

    def test_cli_derives_until_from_relaxation_study(self) -> None:
        script = """
        import fullmag as fm

        problem = fm.Problem(
            name="relax_default_until_problem",
            magnets=[
                fm.Ferromagnet(
                    name="track",
                    geometry=fm.Box(size=(100e-9, 20e-9, 5e-9), name="track"),
                    material=fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.1),
                )
            ],
            energy=[fm.Exchange()],
            study=fm.Relaxation(
                max_steps=250,
                dynamics=fm.LLG(fixed_timestep=2e-13),
                outputs=[fm.SaveField("m", every=1e-12)],
            ),
            discretization=fm.DiscretizationHints(
                fdm=fm.FDM(cell=(5e-9, 5e-9, 5e-9)),
            ),
        )
        """

        captured: dict[str, object] = {}

        def fake_run_problem_json(ir, until_seconds, output_dir):
            captured["until_seconds"] = until_seconds
            return {
                "status": "completed",
                "steps": [],
                "final_magnetization": None,
            }

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_relax_default_until.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            with patch(
                "fullmag.runtime.cli.run_problem_json",
                side_effect=fake_run_problem_json,
            ):
                exit_code = runtime_cli.main([str(path), "--json"])

        self.assertEqual(exit_code, 0)
        self.assertEqual(captured["until_seconds"], 250 * 2e-13)

    def test_cli_derives_until_from_adaptive_relaxation_initial_timestep(self) -> None:
        script = """
        import fullmag as fm

        problem = fm.Problem(
            name="adaptive_relax_default_until_problem",
            magnets=[
                fm.Ferromagnet(
                    name="track",
                    geometry=fm.Box(size=(100e-9, 20e-9, 5e-9), name="track"),
                    material=fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.1),
                )
            ],
            energy=[fm.Exchange()],
            study=fm.Relaxation(
                max_steps=250,
                dynamics=fm.LLG(
                    integrator="rk23",
                    adaptive_timestep=fm.AdaptiveTimestep(atol=1e-6, dt_initial=3e-13),
                ),
                outputs=[fm.SaveField("m", every=1e-12)],
            ),
            discretization=fm.DiscretizationHints(
                fdm=fm.FDM(cell=(5e-9, 5e-9, 5e-9)),
            ),
        )
        """

        captured: dict[str, object] = {}

        def fake_run_problem_json(ir, until_seconds, output_dir):
            captured["until_seconds"] = until_seconds
            return {
                "status": "completed",
                "steps": [],
                "final_magnetization": None,
            }

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_adaptive_relax_default_until.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            with patch(
                "fullmag.runtime.cli.run_problem_json",
                side_effect=fake_run_problem_json,
            ):
                exit_code = runtime_cli.main([str(path), "--json"])

        self.assertEqual(exit_code, 0)
        self.assertEqual(captured["until_seconds"], 250 * 3e-13)

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

    def test_helper_uses_problem_runtime_when_no_overrides_are_passed(self) -> None:
        script = """
        import fullmag as fm

        problem = fm.Problem(
            name="runtime_selected_problem",
            magnets=[
                fm.Ferromagnet(
                    name="track",
                    geometry=fm.Box(size=(100e-9, 20e-9, 5e-9), name="track"),
                    material=fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.1),
                )
            ],
            energy=[fm.Exchange()],
            study=fm.TimeEvolution(
                dynamics=fm.LLG(),
                outputs=[fm.SaveField("m", every=1e-12)],
            ),
            discretization=fm.DiscretizationHints(
                fdm=fm.FDM(cell=(5e-9, 5e-9, 5e-9)),
            ),
            runtime=fm.backend.cuda(1).device(0).threads(6).engine("fdm").precision("single"),
        )
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_runtime_helper.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")

            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                exit_code = runtime_helper.main(
                    [
                        "export-ir",
                        "--script",
                        str(path),
                    ]
                )

        self.assertEqual(exit_code, 0)
        ir = json.loads(stdout.getvalue())
        self.assertEqual(ir["backend_policy"]["requested_backend"], "fdm")
        self.assertEqual(ir["backend_policy"]["execution_precision"], "single")
        self.assertEqual(
            ir["problem_meta"]["runtime_metadata"]["runtime_selection"]["device_index"], 0
        )
        self.assertEqual(
            ir["problem_meta"]["runtime_metadata"]["runtime_selection"]["cpu_threads"], 6
        )

    def test_helper_exports_run_config_with_default_until(self) -> None:
        script = """
        import fullmag as fm

        DEFAULT_UNTIL = 3e-12

        problem = fm.Problem(
            name="runtime_config_problem",
            magnets=[
                fm.Ferromagnet(
                    name="track",
                    geometry=fm.Box(size=(100e-9, 20e-9, 5e-9), name="track"),
                    material=fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.1),
                )
            ],
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
            path = Path(tmp_dir) / "script_run_config.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")

            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                exit_code = runtime_helper.main(
                    [
                        "export-run-config",
                        "--script",
                        str(path),
                    ]
                )

        self.assertEqual(exit_code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["default_until_seconds"], 3e-12)
        self.assertEqual(payload["ir"]["problem_meta"]["name"], "runtime_config_problem")
        self.assertIn("shared_geometry_assets", payload)

    def test_helper_exports_run_config_with_flat_stage_sequence(self) -> None:
        script = """
        import fullmag as fm

        fm.engine("fdm")
        fm.cell(5e-9, 5e-9, 5e-9)
        body = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.uniform(1, 0, 0)
        fm.solver(dt=1e-13)
        fm.save("m", every=1e-12)
        fm.relax(max_steps=25)
        fm.run(4e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_run_config_sequence.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")

            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                exit_code = runtime_helper.main(
                    [
                        "export-run-config",
                        "--script",
                        str(path),
                    ]
                )

        self.assertEqual(exit_code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["ir"]["problem_meta"]["entrypoint_kind"], "flat_sequence")
        self.assertEqual(len(payload["stages"]), 2)
        self.assertIn("shared_geometry_assets", payload)
        self.assertEqual(payload["stages"][0]["entrypoint_kind"], "flat_relax")
        self.assertEqual(payload["stages"][1]["entrypoint_kind"], "flat_run")
        self.assertEqual(payload["stages"][1]["default_until_seconds"], 4e-12)


if __name__ == "__main__":
    unittest.main()
