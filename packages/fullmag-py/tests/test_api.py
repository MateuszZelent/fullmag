from __future__ import annotations

import contextlib
import copy
import io
import json
import os
import importlib.util
import struct
import textwrap
import unittest
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import numpy as np

import fullmag as fm
import fullmag.world as flat_world
from fullmag.meshing.voxelization import VoxelMaskData
from fullmag.runtime import cli as runtime_cli
from fullmag.runtime import helper as runtime_helper
from fullmag.runtime.loader import load_problem_from_script
from fullmag.runtime.scene_document import build_scene_document_from_builder
from fullmag.runtime.scene_document import build_builder_from_scene_document
from fullmag.runtime.scene_document import builder_overrides_from_scene_document
from fullmag.runtime.script_builder import export_builder_draft, rewrite_loaded_problem_script
from fullmag.meshing.gmsh_bridge import MeshData


class ProblemApiTests(unittest.TestCase):
    def _write_binary_cube_stl(self, path: Path) -> None:
        vertices = np.asarray(
            [
                [-1.0, -1.0, -1.0],
                [1.0, -1.0, -1.0],
                [1.0, 1.0, -1.0],
                [-1.0, 1.0, -1.0],
                [-1.0, -1.0, 1.0],
                [1.0, -1.0, 1.0],
                [1.0, 1.0, 1.0],
                [-1.0, 1.0, 1.0],
            ],
            dtype=np.float32,
        )
        faces = [
            (0, 1, 2), (0, 2, 3),
            (4, 6, 5), (4, 7, 6),
            (0, 4, 5), (0, 5, 1),
            (1, 5, 6), (1, 6, 2),
            (2, 6, 7), (2, 7, 3),
            (3, 7, 4), (3, 4, 0),
        ]
        with path.open("wb") as handle:
            header = b"fullmag cube".ljust(80, b"\0")
            handle.write(header)
            handle.write(struct.pack("<I", len(faces)))
            for i0, i1, i2 in faces:
                handle.write(struct.pack("<3f", 0.0, 0.0, 0.0))
                for index in (i0, i1, i2):
                    handle.write(struct.pack("<3f", *vertices[index]))
                handle.write(struct.pack("<H", 0))

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
            m0=fm.texture.uniform((1.0, 0.0, 0.0)),
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
                fem=fm.FEM(order=1, maximum_element_size=2e-9),
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
        self.assertNotIn("interface_normal", ir["energy_terms"][2])
        self.assertEqual(ir["study"]["kind"], "time_evolution")
        self.assertEqual(ir["study"]["dynamics"]["integrator"], "auto")
        self.assertEqual(ir["study"]["sampling"]["outputs"][0]["name"], "m")
        self.assertEqual(
            ir["problem_meta"]["runtime_metadata"]["runtime_selection"]["device"], "auto"
        )

    def test_waveguide_geometries_export_canonical_ir(self) -> None:
        sin_geometry = fm.SinWaveguide(
            length=400e-9,
            width=40e-9,
            height=10e-9,
            period=100e-9,
            amplitude=20e-9,
            phase=0.25,
            z0=-5e-9,
            name="sinus",
        )
        arch_geometry = fm.ArchWaveguide(
            length=400e-9,
            width=40e-9,
            height=10e-9,
            arch_height=-80e-9,
            z0=10e-9,
            name="arch",
        )

        self.assertEqual(
            sin_geometry.to_ir(),
            {
                "name": "sinus",
                "kind": "sin_waveguide",
                "length": 400e-9,
                "width": 40e-9,
                "height": 10e-9,
                "period": 100e-9,
                "amplitude": 20e-9,
                "phase": 0.25,
                "z0": -5e-9,
            },
        )
        self.assertEqual(
            arch_geometry.to_ir(),
            {
                "name": "arch",
                "kind": "arch_waveguide",
                "length": 400e-9,
                "width": 40e-9,
                "height": 10e-9,
                "arch_height": -80e-9,
                "z0": 10e-9,
            },
        )

    def test_waveguide_geometry_validation_rejects_invalid_dimensions(self) -> None:
        with self.assertRaisesRegex(ValueError, "length"):
            fm.SinWaveguide(
                length=0.0,
                width=40e-9,
                height=10e-9,
                period=100e-9,
                amplitude=20e-9,
            )
        with self.assertRaisesRegex(ValueError, "period"):
            fm.SinWaveguide(
                length=1.0,
                width=1.0,
                height=1.0,
                period=0.0,
                amplitude=0.0,
            )
        with self.assertRaisesRegex(ValueError, "width"):
            fm.ArchWaveguide(
                length=1.0,
                width=0.0,
                height=1.0,
                arch_height=0.0,
            )

    def test_problem_to_ir_serializes_fdm_pbc_truncated_images(self) -> None:
        problem = replace(
            self._build_problem(),
            pbc=fm.FdmPbc(
                axes=(True, False, True),
                demag="truncated_images",
                image_counts=(8, 0, 3),
            ),
        )
        ir = problem.to_ir()

        self.assertEqual(
            ir["pbc"],
            {
                "axes": ["periodic", "open", "periodic"],
                "demag": "truncated_images",
                "image_counts": [8, 0, 3],
            },
        )

    def test_flat_pbc_configures_periodic_demag_images(self) -> None:
        fm.reset()
        try:
            fm.pbc(x=True, y=True, demag="truncated_images", images=(6, 6, 0))

            self.assertEqual(
                flat_world._state._pbc.to_ir(),
                {
                    "axes": ["periodic", "periodic", "open"],
                    "demag": "truncated_images",
                    "image_counts": [6, 6, 0],
                },
            )
        finally:
            fm.reset()

    def test_eigenmodes_serializes_floquet_pair_ids(self) -> None:
        problem = replace(
            self._build_problem(),
            energy=[fm.Exchange()],
            study=fm.Eigenmodes(
                outputs=[fm.SaveSpectrum()],
                include_demag=False,
                k_sampling=fm.KPoint("X", (1.0e7, 0.0, 0.0)),
                spin_wave_bc=fm.FloquetBC(pair_ids=["x_periodic"]),
            ),
        )
        ir = problem.to_ir()

        self.assertEqual(
            ir["study"]["spin_wave_bc"],
            {
                "kind": "floquet",
                "pair_ids": ["x_periodic"],
                "phase_convention": "exp_minus_i_k_dot_delta_r",
            },
        )

    def test_interfacial_dmi_interface_normal_serializes_to_ir(self) -> None:
        term = fm.InterfacialDMI(D=3e-3, interface_normal=(0.0, 3.0, 4.0))
        self.assertEqual(
            term.to_ir(),
            {"kind": "interfacial_dmi", "D": 3e-3, "interface_normal": [0.0, 3.0, 4.0]},
        )

    def test_interfacial_dmi_rejects_invalid_interface_normal_shape(self) -> None:
        with self.assertRaises(ValueError):
            fm.InterfacialDMI(D=3e-3, interface_normal=(0.0, 1.0))

    def test_problem_to_ir_materializes_preset_texture_for_fem_mesh(self) -> None:
        geometry = fm.Box(size=(40e-9, 20e-9, 10e-9), name="film")
        material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.01)
        magnet = fm.Ferromagnet(
            name="film",
            geometry=geometry,
            material=material,
            m0=fm.texture.vortex(core_polarity=1, circulation=1),
        )
        problem = fm.Problem(
            name="preset_fem_materialization",
            magnets=[magnet],
            energy=[fm.Exchange()],
            study=fm.TimeEvolution(dynamics=fm.LLG(), outputs=[fm.SaveScalar("E_total", every=1e-12)]),
            discretization=fm.DiscretizationHints(fem=fm.FEM(order=1, maximum_element_size=10e-9)),
        )

        with patch(
            "fullmag.model.problem.build_geometry_assets_for_request",
            return_value={
                "fdm_grid_assets": [],
                "fem_mesh_assets": [
                    {
                        "geometry_name": "film",
                        "mesh_source": None,
                        "mesh": {
                            "mesh_name": "film",
                            "nodes": [
                                [0.0, 0.0, 0.0],
                                [10e-9, 0.0, 0.0],
                                [0.0, 10e-9, 0.0],
                                [0.0, 0.0, 10e-9],
                            ],
                            "elements": [[0, 1, 2, 3]],
                            "element_markers": [1],
                            "boundary_faces": [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]],
                            "boundary_markers": [1, 1, 1, 1],
                        },
                    }
                ],
            },
        ):
            ir = problem.to_ir(requested_backend=fm.BackendTarget.FEM)
        initial = ir["magnets"][0]["initial_magnetization"]

        self.assertEqual(initial["kind"], "sampled_field")
        self.assertGreater(len(initial["values"]), 0)
        self.assertNotIn("preset_kind", initial)

    def test_problem_to_ir_keeps_preset_texture_for_shared_domain_fem_mesh(self) -> None:
        geometry = fm.Box(size=(40e-9, 20e-9, 10e-9), name="film")
        material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.01)
        magnet = fm.Ferromagnet(
            name="film",
            geometry=geometry,
            material=material,
            m0=fm.texture.vortex(core_polarity=1, circulation=1),
        )
        problem = fm.Problem(
            name="preset_shared_domain_fem",
            magnets=[magnet],
            energy=[fm.Exchange()],
            study=fm.TimeEvolution(dynamics=fm.LLG(), outputs=[fm.SaveScalar("E_total", every=1e-12)]),
            discretization=fm.DiscretizationHints(fem=fm.FEM(order=1, maximum_element_size=10e-9)),
        )

        with patch(
            "fullmag.model.problem.build_geometry_assets_for_request",
            return_value={
                "fdm_grid_assets": [],
                "fem_mesh_assets": [],
                "fem_domain_mesh_asset": {
                    "mesh_source": None,
                    "mesh": {
                        "mesh_name": "study_domain",
                        "nodes": [
                            [0.0, 0.0, 0.0],
                            [10e-9, 0.0, 0.0],
                            [0.0, 10e-9, 0.0],
                            [0.0, 0.0, 10e-9],
                            [20e-9, 20e-9, 20e-9],
                        ],
                        "elements": [[0, 1, 2, 3]],
                        "element_markers": [1],
                        "boundary_faces": [[0, 1, 2]],
                        "boundary_markers": [1],
                    },
                    "region_markers": [{"geometry_name": "film", "marker": 1}],
                    "build_report": None,
                },
            },
        ):
            ir = problem.to_ir(requested_backend=fm.BackendTarget.FEM)
        initial = ir["magnets"][0]["initial_magnetization"]

        self.assertEqual(initial["kind"], "preset_texture")
        self.assertEqual(initial["preset_kind"], "vortex")
        self.assertNotIn("values", initial)

    def test_problem_to_ir_materializes_preset_texture_in_object_space_for_translated_geometry(self) -> None:
        geometry = fm.Box(size=(40e-9, 20e-9, 10e-9), name="film").translate((10e-9, 0.0, 0.0))
        material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.01)
        magnet = fm.Ferromagnet(
            name="film",
            geometry=geometry,
            material=material,
            m0=fm.texture.two_domain(
                left=(1.0, 0.0, 0.0),
                right=(-1.0, 0.0, 0.0),
                wall=(0.0, 1.0, 0.0),
                normal_axis="x",
            ),
        )
        problem = fm.Problem(
            name="preset_fem_object_space",
            magnets=[magnet],
            energy=[fm.Exchange()],
            study=fm.TimeEvolution(dynamics=fm.LLG(), outputs=[fm.SaveScalar("E_total", every=1e-12)]),
            discretization=fm.DiscretizationHints(fem=fm.FEM(order=1, maximum_element_size=10e-9)),
        )

        with patch(
            "fullmag.model.problem.build_geometry_assets_for_request",
            return_value={
                "fdm_grid_assets": [],
                "fem_mesh_assets": [
                    {
                        "geometry_name": geometry.geometry_name,
                        "mesh_source": None,
                        "mesh": {
                            "mesh_name": geometry.geometry_name,
                            "nodes": [
                                [9e-9, 0.0, 0.0],   # x_local < 0 -> left
                                [11e-9, 0.0, 0.0],  # x_local > 0 -> right
                                [10e-9, 0.0, 0.0],  # x_local = 0 -> wall
                                [10e-9, 0.0, 1e-9],
                            ],
                            "elements": [[0, 1, 2, 3]],
                            "element_markers": [1],
                            "boundary_faces": [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]],
                            "boundary_markers": [1, 1, 1, 1],
                        },
                    }
                ],
            },
        ):
            ir = problem.to_ir(requested_backend=fm.BackendTarget.FEM)

        values = ir["magnets"][0]["initial_magnetization"]["values"]
        self.assertGreater(values[0][0], 0.9)
        self.assertLess(values[1][0], -0.9)
        self.assertGreater(values[2][1], 0.9)

    def test_problem_to_ir_materializes_preset_texture_in_world_space_for_translated_geometry(self) -> None:
        geometry = fm.Box(size=(40e-9, 20e-9, 10e-9), name="film").translate((10e-9, 0.0, 0.0))
        material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.01)
        magnet = fm.Ferromagnet(
            name="film",
            geometry=geometry,
            material=material,
            m0=fm.texture.two_domain(
                left=(1.0, 0.0, 0.0),
                right=(-1.0, 0.0, 0.0),
                wall=(0.0, 1.0, 0.0),
                normal_axis="x",
            ).with_mapping(space="world"),
        )
        problem = fm.Problem(
            name="preset_fem_world_space",
            magnets=[magnet],
            energy=[fm.Exchange()],
            study=fm.TimeEvolution(dynamics=fm.LLG(), outputs=[fm.SaveScalar("E_total", every=1e-12)]),
            discretization=fm.DiscretizationHints(fem=fm.FEM(order=1, maximum_element_size=10e-9)),
        )

        with patch(
            "fullmag.model.problem.build_geometry_assets_for_request",
            return_value={
                "fdm_grid_assets": [],
                "fem_mesh_assets": [
                    {
                        "geometry_name": geometry.geometry_name,
                        "mesh_source": None,
                        "mesh": {
                            "mesh_name": geometry.geometry_name,
                            "nodes": [
                                [9e-9, 0.0, 0.0],
                                [11e-9, 0.0, 0.0],
                                [10e-9, 0.0, 0.0],
                                [10e-9, 0.0, 1e-9],
                            ],
                            "elements": [[0, 1, 2, 3]],
                            "element_markers": [1],
                            "boundary_faces": [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]],
                            "boundary_markers": [1, 1, 1, 1],
                        },
                    }
                ],
            },
        ):
            ir = problem.to_ir(requested_backend=fm.BackendTarget.FEM)

        values = ir["magnets"][0]["initial_magnetization"]["values"]
        self.assertLess(values[0][0], -0.9)
        self.assertLess(values[1][0], -0.9)
        self.assertLess(values[2][0], -0.9)

    def test_problem_to_ir_materializes_preset_texture_for_fdm_grid(self) -> None:
        geometry = fm.Cylinder(radius=20e-9, height=10e-9, name="dot")
        material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.01)
        magnet = fm.Ferromagnet(
            name="dot",
            geometry=geometry,
            material=material,
            m0=fm.texture.neel_skyrmion(radius=10e-9, wall_width=4e-9),
        )
        problem = fm.Problem(
            name="preset_fdm_materialization",
            magnets=[magnet],
            energy=[fm.Exchange()],
            study=fm.TimeEvolution(dynamics=fm.LLG(), outputs=[fm.SaveScalar("E_total", every=1e-12)]),
            discretization=fm.DiscretizationHints(fdm=fm.FDM(cell=(5e-9, 5e-9, 5e-9))),
        )

        ir = problem.to_ir(requested_backend=fm.BackendTarget.FDM)
        initial = ir["magnets"][0]["initial_magnetization"]

        self.assertEqual(initial["kind"], "sampled_field")
        self.assertGreater(len(initial["values"]), 0)

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
        initializer = fm.texture.random(seed=42)
        self.assertEqual(
            initializer.to_ir(),
            {
                "kind": "preset_texture",
                "preset_kind": "random",
                "preset_params": {"seed": 42},
                "mapping": {
                    "space": "object",
                    "projection": "object_local",
                    "clamp_mode": "none",
                },
                "texture_transform": {
                    "translation": [0.0, 0.0, 0.0],
                    "rotation_quat": [0.0, 0.0, 0.0, 1.0],
                    "scale": [1.0, 1.0, 1.0],
                    "pivot": [0.0, 0.0, 0.0],
                },
                "ui_label": None,
                "preview_proxy": "none",
            },
        )

    def test_legacy_random_seeded_initializer_aliases_to_random(self) -> None:
        self.assertEqual(fm.texture.random_seeded(seed=42).to_ir(), fm.texture.random(seed=42).to_ir())

    def test_magnetization_state_roundtrip_across_formats(self) -> None:
        values = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]

        with TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            json_path = tmp_path / "state.json"
            zarr_path = tmp_path / "state.zarr.zip"
            h5_path = tmp_path / "state.h5"

            fm.save_magnetization(json_path, values)
            fm.save_magnetization(zarr_path, values)
            fm.save_magnetization(h5_path, values)

            for path in (json_path, zarr_path, h5_path):
                loaded = fm.load_magnetization(path)
                self.assertEqual(loaded.values, [tuple(row) for row in values])

    def test_flat_magnet_handle_loadfile_assigns_sampled_state(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            state_path = tmp_path / "m_state.json"
            fm.save_magnetization(state_path, [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])

            fm.reset()
            fm.engine("fdm")
            fm.cell(5e-9, 5e-9, 5e-9)
            flower = fm.geometry(fm.Box(size=(10e-9, 10e-9, 5e-9), name="flower"), name="flower")
            flower.Ms = 800e3
            flower.Aex = 13e-12
            flower.alpha = 0.2
            loaded = flower.m.loadfile(state_path)

            problem = flat_world._build_problem()
            self.assertIsInstance(problem.magnets[0].m0, fm.init.SampledMagnetization)
            self.assertEqual(problem.magnets[0].m0.values, loaded.values)
            self.assertEqual(problem.magnets[0].m0.source_format, "json")

    def test_script_builder_rewrites_file_backed_initial_state(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            state_path = tmp_path / "state.json"
            script_path = tmp_path / "builder_state.py"
            fm.save_magnetization(state_path, [[1.0, 0.0, 0.0]])
            script_path.write_text(
                textwrap.dedent(
                    """
                    import fullmag as fm

                    fm.engine("fdm")
                    fm.cell(5e-9, 5e-9, 5e-9)

                    flower = fm.geometry(fm.Box(size=(5e-9, 5e-9, 5e-9), name="flower"), name="flower")
                    flower.Ms = 800e3
                    flower.Aex = 13e-12
                    flower.alpha = 0.2
                    flower.m.loadfile("state.json")

                    fm.run(1e-12)
                    """
                ).strip()
                + "\n",
                encoding="utf-8",
            )

            loaded = load_problem_from_script(script_path, lightweight_assets=True)
            rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]

            self.assertIn('flower.m.loadfile("state.json")', rewritten)

    def test_script_builder_rewrites_random_initial_state_with_random_factory(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            script_path = Path(tmp_dir) / "builder_random.py"
            script_path.write_text(
                textwrap.dedent(
                    """
                    import fullmag as fm

                    fm.engine("fdm")
                    fm.cell(5e-9, 5e-9, 5e-9)

                    body = fm.geometry(fm.Box(size=(5e-9, 5e-9, 5e-9), name="body"), name="body")
                    body.Ms = 800e3
                    body.Aex = 13e-12
                    body.alpha = 0.2
                    body.m = fm.texture.random(seed=1)
                    """
                ).strip()
                + "\n",
                encoding="utf-8",
            )

            loaded = load_problem_from_script(script_path, lightweight_assets=True)
            rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]

            self.assertIn("body.m = fm.texture.random(seed=1)", rewritten)
            self.assertNotIn("random_seeded", rewritten)

    def test_script_builder_rewrites_arch_waveguide_geometry(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            script_path = Path(tmp_dir) / "arch_builder.py"
            script_path.write_text(
                textwrap.dedent(
                    """
                    import fullmag as fm

                    study = fm.study("arch_builder")
                    study.engine("fdm")
                    study.cell(5e-9, 5e-9, 5e-9)

                    body = study.geometry(
                        fm.ArchWaveguide(
                            length=400e-9,
                            width=40e-9,
                            height=10e-9,
                            arch_height=-80e-9,
                            z0=10e-9,
                            name="arch_waveguide",
                        ),
                        name="arch_waveguide",
                    )
                    body.Ms = 800e3
                    body.Aex = 13e-12
                    body.alpha = 0.2
                    body.m = fm.texture.uniform(1, 0, 0)
                    """
                ).strip()
                + "\n",
                encoding="utf-8",
            )

            loaded = load_problem_from_script(script_path, lightweight_assets=True)
            rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]

            self.assertIn("fm.ArchWaveguide(", rewritten)
            self.assertIn("arch_height=-8e-08", rewritten)
            self.assertNotIn("unsupported geometry kind", rewritten)

    def test_arch_waveguide_scene_document_exports_geometry_params(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            script_path = Path(tmp_dir) / "arch_scene.py"
            script_path.write_text(
                textwrap.dedent(
                    """
                    import fullmag as fm

                    study = fm.study("arch_scene")
                    study.engine("fem")
                    body = study.geometry(
                        fm.ArchWaveguide(
                            length=2.5e-6,
                            width=1.0e-6,
                            height=2e-9,
                            arch_height=50e-9,
                            z0=-25e-9,
                            name="arch_waveguide",
                        ),
                        name="arch_waveguide",
                    )
                    body.Ms = 956e3
                    body.Aex = 10e-12
                    body.alpha = 0.1
                    body.m = fm.texture.uniform(1, 0, 0)
                    """
                ).strip()
                + "\n",
                encoding="utf-8",
            )

            loaded = load_problem_from_script(script_path, lightweight_assets=True)
            draft = export_builder_draft(loaded)
            scene = build_scene_document_from_builder(draft)
            params = scene["objects"][0]["geometry"]["geometry_params"]

            self.assertEqual(scene["objects"][0]["geometry"]["geometry_kind"], "ArchWaveguide")
            self.assertEqual(params["length"], 2.5e-6)
            self.assertEqual(params["width"], 1.0e-6)
            self.assertEqual(params["height"], 2e-9)
            self.assertEqual(params["arch_height"], 50e-9)
            self.assertEqual(params["z0"], -25e-9)

    def test_arch_waveguide_example_uses_public_mesh_control_contract(self) -> None:
        example_path = Path(__file__).resolve().parents[3] / "examples" / "arch_waveguide_relax_50nm.py"
        loaded = load_problem_from_script(example_path, lightweight_assets=True)

        self.assertEqual(loaded.entrypoint_kind, "flat_workspace")
        self.assertEqual(len(loaded.stages), 1)
        mesh_workflow = loaded.problem.runtime_metadata["mesh_workflow"]
        per_geometry = mesh_workflow["per_geometry"]
        self.assertEqual(len(per_geometry), 1)
        arch_mesh = per_geometry[0]
        self.assertEqual(arch_mesh["geometry"], "arch_waveguide")
        self.assertEqual(arch_mesh["maximum_element_size"], 6e-9)
        self.assertEqual(arch_mesh["minimum_element_size"], 1.8e-9)
        self.assertEqual(arch_mesh["maximum_element_growth_rate"], 1.22)
        self.assertEqual(arch_mesh["mesh_strategy"], "swept_prism")
        self.assertEqual(arch_mesh["through_thickness_elements"], 1)
        self.assertEqual(arch_mesh["through_thickness_distribution"], "fixed")
        self.assertEqual(arch_mesh["sweep_face_meshing"], "triangular")
        size_fields = arch_mesh["size_fields"]
        self.assertEqual(len(size_fields), 1)
        self.assertEqual(size_fields[0]["kind"], "ObjectCoreRelaxation")
        params = size_fields[0]["params"]
        self.assertEqual(params["GeometryName"], "arch_waveguide")
        self.assertEqual(params["core_maximum_element_size"], 6e-9)
        self.assertEqual(params["surface_maximum_element_size"], 2e-9)
        self.assertEqual(params["edge_maximum_element_size"], 1.8e-9)
        draft = export_builder_draft(loaded)
        scene = build_scene_document_from_builder(draft)
        object_mesh = scene["objects"][0]["object_mesh"]
        self.assertEqual(object_mesh["mesh_strategy"], "swept_prism")
        self.assertEqual(object_mesh["through_thickness_elements"], 1)
        self.assertEqual(object_mesh["through_thickness_distribution"], "fixed")
        self.assertEqual(object_mesh["sweep_face_meshing"], "triangular")

    def test_study_builder_sets_surface_and_universe_metadata(self) -> None:
        fm.reset()
        study = fm.study("study_builder_metadata")
        study.engine("fdm")
        study.cell(5e-9, 5e-9, 5e-9)
        study.universe(
            mode="manual",
            size=(60e-9, 40e-9, 20e-9),
            center=(5e-9, 0.0, -1e-9),
            padding=(2e-9, 2e-9, 1e-9),
        )
        study.universe.mesh(
            maximum_element_size=50e-9,
            minimum_element_size=15e-9,
            growth_rate=1.4,
            grading="linear",
        )
        study.objects.mesh.defaults(maximum_element_size=20e-9, order=1)

        body = study.geometry(fm.Box(size=(20e-9, 10e-9, 5e-9), name="track"), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1.0, 0.0, 0.0)

        problem = flat_world._build_problem()
        self.assertEqual(problem.name, "study_builder_metadata")
        self.assertEqual(problem.runtime_metadata["script_api_surface"], "study")
        self.assertEqual(problem.runtime_metadata["study_universe"]["mode"], "manual")
        self.assertEqual(
            problem.runtime_metadata["study_universe"]["size"],
            [60e-9, 40e-9, 20e-9],
        )
        self.assertEqual(
            problem.runtime_metadata["study_universe"]["center"],
            [5e-9, 0.0, -1e-9],
        )
        self.assertEqual(problem.runtime_metadata["study_universe"]["airbox_hmax"], 50e-9)
        self.assertEqual(problem.runtime_metadata["study_universe"]["airbox_hmin"], 15e-9)
        self.assertEqual(problem.runtime_metadata["study_universe"]["airbox_growth_rate"], 1.4)
        self.assertEqual(problem.runtime_metadata["study_universe"]["airbox_grading"], "linear")

        ir = problem.to_ir()
        builder = ir["problem_meta"]["runtime_metadata"]["model_builder"]
        self.assertEqual(builder["script_api_surface"], "study")
        self.assertIn("universe", builder["editable_scopes"])
        self.assertEqual(builder["problem"]["universe"]["mode"], "manual")
        self.assertEqual(
            builder["problem"]["universe"]["padding"],
            [2e-9, 2e-9, 1e-9],
        )
        self.assertEqual(builder["problem"]["universe"]["airbox_hmax"], 50e-9)
        self.assertEqual(builder["problem"]["universe"]["airbox_hmin"], 15e-9)
        self.assertEqual(builder["problem"]["universe"]["airbox_growth_rate"], 1.4)
        self.assertEqual(builder["problem"]["universe"]["airbox_grading"], "linear")

    def test_load_problem_from_study_script_preserves_universe_metadata(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            script_path = tmp_path / "study_script.py"
            script_path.write_text(
                textwrap.dedent(
                    """
                    import fullmag as fm

                    study = fm.study("captured_study")
                    study.engine("fdm")
                    study.cell(5e-9, 5e-9, 5e-9)
                    study.universe(
                        mode="auto",
                        padding=(10e-9, 5e-9, 2e-9),
                    )
                    study.universe.mesh(
                        maximum_element_size=25e-9,
                        minimum_element_size=5e-9,
                        growth_rate=1.35,
                        grading="linear",
                    )

                    body = study.geometry(fm.Box(size=(10e-9, 10e-9, 5e-9), name="track"), name="track")
                    body.Ms = 800e3
                    body.Aex = 13e-12
                    body.alpha = 0.1

                    study.run(1e-12)
                    """
                ).strip()
                + "\n",
                encoding="utf-8",
            )

            loaded = fm.load_problem_from_script(script_path, lightweight_assets=True)
            self.assertEqual(loaded.problem.runtime_metadata["script_api_surface"], "study")
            self.assertEqual(loaded.problem.runtime_metadata["study_universe"]["mode"], "auto")
            self.assertEqual(
                loaded.problem.runtime_metadata["study_universe"]["padding"],
                [10e-9, 5e-9, 2e-9],
            )
            self.assertEqual(
                loaded.problem.runtime_metadata["study_universe"]["airbox_hmax"],
                25e-9,
            )
            self.assertEqual(
                loaded.problem.runtime_metadata["study_universe"]["airbox_hmin"],
                5e-9,
            )
            self.assertEqual(
                loaded.problem.runtime_metadata["study_universe"]["airbox_growth_rate"],
                1.35,
            )
            self.assertEqual(
                loaded.problem.runtime_metadata["study_universe"]["airbox_grading"],
                "linear",
            )

            draft = export_builder_draft(loaded)
            self.assertEqual(draft["universe"]["mode"], "auto")
            self.assertEqual(draft["universe"]["padding"], [10e-9, 5e-9, 2e-9])
            self.assertEqual(draft["universe"]["airbox_hmax"], 25e-9)
            self.assertEqual(draft["universe"]["airbox_hmin"], 5e-9)
            self.assertEqual(draft["universe"]["airbox_growth_rate"], 1.35)
            self.assertEqual(draft["universe"]["airbox_grading"], "linear")

            rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
            self.assertIn('study = fm.study("captured_study")', rewritten)
            self.assertIn(
                'study.universe(mode="auto", center=(0, 0, 0), padding=(1e-08, 5e-09, 2e-09))',
                rewritten,
            )
            self.assertIn(
                'study.universe.mesh(maximum_element_size=2.5e-08, minimum_element_size=5e-09, growth_rate=1.35, grading="linear")',
                rewritten,
            )
            self.assertIn('study.geometry(fm.Box(1e-08, 1e-08, 5e-09), name="track")', rewritten)
            self.assertIn('study.stages.add_run(1e-12)', rewritten)

            overridden = rewrite_loaded_problem_script(
                loaded,
                overrides={
                    "universe": {
                        "mode": "manual",
                        "size": [80e-9, 60e-9, 40e-9],
                        "center": [5e-9, -2e-9, 1e-9],
                        "padding": [0.0, 0.0, 0.0],
                        "airbox_hmax": 30e-9,
                        "airbox_hmin": 8e-9,
                        "airbox_growth_rate": 1.5,
                        "airbox_grading": "geometric",
                    },
                },
            )["rendered_source"]
            self.assertIn(
                'study.universe(mode="manual", size=(8e-08, 6e-08, 4e-08), center=(5e-09, -2e-09, 1e-09), padding=(0, 0, 0))',
                overridden,
            )
            self.assertIn(
                'study.universe.mesh(maximum_element_size=3e-08, minimum_element_size=8e-09, growth_rate=1.5, grading="geometric")',
                overridden,
            )

    def test_study_script_rewrite_preserves_explicit_outer_boundary_policy(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "study_outer_boundary.py"
            path.write_text(
                "\n".join(
                    [
                        "import fullmag as fm",
                        'study = fm.study("outer_boundary_demo")',
                        'study.engine("fem")',
                        "study.universe(mode='auto', padding=(10e-9, 10e-9, 10e-9))",
                        "study.demag(realization='airbox_robin')",
                        "body = study.geometry(fm.Box(20e-9, 20e-9, 10e-9), name='body')",
                        "body.Ms = 800e3",
                        "body.Aex = 13e-12",
                        "body.alpha = 0.1",
                        "body.m = fm.texture.uniform(1, 0, 0)",
                        "study.run(1e-12)",
                        "",
                    ]
                ),
                encoding="utf-8",
            )

            loaded = fm.load_problem_from_script(path)
            draft = export_builder_draft(loaded)
            self.assertEqual(draft["demag_realization"], "poisson_robin")

            rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
            self.assertIn('study.demag(realization="poisson_robin")', rewritten)

    def test_study_shared_domain_mesh_rewrite_uses_build_domain_mesh(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("shared_domain_rewrite")
        study.engine("fem")
        study.universe(mode="auto", padding=(10e-9, 10e-9, 10e-9))
        study.universe.mesh(maximum_element_size=25e-9)
        study.objects.mesh.defaults(maximum_element_size=8e-9, order=2)
        body = study.geometry(fm.Box(20e-9, 20e-9, 10e-9), name="body")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        study.build_mesh()
        study.run(1e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "study_shared_domain_rewrite.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            with patch("fullmag.world.build_geometry_assets_for_request", return_value=None):
                loaded = fm.load_problem_from_script(path)

        workflow = loaded.problem.runtime_metadata["mesh_workflow"]
        self.assertEqual(workflow["build_target"], "domain")

        rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
        self.assertIn("study.objects.mesh.defaults(maximum_element_size=8e-09, order=2)", rewritten)
        self.assertIn("study.build_domain_mesh()", rewritten)
        self.assertNotIn("study.mesh(", rewritten)
        self.assertNotIn("study.build_mesh()", rewritten)

    def test_study_build_domain_mesh_alias_builds_explicit_assets(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("shared_domain_alias")
        study.engine("fem")
        study.universe(mode="manual", size=(80e-9, 60e-9, 40e-9))
        study.objects.mesh.defaults(maximum_element_size=8e-9, order=2)
        body = study.geometry(fm.Box(20e-9, 20e-9, 10e-9), name="body")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        study.build_domain_mesh()
        study.run(1e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "study_build_domain_mesh.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            with patch("fullmag.world.build_geometry_assets_for_request", return_value=None) as mocked:
                loaded = fm.load_problem_from_script(path)

        self.assertEqual(mocked.call_count, 0)
        workflow = loaded.problem.runtime_metadata["mesh_workflow"]
        self.assertTrue(workflow["build_requested"])
        self.assertEqual(workflow["build_target"], "domain")
        with patch(
            "fullmag.model.problem.build_geometry_assets_for_request",
            return_value=None,
        ) as materialize_mock:
            loaded.to_ir(
                requested_backend=None,
                execution_mode=None,
                execution_precision=None,
            )
        self.assertEqual(materialize_mock.call_count, 1)

        rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
        self.assertIn("study.objects.mesh.defaults(maximum_element_size=8e-09, order=2)", rewritten)
        self.assertNotIn("study.mesh(", rewritten)

    def test_py_layer_hole_example_uses_study_shared_domain_fem_contract(self) -> None:
        example_path = Path(__file__).resolve().parents[3] / "examples" / "py_layer_hole_relax_150nm.py"

        with patch("fullmag.world.build_geometry_assets_for_request", return_value=None):
            loaded = fm.load_problem_from_script(example_path)

        runtime_metadata = loaded.problem.runtime_metadata
        self.assertEqual(runtime_metadata["study_universe"]["mode"], "auto")

        workflow = runtime_metadata["mesh_workflow"]
        self.assertTrue(workflow["build_requested"])
        self.assertEqual(workflow["build_target"], "domain")
        self.assertEqual(workflow["domain_mesh_mode"], "generated_shared_domain_mesh")

        with patch(
            "fullmag.model.problem.build_geometry_assets_for_request",
            return_value=None,
        ):
            ir = loaded.to_ir(
                requested_backend=None,
                execution_mode=None,
                execution_precision=None,
            )

        self.assertEqual(
            ir["problem_meta"]["runtime_metadata"]["runtime_selection"]["device"],
            "auto",
        )

        rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
        self.assertIn("study.build_domain_mesh()", rewritten)
        self.assertIn('study.demag(realization="poisson_robin")', rewritten)

    def test_multiple_study_build_domain_mesh_calls_materialize_once_from_final_state(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("shared_domain_final_state")
        study.engine("fem")
        study.universe(mode="auto", padding=(10e-9, 10e-9, 10e-9))
        study.universe.mesh(maximum_element_size=25e-9)
        body = study.geometry(fm.Box(20e-9, 20e-9, 10e-9), name="body")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        body.mesh(maximum_element_size=8e-9, order=1)
        study.build_domain_mesh()
        body.mesh(maximum_element_size=4e-9, order=2)
        study.build_domain_mesh()
        study.run(1e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "study_build_domain_mesh_final_state.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            with patch("fullmag.world.build_geometry_assets_for_request", return_value=None) as mocked:
                loaded = fm.load_problem_from_script(path)

        self.assertEqual(mocked.call_count, 0)
        workflow = loaded.problem.runtime_metadata["mesh_workflow"]
        self.assertTrue(workflow["build_requested"])
        self.assertEqual(workflow["build_target"], "domain")
        self.assertEqual(workflow["per_geometry"][0]["hmax"], 4e-9)
        self.assertEqual(workflow["per_geometry"][0]["order"], 2)

        with patch(
            "fullmag.model.problem.build_geometry_assets_for_request",
            return_value=None,
        ) as materialize_mock:
            loaded.to_ir(
                requested_backend=None,
                execution_mode=None,
                execution_precision=None,
            )

        self.assertEqual(materialize_mock.call_count, 1)
        materialize_workflow = materialize_mock.call_args.kwargs["mesh_workflow"]
        self.assertEqual(materialize_workflow["per_geometry"][0]["hmax"], 4e-9)
        self.assertEqual(materialize_workflow["per_geometry"][0]["order"], 2)

    def test_study_build_domain_mesh_uses_airbox_hmax_as_shared_domain_default(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("shared_domain_airbox_default")
        study.engine("fem")
        study.universe(mode="auto", padding=(10e-9, 10e-9, 10e-9))
        study.universe.mesh(maximum_element_size=80e-9)
        body = study.geometry(fm.Box(20e-9, 20e-9, 10e-9), name="body")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        body.mesh(maximum_element_size=25e-9, order=1)
        study.build_domain_mesh()
        study.run(1e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "study_build_domain_mesh_airbox_default.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)

        workflow = loaded.problem.runtime_metadata["mesh_workflow"]
        self.assertEqual(workflow["fem"]["hmax"], 80e-9)
        self.assertEqual(workflow["per_geometry"][0]["hmax"], 25e-9)

    def test_study_build_domain_mesh_requires_explicit_airbox_hmax(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("shared_domain_missing_airbox_hmax")
        study.engine("fem")
        study.universe(mode="auto", padding=(10e-9, 10e-9, 10e-9))
        left = study.geometry(fm.Box(20e-9, 20e-9, 10e-9), name="left")
        left.Ms = 800e3
        left.Aex = 13e-12
        left.alpha = 0.1
        left.m = fm.texture.uniform(1, 0, 0)
        right = study.geometry(fm.Box(20e-9, 20e-9, 10e-9).translate((30e-9, 0, 0)), name="right")
        right.Ms = 800e3
        right.Aex = 13e-12
        right.alpha = 0.1
        right.m = fm.texture.uniform(1, 0, 0)
        left.mesh(maximum_element_size=25e-9, order=1)
        right.mesh(maximum_element_size=40e-9, order=1)
        study.build_domain_mesh()
        study.run(1e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "study_build_domain_mesh_missing_airbox_hmax.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "explicit airbox maximum_element_size"):
                fm.load_problem_from_script(path, lightweight_assets=True)

    def test_study_build_domain_mesh_requires_object_hmax_coverage(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("shared_domain_missing_object_hmax")
        study.engine("fem")
        study.universe(mode="auto", padding=(10e-9, 10e-9, 10e-9))
        study.universe.mesh(maximum_element_size=80e-9)
        left = study.geometry(fm.Box(20e-9, 20e-9, 10e-9), name="left")
        left.Ms = 800e3
        left.Aex = 13e-12
        left.alpha = 0.1
        left.m = fm.texture.uniform(1, 0, 0)
        right = study.geometry(fm.Box(20e-9, 20e-9, 10e-9).translate((30e-9, 0, 0)), name="right")
        right.Ms = 800e3
        right.Aex = 13e-12
        right.alpha = 0.1
        right.m = fm.texture.uniform(1, 0, 0)
        left.mesh(maximum_element_size=25e-9, order=1)
        study.build_domain_mesh()
        study.run(1e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "study_build_domain_mesh_missing_object_hmax.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Missing maximum_element_size for: 'right'"):
                fm.load_problem_from_script(path, lightweight_assets=True)

    def test_study_build_domain_mesh_accepts_default_object_hmax_with_partial_overrides(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("shared_domain_default_object_hmax")
        study.engine("fem")
        study.universe(mode="auto", padding=(10e-9, 10e-9, 10e-9))
        study.universe.mesh(maximum_element_size=80e-9)
        study.objects.mesh.defaults(maximum_element_size=40e-9, order=1)
        left = study.geometry(fm.Box(20e-9, 20e-9, 10e-9), name="left")
        left.Ms = 800e3
        left.Aex = 13e-12
        left.alpha = 0.1
        left.m = fm.texture.uniform(1, 0, 0)
        right = study.geometry(fm.Box(20e-9, 20e-9, 10e-9).translate((30e-9, 0, 0)), name="right")
        right.Ms = 800e3
        right.Aex = 13e-12
        right.alpha = 0.1
        right.m = fm.texture.uniform(1, 0, 0)
        left.mesh(maximum_element_size=25e-9, order=1)
        study.build_domain_mesh()
        study.run(1e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "study_build_domain_mesh_default_object_hmax.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)

        workflow = loaded.problem.runtime_metadata["mesh_workflow"]
        self.assertEqual(workflow["fem"]["hmax"], 80e-9)
        self.assertEqual(workflow["default_mesh"]["hmax"], 40e-9)

    def test_study_domain_mesh_attaches_explicit_shared_domain_asset(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("explicit_shared_domain")
        study.engine("fem")
        study.domain_mesh(
            "prebuilt_domain.json",
            region_markers={"left": 1, "right": 2},
        )
        left = study.geometry(fm.Box(20e-9, 20e-9, 10e-9), name="left")
        left.Ms = 800e3
        left.Aex = 13e-12
        left.alpha = 0.1
        left.m = fm.texture.uniform(1, 0, 0)
        right = study.geometry(fm.Box(20e-9, 20e-9, 10e-9).translate((30e-9, 0, 0)), name="right")
        right.Ms = 800e3
        right.Aex = 13e-12
        right.alpha = 0.1
        right.m = fm.texture.uniform(1, 0, 0)
        study.run(1e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "study_explicit_domain_mesh.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)

        workflow = loaded.problem.runtime_metadata["mesh_workflow"]
        self.assertEqual(workflow["build_target"], "domain")
        self.assertEqual(workflow["domain_mesh_mode"], "explicit_shared_domain_mesh")
        self.assertEqual(workflow["domain_mesh_source"], "prebuilt_domain.json")
        self.assertEqual(
            workflow["domain_region_markers"],
            [
                {"geometry_name": "left", "marker": 1},
                {"geometry_name": "right", "marker": 2},
            ],
        )

        stub_mesh = MeshData(
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
        with patch("fullmag.meshing.realize_fem_mesh_asset", return_value=stub_mesh), patch(
            "fullmag._core.validate_mesh_ir",
            return_value=True,
        ):
            ir = loaded.problem.to_ir(requested_backend=fm.BackendTarget.FEM)
        self.assertEqual(
            ir["geometry_assets"]["fem_domain_mesh_asset"]["mesh_source"],
            "prebuilt_domain.json",
        )
        self.assertEqual(
            ir["geometry_assets"]["fem_domain_mesh_asset"]["region_markers"],
            [
                {"geometry_name": "left", "marker": 1},
                {"geometry_name": "right", "marker": 2},
            ],
        )

        rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
        self.assertIn(
            'study.domain_mesh(source="prebuilt_domain.json", region_markers={"left": 1, "right": 2})',
            rewritten,
        )

    def test_manual_study_universe_expands_box_fdm_grid_asset_domain(self) -> None:
        fm.reset()
        study = fm.study("manual_universe_grid")
        study.engine("fdm")
        study.cell(10e-9, 10e-9, 10e-9)
        study.universe(
            mode="manual",
            size=(80e-9, 60e-9, 40e-9),
            center=(5e-9, -15e-9, 10e-9),
        )

        body = study.geometry(
            fm.Box(size=(20e-9, 20e-9, 20e-9), name="track").translate((15e-9, -5e-9, 10e-9)),
            name="track",
        )
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1.0, 0.0, 0.0)

        problem = flat_world._build_problem()
        ir = problem.to_ir(requested_backend=fm.BackendTarget.FDM)
        asset = ir["geometry_assets"]["fdm_grid_assets"][0]

        self.assertEqual(asset["geometry_name"], "track_geom")
        self.assertEqual(asset["cells"], [8, 6, 4])
        for actual, expected in zip(asset["origin"], [-50e-9, -40e-9, -20e-9], strict=True):
            self.assertAlmostEqual(actual, expected)
        self.assertEqual(sum(asset["active_mask"]), 8)

    def test_auto_study_universe_padding_expands_box_fdm_grid_asset_domain(self) -> None:
        fm.reset()
        study = fm.study("auto_universe_padding")
        study.engine("fdm")
        study.cell(10e-9, 10e-9, 10e-9)
        study.universe(
            mode="auto",
            padding=(10e-9, 10e-9, 10e-9),
        )

        body = study.geometry(fm.Box(size=(20e-9, 30e-9, 40e-9), name="track"), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1.0, 0.0, 0.0)

        problem = flat_world._build_problem()
        ir = problem.to_ir(requested_backend=fm.BackendTarget.FDM)
        asset = ir["geometry_assets"]["fdm_grid_assets"][0]

        self.assertEqual(asset["geometry_name"], "track_geom")
        self.assertEqual(asset["cells"], [4, 5, 6])
        for actual, expected in zip(asset["origin"], [-20e-9, -25e-9, -30e-9], strict=True):
            self.assertAlmostEqual(actual, expected)
        self.assertEqual(sum(asset["active_mask"]), 24)

    def test_scene_document_bootstraps_mesh_editor_defaults(self) -> None:
        scene = build_scene_document_from_builder(
            {
                "revision": 3,
                "backend": "fem",
                "demag_realization": "airbox_robin",
                "solver": {"integrator": "rk45"},
                "mesh": {"hmax": "20e-9"},
                "universe": {"mode": "auto", "airbox_hmax": 60e-9},
                "stages": [],
                "initial_state": None,
                "geometries": [
                    {
                        "name": "flower",
                        "geometry_kind": "Box",
                        "geometry_params": {"size": [20e-9, 20e-9, 10e-9]},
                        "material": {"Ms": 800e3, "Aex": 13e-12, "alpha": 0.1},
                        "magnetization": {"kind": "uniform", "value": [1.0, 0.0, 0.0]},
                        "mesh": {"mode": "inherit", "hmax": ""},
                    }
                ],
                "current_modules": [],
                "excitation_analysis": None,
            }
        )

        self.assertEqual(scene["editor"]["object_view_mode"], "context")
        self.assertTrue(scene["editor"]["air_mesh_visible"])
        self.assertEqual(scene["editor"]["air_mesh_opacity"], 28.0)
        self.assertIsNone(scene["editor"]["selected_entity_id"])
        self.assertIsNone(scene["editor"]["focused_entity_id"])
        self.assertEqual(scene["editor"]["mesh_entity_view_state"], {})

    def test_scene_document_preserves_preset_texture_round_trip(self) -> None:
        builder = {
            "revision": 1,
            "backend": "fem",
            "demag_realization": "airbox_robin",
            "solver": {},
            "mesh": {},
            "universe": None,
            "stages": [],
            "initial_state": None,
            "geometries": [
                {
                    "name": "flower",
                    "geometry_kind": "Box",
                    "geometry_params": {"size": [20e-9, 20e-9, 10e-9]},
                    "material": {"Ms": 800e3, "Aex": 13e-12, "alpha": 0.1},
                    "magnetization": {
                        "kind": "preset_texture",
                        "value": None,
                        "seed": None,
                        "source_path": None,
                        "mapping": {
                            "space": "object",
                            "projection": "object_local",
                            "clamp_mode": "repeat",
                        },
                        "texture_transform": {
                            "translation": [1e-9, 2e-9, 3e-9],
                            "rotation_quat": [0.0, 0.0, 0.0, 1.0],
                            "scale": [2.0, 1.5, 1.0],
                            "pivot": [0.0, 0.0, 0.0],
                        },
                        "preset_kind": "vortex",
                        "preset_params": {"core_polarity": 1, "circulation": -1},
                        "preset_version": 1,
                        "ui_label": "Test vortex",
                    },
                    "mesh": {"mode": "inherit", "hmax": ""},
                }
            ],
            "current_modules": [],
            "excitation_analysis": None,
        }

        scene = build_scene_document_from_builder(builder)
        asset = scene["magnetization_assets"][0]
        self.assertEqual(asset["kind"], "preset_texture")
        self.assertEqual(asset["preset_kind"], "vortex")
        self.assertEqual(asset["mapping"]["clamp_mode"], "repeat")
        self.assertEqual(asset["texture_transform"]["translation"], [1e-9, 2e-9, 3e-9])

        rebuilt = build_builder_from_scene_document(scene)
        magnetization = rebuilt["geometries"][0]["magnetization"]
        self.assertEqual(magnetization["kind"], "preset_texture")
        self.assertEqual(magnetization["preset_kind"], "vortex")
        self.assertEqual(magnetization["preset_params"]["circulation"], -1)
        self.assertEqual(magnetization["mapping"]["clamp_mode"], "repeat")

    def test_scene_document_preserves_study_pipeline_round_trip(self) -> None:
        builder = {
            "revision": 7,
            "backend": "fdm",
            "demag_realization": None,
            "solver": {"integrator": "rk45"},
            "mesh": {"hmax": "20e-9"},
            "universe": None,
            "stages": [
                {
                    "kind": "eigenmodes",
                    "entrypoint_kind": "eigenmodes",
                    "integrator": "rk45",
                    "fixed_timestep": "",
                    "until_seconds": "",
                    "relax_algorithm": "",
                    "torque_tolerance": "",
                    "energy_tolerance": "",
                    "max_steps": "",
                    "eigen_count": "6",
                    "eigen_target": "lowest",
                    "eigen_include_demag": True,
                    "eigen_equilibrium_source": "relax",
                    "eigen_normalization": "unit_l2",
                    "eigen_target_frequency": "",
                    "eigen_damping_policy": "ignore",
                    "eigen_k_vector": "0,0,0",
                    "eigen_spin_wave_bc": "free",
                    "eigen_spin_wave_bc_config": {"kind": "free"},
                }
            ],
            "study_pipeline": {
                "version": "study_pipeline.v1",
                "nodes": [
                    {
                        "id": "stage_1_eigenmodes",
                        "label": "",
                        "enabled": True,
                        "source": "script_imported",
                        "node_kind": "primitive",
                        "stage_kind": "eigenmodes",
                        "payload": {
                            "kind": "eigenmodes",
                            "entrypoint_kind": "eigenmodes",
                            "eigen_count": "6",
                            "eigen_include_demag": True,
                            "eigen_equilibrium_source": "relax",
                            "eigen_normalization": "unit_l2",
                            "eigen_damping_policy": "ignore",
                            "eigen_k_vector": "0,0,0",
                            "eigen_spin_wave_bc": "free",
                            "eigen_spin_wave_bc_config": {"kind": "free"},
                        },
                    }
                ],
            },
            "initial_state": None,
            "geometries": [
                {
                    "name": "flower",
                    "geometry_kind": "Box",
                    "geometry_params": {"size": [20e-9, 20e-9, 10e-9]},
                    "material": {"Ms": 800e3, "Aex": 13e-12, "alpha": 0.1},
                    "magnetization": {"kind": "uniform", "value": [1.0, 0.0, 0.0]},
                    "mesh": {"mode": "inherit", "hmax": ""},
                }
            ],
            "current_modules": [],
            "excitation_analysis": None,
        }

        scene = build_scene_document_from_builder(builder)
        self.assertEqual(scene["study"]["study_pipeline"]["version"], "study_pipeline.v1")
        self.assertEqual(scene["study"]["study_pipeline"]["nodes"][0]["stage_kind"], "eigenmodes")

        rebuilt = build_builder_from_scene_document(scene)
        self.assertEqual(rebuilt["study_pipeline"]["nodes"][0]["payload"]["eigen_count"], "6")

        overrides = builder_overrides_from_scene_document(scene)
        self.assertEqual(overrides["study_pipeline"]["nodes"][0]["stage_kind"], "eigenmodes")
        self.assertEqual(overrides["stages"][0]["eigen_count"], 6)
        self.assertTrue(overrides["stages"][0]["eigen_include_demag"])
        self.assertEqual(overrides["stages"][0]["eigen_k_vector"], "0,0,0")

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
        self.assertEqual(ir["study"]["stop"]["torque_tolerance_apm"], 1e-3)
        self.assertEqual(ir["study"]["stop"]["energy_tolerance_j"], 1e-12)
        self.assertEqual(ir["study"]["stop"]["max_steps"], 500)
        self.assertEqual(ir["study"]["dynamics"]["fixed_timestep"], 2e-13)

    def test_relaxation_requires_supported_algorithm_and_positive_limits(self) -> None:
        with self.assertRaisesRegex(ValueError, "algorithm must be one of"):
            fm.Relaxation(
                algorithm="made_up",
                outputs=[fm.SaveField("m", every=1e-12)],
            )

        with self.assertRaisesRegex(ValueError, "torque_tolerance_apm"):
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
        track.m = fm.texture.uniform(1.0, 0.0, 0.0)

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

    def test_flat_tableautosave_accepts_custom_scalar_columns(self) -> None:
        fm.reset()
        fm.engine("fdm")
        fm.cell(2e-9, 2e-9, 2e-9)
        track = fm.geometry(fm.Box(size=(20e-9, 10e-9, 2e-9), name="track"), name="track")
        track.Ms = 800e3
        track.Aex = 13e-12
        track.alpha = 0.1
        track.m = fm.texture.uniform(1.0, 0.0, 0.0)

        fm.tableautosave(5e-12, quantities=("time", "mx", "E_total"))
        problem = flat_world._build_problem()
        ir = problem.to_ir()
        outputs = ir["study"]["sampling"]["outputs"]
        scalar_names = [output["name"] for output in outputs if output["kind"] == "scalar"]

        self.assertEqual(scalar_names, ["time", "mx", "E_total"])
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
        fem = fm.FEM(order=1, maximum_element_size=2e-9, mesh="meshes/sample.msh")

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

    @unittest.skipIf(importlib.util.find_spec("trimesh") is None, "trimesh is not installed")
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

    @unittest.skipIf(importlib.util.find_spec("trimesh") is None, "trimesh is not installed")
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
        self.assertEqual(assets[0]["cells"], [67, 67, 23])
        self.assertEqual(len(assets[0]["active_mask"]), 67 * 67 * 23)

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

    def test_imported_geometry_supports_surface_volume_in_ir(self) -> None:
        geometry = fm.ImportedGeometry(
            source="examples/nanoflower.stl",
            name="flower",
            volume="surface",
        )

        self.assertEqual(geometry.to_ir()["volume"], "surface")

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
            discretization=fm.DiscretizationHints(fem=fm.FEM(order=1, maximum_element_size=2e-9)),
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

    def test_fem_backend_forwards_study_universe_to_mesh_asset_realization(self) -> None:
        fm.reset()
        study = fm.study("fem_universe_forwarding")
        study.engine("fem")
        study.universe(
            mode="manual",
            size=(80e-9, 60e-9, 40e-9),
            center=(5e-9, -2e-9, 1e-9),
        )
        study.universe.mesh(
            minimum_element_size=12e-9,
            growth_rate=1.25,
            grading="linear",
        )

        body = study.geometry(fm.Box(size=(10e-9, 10e-9, 10e-9), name="box"), name="box")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1.0, 0.0, 0.0)

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

        problem = flat_world._build_problem()
        with patch.dict(os.environ, {"FULLMAG_FEM_MESH_CACHE_DIR": ""}), patch(
            "fullmag.meshing.realize_fem_mesh_asset", return_value=mesh
        ) as mocked_mesh, patch(
            "fullmag.meshing.realize_fem_domain_mesh_asset_from_components",
            return_value=(mesh, [{"geometry_name": "box", "marker": 1}]),
        ) as mocked_domain, patch("fullmag._core.validate_mesh_ir", return_value=True):
            problem.to_ir(requested_backend=fm.BackendTarget.FEM)

        self.assertEqual(mocked_mesh.call_count, 1)
        self.assertEqual(mocked_domain.call_count, 1)
        forwarded_universe = mocked_mesh.call_args.kwargs["study_universe"]
        forwarded_domain_universe = mocked_domain.call_args.kwargs["study_universe"]
        self.assertIsNotNone(forwarded_universe)
        self.assertEqual(forwarded_universe["mode"], "manual")
        self.assertEqual(forwarded_universe["size"], [80e-9, 60e-9, 40e-9])
        self.assertEqual(forwarded_universe["center"], [5e-9, -2e-9, 1e-9])
        self.assertEqual(forwarded_universe["airbox_hmin"], 12e-9)
        self.assertEqual(forwarded_universe["airbox_growth_rate"], 1.25)
        self.assertEqual(forwarded_universe["airbox_grading"], "linear")
        self.assertEqual(forwarded_domain_universe, forwarded_universe)

    def test_fem_backend_emits_shared_domain_mesh_asset_for_manual_universe(self) -> None:
        fm.reset()
        study = fm.study("fem_shared_domain_asset")
        study.engine("fem")
        study.universe(
            mode="manual",
            size=(80e-9, 60e-9, 40e-9),
            center=(0.0, 0.0, 0.0),
        )

        left = study.geometry(fm.Box(size=(10e-9, 10e-9, 10e-9), name="left"), name="left")
        left.Ms = 800e3
        left.Aex = 13e-12
        left.alpha = 0.1
        left.m = fm.texture.uniform(1.0, 0.0, 0.0)

        right = study.geometry(
            fm.Box(size=(10e-9, 10e-9, 10e-9), name="right").translate((20e-9, 0.0, 0.0)),
            name="right",
        )
        right.Ms = 800e3
        right.Aex = 13e-12
        right.alpha = 0.1
        right.m = fm.texture.uniform(1.0, 0.0, 0.0)

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
        domain_mesh = MeshData(
            nodes=np.asarray(
                [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [2.0, 2.0, 2.0],
                    [3.0, 2.0, 2.0],
                    [2.0, 3.0, 2.0],
                    [2.0, 2.0, 3.0],
                ]
            ),
            elements=np.asarray([[0, 1, 2, 3], [4, 5, 6, 7]], dtype=np.int32),
            element_markers=np.asarray([1, 0], dtype=np.int32),
            boundary_faces=np.asarray([[0, 1, 2], [4, 5, 6]], dtype=np.int32),
            boundary_markers=np.asarray([10, 99], dtype=np.int32),
        )

        problem = flat_world._build_problem()
        with patch.dict(os.environ, {"FULLMAG_FEM_MESH_CACHE_DIR": ""}), patch(
            "fullmag.meshing.realize_fem_mesh_asset", return_value=mesh
        ), patch(
            "fullmag.meshing.realize_fem_domain_mesh_asset",
            return_value=(
                domain_mesh,
                [
                    {"geometry_name": "left", "marker": 1},
                    {"geometry_name": "right", "marker": 2},
                ],
            ),
        ), patch("fullmag._core.validate_mesh_ir", return_value=True):
            ir = problem.to_ir(requested_backend=fm.BackendTarget.FEM)

        domain_asset = ir["geometry_assets"]["fem_domain_mesh_asset"]
        self.assertIsNotNone(domain_asset)
        self.assertEqual(domain_asset["mesh"]["mesh_name"], "study_domain")
        self.assertEqual(
            domain_asset["region_markers"],
            [
                {"geometry_name": "left_geom", "marker": 1},
                {"geometry_name": "right_geom", "marker": 2},
            ],
        )

    def test_surface_only_imported_geometry_is_rejected_for_executable_fem_assets(self) -> None:
        geometry = fm.ImportedGeometry(
            source="examples/nanoflower.stl",
            name="flower",
            volume="surface",
        )
        material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.01)
        magnet = fm.Ferromagnet(name="flower", geometry=geometry, material=material)
        problem = fm.Problem(
            name="surface_only_mesh_problem",
            magnets=[magnet],
            energy=[fm.Exchange()],
            study=fm.TimeEvolution(
                dynamics=fm.LLG(),
                outputs=[fm.SaveField("m", every=1e-12)],
            ),
            discretization=fm.DiscretizationHints(fem=fm.FEM(order=1, maximum_element_size=2e-9)),
        )

        surface_mesh = MeshData(
            nodes=np.asarray(
                [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                ]
            ),
            elements=np.zeros((0, 4), dtype=np.int32),
            element_markers=np.zeros((0,), dtype=np.int32),
            boundary_faces=np.asarray([[0, 1, 2]], dtype=np.int32),
            boundary_markers=np.asarray([1], dtype=np.int32),
        )

        with patch("fullmag.meshing.realize_fem_mesh_asset", return_value=surface_mesh):
            with self.assertRaisesRegex(ValueError, "volume='surface'"):
                problem.to_ir(requested_backend=fm.BackendTarget.FEM)

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

    @unittest.skipIf(importlib.util.find_spec("trimesh") is None, "trimesh is not installed")
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
                energy=[fm.Exchange(), fm.Demag()],
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

    @unittest.skipIf(importlib.util.find_spec("trimesh") is None, "trimesh is not installed")
    def test_script_rewrite_preserves_imported_geometry_surface_volume(self) -> None:
        script = """
        import fullmag as fm

        fm.engine("fdm")
        fm.cell(5e-9, 5e-9, 5e-9)
        flower = fm.geometry(
            fm.ImportedGeometry(source="flower.stl", name="flower", volume="surface"),
            name="flower",
        )
        flower.Ms = 800e3
        flower.Aex = 13e-12
        flower.alpha = 0.01
        fm.run(1e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_surface_imported_geometry.py"
            stl = Path(tmp_dir) / "flower.stl"
            stl.write_text("solid flower\nendsolid flower\n", encoding="utf-8")
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)

            rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]

        self.assertIn('volume="surface"', rewritten)

    def test_script_builder_preserves_custom_region_name(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("region_name")
        study.engine("fdm")
        study.cell(5e-9, 5e-9, 5e-9)

        body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="body")
        body.region_name = "core"
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)

        study.run(1e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_region_name.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path)

        self.assertEqual(loaded.problem.magnets[0].region_name, "core")
        draft = export_builder_draft(loaded)
        self.assertEqual(draft["geometries"][0]["region_name"], "core")

        rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
        self.assertIn('body.region_name = "core"', rewritten)

    def test_builder_draft_exports_structured_csg_geometry(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("csg_geometry")
        study.engine("fem")

        body = study.geometry(
            fm.Box(100e-9, 40e-9, 20e-9, name="host")
            - fm.Cylinder(radius=10e-9, height=20e-9, name="hole").translate((15e-9, 0, 0)),
            name="body",
        )
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)

        study.run(1e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_csg_geometry.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)

        draft = export_builder_draft(loaded)
        geometry = draft["geometries"][0]
        self.assertEqual(geometry["geometry_kind"], "Difference")
        self.assertEqual(geometry["geometry_params"]["base"]["geometry_kind"], "Box")
        self.assertEqual(geometry["geometry_params"]["tool"]["geometry_kind"], "Translate")
        self.assertEqual(
            geometry["geometry_params"]["tool"]["geometry_params"]["base"]["geometry_kind"],
            "Cylinder",
        )

        rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
        self.assertIn("fm.Box(1e-07, 4e-08, 2e-08, name=\"host\")", rewritten)
        self.assertIn(".translate((1.5e-08, 0, 0))", rewritten)
        self.assertIn(" - ", rewritten)

    def test_script_builder_rewrites_file_texture_override_with_loadfile(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("file_texture")
        study.engine("fdm")
        study.cell(5e-9, 5e-9, 5e-9)

        body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="body")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)

        study.run(1e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_file_texture.py"
            texture_path = Path(tmp_dir) / "m0.ovf"
            texture_path.write_text("# dummy", encoding="utf-8")
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)

            draft = export_builder_draft(loaded)
            draft["geometries"][0]["magnetization"] = {
                "kind": "file",
                "value": None,
                "seed": None,
                "source_path": str(texture_path),
                "source_format": "ovf",
                "dataset": None,
                "sample_index": None,
            }
            rewritten = rewrite_loaded_problem_script(loaded, overrides=draft)["rendered_source"]

        self.assertIn('body.m.loadfile("m0.ovf", format="ovf")', rewritten)

    def test_builder_draft_exports_flat_stage_sequence(self) -> None:
        script = """
        import fullmag as fm

        fm.engine("fdm")
        fm.cell(5e-9, 5e-9, 5e-9)
        body = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        body.mesh(maximum_element_size=4e-9, order=1).build()
        fm.save("m", every=1e-12)
        fm.relax(max_steps=25, tol=1e-5, algorithm="llg_overdamped")
        fm.run(4e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_builder_stage_sequence.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)

        draft = export_builder_draft(loaded)
        self.assertEqual(len(draft["stages"]), 2)
        self.assertEqual(draft["stages"][0]["kind"], "relax")
        self.assertEqual(draft["stages"][0]["max_steps"], "25")
        self.assertEqual(draft["stages"][0]["torque_tolerance"], "1e-05")
        self.assertEqual(draft["stages"][0]["demag_interval_s"], "")
        self.assertEqual(draft["stages"][1]["kind"], "run")
        self.assertEqual(draft["stages"][1]["until_seconds"], "4e-12")
        self.assertEqual(draft["study_pipeline"]["version"], "study_pipeline.v1")
        self.assertEqual(len(draft["study_pipeline"]["nodes"]), 2)
        self.assertEqual(draft["study_pipeline"]["nodes"][0]["stage_kind"], "relax")
        self.assertEqual(draft["study_pipeline"]["nodes"][0]["payload"]["max_steps"], "25")
        self.assertEqual(draft["study_pipeline"]["nodes"][1]["stage_kind"], "run")
        self.assertEqual(draft["study_pipeline"]["nodes"][1]["payload"]["until_seconds"], "4e-12")

    def test_study_builder_stage_authoring_captures_without_execution(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("stage_authoring")
        study.engine("fem")
        study.device("cpu", precision="double")
        body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        study.save("m", every=1e-12)
        study.stages.add_stage(fm.relax_stage(max_steps=25, tol=1e-5, algorithm="llg_overdamped"))
        study.stages.add_run(4e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_builder_study_stage_authoring.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)

        self.assertEqual(loaded.entrypoint_kind, "flat_workspace")
        self.assertFalse(loaded.auto_execute_stages)
        self.assertEqual(len(loaded.stages), 2)
        self.assertEqual(loaded.stages[0].entrypoint_kind, "flat_relax")
        self.assertEqual(loaded.stages[0].problem.study.to_ir()["kind"], "relaxation")
        self.assertEqual(loaded.stages[1].entrypoint_kind, "flat_run")
        self.assertEqual(loaded.stages[1].default_until_seconds, 4e-12)

        rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
        self.assertIn("study.stages.add_relax(", rewritten)
        self.assertIn("algorithm=\"llg_overdamped\"", rewritten)
        self.assertIn("tol=1e-05", rewritten)
        self.assertIn("max_steps=25", rewritten)
        self.assertIn("study.stages.add_run(4e-12)", rewritten)

    def test_study_builder_relax_stage_roundtrips_solver_and_dt(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("stage_authoring")
        study.engine("fem")
        body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        study.stages.add_relax(max_steps=25, solver="rk45", dt=2e-13)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_builder_study_stage_relax_solver_dt.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)

        rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
        self.assertIn('solver="rk45"', rewritten)
        self.assertIn("dt=2e-13", rewritten)

    def test_study_stage_builder_add_minimize_maps_to_relaxation_algorithm(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("stage_minimize")
        study.engine("fem")
        body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        study.stages.add_minimize(method="ncg", max_steps=30)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_builder_stage_minimize.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)

        self.assertEqual(len(loaded.stages), 1)
        self.assertEqual(loaded.stages[0].problem.study.to_ir()["algorithm"], "nonlinear_cg")

    def test_study_stage_builder_add_hysteresis_branch_materializes_relax_stages(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("stage_hysteresis")
        study.engine("fem")
        body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        study.stages.add_hysteresis_branch(
            field_values_t=[-20e-3, 0.0, 20e-3],
            direction=(1.0, 0.0, 0.0),
            settle=fm.RelaxStop(torque_tolerance_apm=5e-6, max_steps=40),
        )
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_builder_stage_hysteresis_branch.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)

        self.assertEqual(len(loaded.stages), 3)
        for stage in loaded.stages:
            self.assertEqual(stage.entrypoint_kind, "flat_relax")
            self.assertEqual(stage.problem.study.to_ir()["kind"], "relaxation")
            self.assertEqual(stage.problem.study.to_ir()["stop"]["max_steps"], 40)
            self.assertEqual(
                stage.problem.study.to_ir()["stop"]["torque_tolerance_apm"],
                5e-6,
            )

        zeeman_fields = []
        for stage in loaded.stages:
            ir = stage.problem.to_ir()
            zeeman = next(
                term["B"] for term in ir["energy_terms"] if term.get("kind") == "zeeman"
            )
            zeeman_fields.append(zeeman)

        self.assertEqual(zeeman_fields[0], [-20e-3, 0.0, 0.0])
        self.assertEqual(zeeman_fields[1], [0.0, 0.0, 0.0])
        self.assertEqual(zeeman_fields[2], [20e-3, 0.0, 0.0])

    def test_study_stage_builder_hysteresis_branch_save_state_emits_synthetic_actions(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("stage_hysteresis_save_state")
        study.engine("fem")
        body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        study.stages.add_hysteresis_branch(
            field_values_t=[-10e-3, 10e-3],
            direction=(0.0, 0.0, 1.0),
            settle=fm.RelaxStop(torque_tolerance_apm=1e-5, max_steps=25),
            save_state=True,
        )
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_builder_stage_hysteresis_branch_save_state.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)

        self.assertEqual(len(loaded.stages), 4)
        self.assertEqual(loaded.stages[0].entrypoint_kind, "flat_relax")
        self.assertEqual(loaded.stages[1].entrypoint_kind, "flat_save_state")
        self.assertEqual(loaded.stages[2].entrypoint_kind, "flat_relax")
        self.assertEqual(loaded.stages[3].entrypoint_kind, "flat_save_state")
        self.assertEqual(
            loaded.stages[1].action,
            {
                "kind": "save_state",
                "artifact_name": "hysteresis_branch_point_001",
                "format": None,
                "dataset": None,
            },
        )
        self.assertEqual(
            loaded.stages[3].action,
            {
                "kind": "save_state",
                "artifact_name": "hysteresis_branch_point_002",
                "format": None,
                "dataset": None,
            },
        )

    def test_builder_draft_uses_final_flat_problem_materials_for_stage_sequences(self) -> None:
        script = """
        import fullmag as fm

        fm.engine("fdm")
        fm.cell(5e-9, 5e-9, 5e-9)
        body = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        body.mesh(maximum_element_size=4e-9, order=1).build()
        fm.solver(dt=1e-13)
        fm.relax(max_steps=25)
        fm.run(4e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_builder_stage_materials.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)

        draft = export_builder_draft(loaded)
        rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]

        self.assertEqual(draft["geometries"][0]["material"]["alpha"], 0.1)
        self.assertIn("track.alpha = 0.1", rewritten)
        self.assertNotIn("track.alpha = 1.0", rewritten)

    def test_builder_draft_exports_domain_frame_for_manual_multibody_universe(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("domain_frame_manual")
        study.engine("fem")
        study.universe(
            mode="manual",
            size=(400e-9, 300e-9, 200e-9),
            center=(25e-9, 0.0, 0.0),
        )

        left = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="left")
        left.Ms = 800e3
        left.Aex = 13e-12
        left.alpha = 0.1
        left.m = fm.texture.uniform(1, 0, 0)

        right = study.geometry(
            fm.Box(80e-9, 20e-9, 5e-9).translate((140e-9, 0.0, 0.0)),
            name="right",
        )
        right.Ms = 800e3
        right.Aex = 13e-12
        right.alpha = 0.1
        right.m = fm.texture.uniform(1, 0, 0)

        study.run(1e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_builder_domain_frame.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)

        draft = export_builder_draft(loaded)
        self.assertIsNotNone(draft["domain_frame"])
        self.assertEqual(draft["domain_frame"]["effective_source"], "declared_universe_manual")
        self.assertEqual(draft["domain_frame"]["effective_extent"], [400e-9, 300e-9, 200e-9])
        self.assertEqual(draft["domain_frame"]["effective_center"], [25e-9, 0.0, 0.0])
        self.assertEqual(draft["domain_frame"]["object_bounds_min"], [-50e-9, -10e-9, -2.5e-9])
        self.assertAlmostEqual(draft["domain_frame"]["object_bounds_max"][0], 180e-9)
        self.assertAlmostEqual(draft["domain_frame"]["object_bounds_max"][1], 10e-9)
        self.assertAlmostEqual(draft["domain_frame"]["object_bounds_max"][2], 2.5e-9)

    def test_script_rewrite_applies_stage_overrides(self) -> None:
        script = """
        import fullmag as fm

        fm.engine("fdm")
        fm.cell(5e-9, 5e-9, 5e-9)
        body = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        fm.save("m", every=1e-12)
        fm.relax(max_steps=25, tol=1e-5, algorithm="llg_overdamped")
        fm.run(4e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_builder_stage_overrides.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)

        rewritten = rewrite_loaded_problem_script(
            loaded,
            overrides={
                "stages": [
                    {
                        "kind": "relax",
                        "relax_algorithm": "nonlinear_cg",
                        "torque_tolerance": 2e-6,
                        "energy_tolerance": 3e-12,
                        "max_steps": 250,
                    },
                    {
                        "kind": "run",
                        "until_seconds": 9e-12,
                    },
                ],
            },
        )["rendered_source"]

        self.assertIn('fm.relax(algorithm="nonlinear_cg", tol=2e-06, max_steps=250, energy_tolerance=3e-12)', rewritten)
        self.assertIn("fm.run(9e-12)", rewritten)

    def test_script_rewrite_applies_eigen_k_path_override(self) -> None:
        script = """
        import fullmag as fm

        fm.engine("fdm")
        fm.cell(5e-9, 5e-9, 5e-9)
        body = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        study = fm.study()
        study.eigenmodes(count=4, include_demag=False)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_builder_eigen_k_path.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)

        rewritten = rewrite_loaded_problem_script(
            loaded,
            overrides={
                "stages": [
                    {
                        "kind": "eigenmodes",
                        "eigen_k_path": "Γ:0,0,0; X:3.14e7,0,0 | samples=41",
                        "eigen_spin_wave_bc": "floquet",
                        "eigen_spin_wave_bc_config": {
                            "kind": "floquet",
                            "pair_ids": ["x_periodic"],
                            "phase_convention": "exp_minus_i_k_dot_delta_r",
                        },
                    },
                ],
            },
        )["rendered_source"]

        self.assertIn("k_sampling=fm.KPath", rewritten)
        self.assertIn('fm.KPoint("\\u0393", (0, 0, 0))', rewritten)
        self.assertIn('fm.KPoint("X", (31400000, 0, 0))', rewritten)
        self.assertIn("samples_per_segment=[41]", rewritten)
        self.assertIn('"pair_ids": ["x_periodic"]', rewritten)

    def test_relaxation_stop_and_field_refresh_serialize_to_ir(self) -> None:
        geometry = fm.Box(size=(100e-9, 20e-9, 5e-9), name="track")
        material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.1)
        magnet = fm.Ferromagnet(name="track", geometry=geometry, material=material)

        problem = fm.Problem(
            name="relax_stop_refresh_problem",
            magnets=[magnet],
            energy=[fm.Exchange(), fm.Demag()],
            study=fm.Relaxation(
                algorithm="llg_overdamped",
                stop=fm.RelaxStop(
                    torque_tolerance_apm=1e-3,
                    max_pseudotime_s=4e-12,
                    max_physical_time_s=6e-12,
                ),
                dynamics=fm.LLG(
                    fixed_timestep=2e-13,
                    field_refresh=fm.FieldRefreshPolicy(demag_interval_s=8e-13),
                ),
                outputs=[fm.SaveField("m", every=1e-12)],
            ),
        )

        ir = problem.to_ir()
        self.assertEqual(ir["study"]["stop"]["torque_tolerance_apm"], 1e-3)
        self.assertEqual(ir["study"]["stop"]["max_pseudotime_s"], 4e-12)
        self.assertEqual(ir["study"]["stop"]["max_physical_time_s"], 6e-12)
        self.assertEqual(
            ir["study"]["dynamics"]["field_refresh"]["demag_interval_s"],
            8e-13,
        )

    def test_script_builder_renders_relax_stop_and_demag_refresh(self) -> None:
        script = """
        import fullmag as fm

        fm.engine("fem")
        fm.device("cpu")
        fm.solver(dt=2e-13, demag_interval_s=8e-13)
        body = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        fm.save("m", every=1e-12)
        fm.relax(
            algorithm="llg_overdamped",
            stop=fm.RelaxStop(
                torque_tolerance_apm=1e-5,
                max_pseudotime_s=4e-12,
            ),
        )
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_builder_relax_stop_refresh.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)

        rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
        self.assertIn("fm.solver(dt=2e-13, demag_interval_s=8e-13)", rewritten)
        self.assertIn(
            'fm.relax(algorithm="llg_overdamped", stop=fm.RelaxStop(torque_tolerance_apm=1e-05, max_steps=50000, max_pseudotime_s=4e-12))',
            rewritten,
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
        body.m = fm.texture.uniform(1, 0, 0)
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
        body.m = fm.texture.uniform(1, 0, 0)
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
        dynamics = loaded.problem.study.to_ir()["dynamics"]
        self.assertEqual(dynamics["integrator"], "rk23")
        self.assertIsNone(dynamics["fixed_timestep"])

    def test_flat_relax_accepts_solver_and_dt_overrides(self) -> None:
        script = """
        import fullmag as fm

        fm.engine("fdm")
        fm.cell(5e-9, 5e-9, 5e-9)
        body = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        fm.relax(max_steps=250, solver="rk45", dt=2e-13)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_flat_relax_solver_dt.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path)

        dynamics = loaded.problem.study.to_ir()["dynamics"]
        self.assertEqual(dynamics["integrator"], "rk45")
        self.assertEqual(dynamics["fixed_timestep"], 2e-13)

    def test_flat_relax_rejects_solver_for_minimizer_algorithms(self) -> None:
        script = """
        import fullmag as fm

        fm.engine("fdm")
        fm.cell(5e-9, 5e-9, 5e-9)
        body = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        fm.relax(max_steps=250, algorithm="nonlinear_cg", solver="rk23")
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_flat_relax_invalid_solver.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            with self.assertRaises(TypeError):
                fm.load_problem_from_script(path)

    def test_flat_minimize_alias_defaults_to_projected_gradient_bb(self) -> None:
        script = """
        import fullmag as fm

        fm.engine("fdm")
        fm.cell(5e-9, 5e-9, 5e-9)
        body = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        fm.minimize(max_steps=100)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_flat_minimize_default.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path)

        self.assertEqual(loaded.entrypoint_kind, "flat_relax")
        study_ir = loaded.problem.study.to_ir()
        self.assertEqual(study_ir["kind"], "relaxation")
        self.assertEqual(study_ir["algorithm"], "projected_gradient_bb")

    def test_flat_minimize_alias_supports_ncg_method(self) -> None:
        script = """
        import fullmag as fm

        fm.engine("fdm")
        fm.cell(5e-9, 5e-9, 5e-9)
        body = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        fm.minimize(method="ncg", max_steps=120)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_flat_minimize_ncg.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path)

        self.assertEqual(loaded.problem.study.to_ir()["algorithm"], "nonlinear_cg")

    def test_study_minimize_alias_works_in_builder_surface(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("minimize_surface")
        study.engine("fem")
        body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        study.minimize(method="ncg", max_steps=55)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_study_minimize_alias.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path)

        self.assertEqual(loaded.problem.study.to_ir()["algorithm"], "nonlinear_cg")

    def test_minimize_rejects_unknown_method(self) -> None:
        script = """
        import fullmag as fm

        fm.engine("fdm")
        fm.cell(5e-9, 5e-9, 5e-9)
        body = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        fm.minimize(method="bogus")
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_minimize_invalid_method.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            with self.assertRaises(ValueError):
                fm.load_problem_from_script(path)

    def test_flat_solver_max_error_lowers_to_adaptive_timestep(self) -> None:
        script = """
        import fullmag as fm

        fm.engine("fdm")
        fm.cell(5e-9, 5e-9, 5e-9)
        body = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
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
        body.m = fm.texture.uniform(1, 0, 0)
        body.mesh(maximum_element_size=4e-9, order=1).build()
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
        self.assertIsNotNone(loaded.workspace_problem)
        self.assertEqual(loaded.workspace_problem.study.to_ir()["kind"], "time_evolution")

    def test_flat_sequence_ir_embeds_study_pipeline_runtime_metadata(self) -> None:
        script = """
        import fullmag as fm

        fm.engine("fdm")
        fm.cell(5e-9, 5e-9, 5e-9)
        body = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        body.mesh(maximum_element_size=4e-9, order=1).build()
        fm.solver(dt=1e-13)
        fm.relax(max_steps=25)
        fm.run(4e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_flat_sequence_runtime_metadata.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)
            ir = loaded.to_ir(
                requested_backend=fm.BackendTarget.FDM,
                execution_mode=fm.ExecutionMode.STRICT,
                execution_precision=fm.ExecutionPrecision.DOUBLE,
                include_geometry_assets=False,
            )

        runtime_metadata = ir["problem_meta"]["runtime_metadata"]
        self.assertEqual(runtime_metadata["study_pipeline"]["version"], "study_pipeline.v1")
        self.assertEqual(len(runtime_metadata["study_pipeline"]["nodes"]), 2)
        self.assertEqual(runtime_metadata["study_pipeline"]["nodes"][0]["stage_kind"], "relax")
        self.assertEqual(runtime_metadata["study_pipeline"]["nodes"][1]["stage_kind"], "run")
        self.assertEqual(
            runtime_metadata["model_builder"]["study_pipeline"]["version"],
            "study_pipeline.v1",
        )
        self.assertEqual(
            len(runtime_metadata["model_builder"]["study_pipeline"]["nodes"]),
            2,
        )
        self.assertEqual(
            runtime_metadata["script_sync"]["study_pipeline_version"],
            "study_pipeline.v1",
        )
        self.assertEqual(runtime_metadata["script_sync"]["study_pipeline_node_count"], 2)

    def test_builder_draft_prefers_workspace_problem_when_available(self) -> None:
        script = """
        import fullmag as fm

        fm.name("workspace_source")
        fm.engine("fdm")
        fm.cell(5e-9, 5e-9, 5e-9)
        body = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        fm.relax(max_steps=25)
        fm.run(4e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_builder_workspace_problem.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)

        self.assertIsNotNone(loaded.workspace_problem)
        mutated_problem = replace(copy.deepcopy(loaded.problem), name="final_stage_only")
        loaded_with_workspace = replace(loaded, problem=mutated_problem)

        draft = export_builder_draft(loaded_with_workspace)
        rewritten = rewrite_loaded_problem_script(loaded_with_workspace)["rendered_source"]

        self.assertEqual(draft["geometries"][0]["name"], "track")
        self.assertIn('fm.name("workspace_source")', rewritten)
        self.assertNotIn('fm.name("final_stage_only")', rewritten)

    def test_flat_geometry_mesh_api_builds_explicit_mesh_asset(self) -> None:
        script = """
        import fullmag as fm

        fm.engine("fem")
        body = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        body.mesh(maximum_element_size=4e-9, order=2).build()
        fm.solver(dt=1e-13)
        fm.relax(max_steps=25)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_flat_geometry_mesh.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            with patch("fullmag.world.build_geometry_assets_for_request", return_value=None) as mocked:
                loaded = fm.load_problem_from_script(path)

        self.assertEqual(mocked.call_count, 0)
        workflow = loaded.problem.runtime_metadata["mesh_workflow"]
        self.assertTrue(workflow["explicit_mesh_api"])
        self.assertTrue(workflow["build_requested"])
        self.assertEqual(workflow["fem"]["order"], 2)
        self.assertEqual(workflow["fem"]["hmax"], 4e-9)
        with patch(
            "fullmag.model.problem.build_geometry_assets_for_request",
            return_value=None,
        ) as materialize_mock:
            loaded.to_ir(
                requested_backend=None,
                execution_mode=None,
                execution_precision=None,
            )
        self.assertEqual(materialize_mock.call_count, 1)
        self.assertEqual(materialize_mock.call_args.kwargs["requested_backend"], fm.BackendTarget.FEM)
        fem = materialize_mock.call_args.kwargs["discretization"].fem
        self.assertIsNotNone(fem)
        self.assertEqual(fem.order, 2)
        self.assertEqual(fem.hmax, 4e-9)

    def test_flat_geometry_mesh_api_accepts_per_geometry_hmax_overrides(self) -> None:
        script = """
        import fullmag as fm

        fm.engine("fem")
        a = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="a")
        b = fm.geometry(fm.Box(80e-9, 20e-9, 5e-9), name="b")
        a.Ms = 800e3
        a.Aex = 13e-12
        b.Ms = 800e3
        b.Aex = 13e-12
        a.mesh(maximum_element_size=4e-9, order=1)
        b.mesh(maximum_element_size=8e-9, order=1)
        fm.run(1e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_flat_geometry_mesh_conflict.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            with patch("fullmag.world.build_geometry_assets_for_request", return_value=None):
                loaded = fm.load_problem_from_script(path)

        workflow = loaded.problem.runtime_metadata["mesh_workflow"]
        self.assertEqual(workflow["fem"]["hmax"], 8e-9)
        per_geometry = workflow["per_geometry"]
        by_name = {entry["geometry"]: entry for entry in per_geometry}
        self.assertEqual(by_name["a"]["hmax"], 4e-9)
        self.assertEqual(by_name["b"]["hmax"], 8e-9)

    def test_flat_geometry_mesh_quality_returns_report_after_build(self) -> None:
        fm.reset()
        body = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="body")
        body.Ms = 800e3
        body.Aex = 13e-12
        assets = {
            "fdm_grid_assets": [],
            "fem_mesh_assets": [
                {
                    "geometry_name": "body_geom",
                    "mesh_source": None,
                    "mesh": {
                        "mesh_name": "body_geom",
                        "nodes": [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
                        "elements": [[0, 1, 2, 3]],
                        "element_markers": [1],
                        "boundary_faces": [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]],
                        "boundary_markers": [99, 99, 99, 99],
                        "per_domain_quality": {
                            "1": {
                                "n_elements": 1,
                                "sicn_min": 0.5,
                                "sicn_max": 0.5,
                                "sicn_mean": 0.5,
                                "sicn_p5": 0.5,
                                "sicn_histogram": [0] * 20,
                                "gamma_min": 0.2,
                                "gamma_mean": 0.2,
                                "gamma_histogram": [0] * 20,
                                "volume_min": 1.0,
                                "volume_max": 1.0,
                                "volume_mean": 1.0,
                                "volume_std": 0.0,
                                "avg_quality": 0.5,
                            }
                        },
                    },
                }
            ],
        }
        with patch("fullmag.world.build_geometry_assets_for_request", return_value=assets):
            body.mesh(maximum_element_size=4e-9, order=1, compute_quality=True).build()

        quality = body.mesh.quality()
        self.assertIsNotNone(quality)
        self.assertEqual(getattr(quality, "n_elements", None), 1)
        fm.reset()

    def test_flat_mesh_rewrite_preserves_multi_body_mesh_calls(self) -> None:
        script = """
        import fullmag as fm

        fm.engine("fem")
        left = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="left")
        left.Ms = 800e3
        left.Aex = 13e-12
        left.alpha = 0.1
        left.m = fm.texture.uniform(1, 0, 0)
        left.mesh(maximum_element_size=4e-9, order=1).build()

        right = fm.geometry(fm.Box(80e-9, 20e-9, 5e-9).translate((120e-9, 0, 0)), name="right")
        right.Ms = 800e3
        right.Aex = 13e-12
        right.alpha = 0.1
        right.m = fm.texture.uniform(1, 0, 0)
        right.mesh(maximum_element_size=4e-9, order=1).build()

        fm.run(1e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_flat_multibody_mesh.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            with patch("fullmag.world.build_geometry_assets_for_request", return_value=None):
                loaded = fm.load_problem_from_script(path)

        rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
        self.assertIn("left.mesh(maximum_element_size=4e-09, order=1)", rewritten)
        self.assertIn("left.mesh.build()", rewritten)
        self.assertIn("right.mesh(maximum_element_size=4e-09, order=1)", rewritten)
        self.assertIn("right.mesh.build()", rewritten)

    def test_study_mesh_builder_preserves_global_and_local_fem_mesh_modes(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("mesh_modes")
        study.engine("fem")
        study.objects.mesh.defaults(maximum_element_size=25e-9, order=1)

        a = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="a")
        a.Ms = 800e3
        a.Aex = 13e-12
        a.alpha = 0.1
        a.m = fm.texture.uniform(1, 0, 0)

        b = study.geometry(fm.Box(80e-9, 20e-9, 5e-9), name="b")
        b.Ms = 800e3
        b.Aex = 13e-12
        b.alpha = 0.1
        b.m = fm.texture.uniform(1, 0, 0)
        b.mesh(maximum_element_size=20e-9, order=2)

        study.run(1e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_study_mesh_modes.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path)

        draft = export_builder_draft(loaded)
        self.assertEqual(draft["mesh"]["hmax"], "2.5e-08")
        mesh_by_name = {entry["name"]: entry["mesh"] for entry in draft["geometries"]}
        self.assertEqual(mesh_by_name["a"]["mode"], "inherit")
        self.assertEqual(mesh_by_name["b"]["mode"], "custom")
        self.assertEqual(mesh_by_name["b"]["hmax"], "2e-08")
        self.assertEqual(mesh_by_name["b"]["order"], 2)

        rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
        self.assertIn('study.objects.mesh.defaults(maximum_element_size=2.5e-08, order=1)', rewritten)
        self.assertNotIn("study.mesh(", rewritten)
        self.assertNotIn("a.mesh(", rewritten)
        self.assertIn("b.mesh(maximum_element_size=2e-08, order=2)", rewritten)

    def test_study_mesh_builder_does_not_infer_global_mesh_from_local_override(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("custom_only")
        study.engine("fem")

        a = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="a")
        a.Ms = 800e3
        a.Aex = 13e-12
        a.alpha = 0.1
        a.m = fm.texture.uniform(1, 0, 0)
        a.mesh(maximum_element_size=4e-9, order=1)

        study.run(1e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_study_custom_mesh_only.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path)

        draft = export_builder_draft(loaded)
        self.assertEqual(draft["mesh"]["hmax"], "")
        self.assertEqual(draft["geometries"][0]["mesh"]["mode"], "custom")
        self.assertEqual(draft["geometries"][0]["mesh"]["hmax"], "4e-09")

        rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
        self.assertNotIn("study.objects.mesh.defaults(", rewritten)
        self.assertNotIn("study.mesh(", rewritten)
        self.assertIn("a.mesh(maximum_element_size=4e-09, order=1)", rewritten)

    def test_study_mesh_build_request_without_local_override_stays_inherit(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("build_request_inherit")
        study.engine("fem")
        study.universe(mode="auto", padding=(10e-9, 10e-9, 10e-9))
        study.universe.mesh(maximum_element_size=25e-9)
        study.objects.mesh.defaults(maximum_element_size=8e-9, order=1)

        body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="body")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        body.mesh.build()

        study.run(1e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_study_mesh_build_request_inherit.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            with patch("fullmag.world.build_geometry_assets_for_request", return_value=None):
                loaded = fm.load_problem_from_script(path)

        draft = export_builder_draft(loaded)
        mesh_entry = draft["geometries"][0]["mesh"]
        self.assertEqual(mesh_entry["mode"], "inherit")
        self.assertTrue(mesh_entry["build_requested"])

        rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
        self.assertIn('study.objects.mesh.defaults(maximum_element_size=8e-09, order=1)', rewritten)
        self.assertNotIn("body.mesh(maximum_element_size=", rewritten)
        self.assertIn("body.mesh.build()", rewritten)

    def test_study_mesh_builder_exports_full_per_object_mesh_details(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("object_mesh_details")
        study.engine("fem")
        study.objects.mesh.defaults(maximum_element_size=25e-9, growth_rate=1.8, narrow_regions=2)

        body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="body")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        body.mesh(
            maximum_element_size=20e-9,
            minimum_element_size=5e-9,
            order=2,
            algorithm_2d=5,
            algorithm_3d=10,
            size_factor=0.75,
            size_from_curvature=24,
            growth_rate=1.4,
            narrow_regions=3,
            interface_maximum_element_size=3e-9,
            interface_thickness=6e-9,
            transition_distance=24e-9,
            transition_growth=1.2,
            smoothing_steps=4,
            optimize="Netgen",
            optimize_iterations=3,
            compute_quality=True,
            per_element_quality=True,
        ).size_field("Ball", VIn=1e-9, Radius=20e-9).smooth(iterations=2)
        body.mesh.build()

        study.run(1e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_study_object_mesh_details.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            with patch("fullmag.world.build_geometry_assets_for_request", return_value=None):
                loaded = fm.load_problem_from_script(path)

        draft = export_builder_draft(loaded)
        self.assertEqual(draft["mesh"]["growth_rate"], "1.8")
        self.assertEqual(draft["mesh"]["narrow_regions"], 2)
        mesh_entry = draft["geometries"][0]["mesh"]
        self.assertEqual(mesh_entry["mode"], "custom")
        self.assertEqual(mesh_entry["hmax"], "2e-08")
        self.assertEqual(mesh_entry["hmin"], "5e-09")
        self.assertEqual(mesh_entry["order"], 2)
        self.assertEqual(mesh_entry["algorithm_2d"], 5)
        self.assertEqual(mesh_entry["algorithm_3d"], 10)
        self.assertEqual(mesh_entry["size_factor"], 0.75)
        self.assertEqual(mesh_entry["size_from_curvature"], 24)
        self.assertEqual(mesh_entry["growth_rate"], "1.4")
        self.assertEqual(mesh_entry["narrow_regions"], 3)
        self.assertEqual(mesh_entry["interface_maximum_element_size"], "3e-09")
        self.assertEqual(mesh_entry["interface_thickness"], "6e-09")
        self.assertEqual(mesh_entry["transition_distance"], "2.4e-08")
        self.assertEqual(mesh_entry["transition_growth"], 1.2)
        self.assertEqual(mesh_entry["smoothing_steps"], 4)
        self.assertEqual(mesh_entry["optimize"], "Netgen")
        self.assertEqual(mesh_entry["optimize_iterations"], 3)
        self.assertTrue(mesh_entry["compute_quality"])
        self.assertTrue(mesh_entry["per_element_quality"])
        self.assertEqual(mesh_entry["size_fields"][0]["kind"], "Ball")
        self.assertEqual(mesh_entry["operations"][0]["kind"], "smooth")

        rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
        self.assertIn("study.objects.mesh.defaults(maximum_element_size=2.5e-08, maximum_element_growth_rate=1.8, narrow_regions=2)", rewritten)
        self.assertNotIn("study.mesh(", rewritten)
        self.assertIn("body.mesh(maximum_element_size=2e-08, minimum_element_size=5e-09, order=2", rewritten)
        self.assertIn("algorithm_2d=5", rewritten)
        self.assertIn("algorithm_3d=10", rewritten)
        self.assertIn("size_factor=0.75", rewritten)
        self.assertIn("size_from_curvature=24", rewritten)
        self.assertIn("smoothing_steps=4", rewritten)
        self.assertIn("optimize_iterations=3", rewritten)
        self.assertIn("maximum_element_growth_rate=1.4", rewritten)
        self.assertIn("narrow_regions=3", rewritten)
        self.assertIn("interface_maximum_element_size=3e-09", rewritten)
        self.assertIn("interface_thickness=6e-09", rewritten)
        self.assertIn("transition_distance=2.4e-08", rewritten)
        self.assertIn("transition_growth=1.2", rewritten)
        self.assertIn('optimize="Netgen"', rewritten)
        self.assertIn("compute_quality=True", rewritten)
        self.assertIn("per_element_quality=True", rewritten)
        self.assertIn('body.mesh.size_field("Ball"', rewritten)
        self.assertIn("body.mesh.smooth(iterations=2)", rewritten)
        self.assertIn("body.mesh.build()", rewritten)

    def test_study_mesh_builder_exports_box_perimeter_refinement(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("object_mesh_perimeter_refinement")
        study.engine("fem")
        study.objects.mesh.defaults(maximum_element_size=25e-9)

        body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="body")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        body.mesh(
            maximum_element_size=20e-9,
            edge_maximum_element_size=5e-9,
            edge_thickness=9e-9,
            corner_maximum_element_size=3e-9,
            corner_extent=8e-9,
        )

        study.run(1e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_study_object_mesh_perimeter_refinement.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            with patch("fullmag.world.build_geometry_assets_for_request", return_value=None):
                loaded = fm.load_problem_from_script(path)

        mesh_entry = export_builder_draft(loaded)["geometries"][0]["mesh"]
        self.assertEqual(mesh_entry["edge_maximum_element_size"], "5e-09")
        self.assertEqual(mesh_entry["edge_thickness"], "9e-09")
        self.assertEqual(mesh_entry["corner_maximum_element_size"], "3e-09")
        self.assertEqual(mesh_entry["corner_extent"], "8e-09")

        rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
        self.assertIn("edge_maximum_element_size=5e-09", rewritten)
        self.assertIn("edge_thickness=9e-09", rewritten)
        self.assertIn("corner_maximum_element_size=3e-09", rewritten)
        self.assertIn("corner_extent=8e-09", rewritten)

    def test_box_perimeter_refinement_allows_interface_shell_coexistence(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("object_mesh_perimeter_refinement_interface")
        study.engine("fem")

        body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="body")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        body.mesh(
            maximum_element_size=20e-9,
            edge_maximum_element_size=5e-9,
            edge_thickness=9e-9,
            interface_maximum_element_size=3e-9,
        )
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_study_object_mesh_perimeter_refinement_interface.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            with patch("fullmag.world.build_geometry_assets_for_request", return_value=None):
                loaded = fm.load_problem_from_script(path)

        mesh_entry = export_builder_draft(loaded)["geometries"][0]["mesh"]
        self.assertEqual(mesh_entry["edge_maximum_element_size"], "5e-09")
        self.assertEqual(mesh_entry["edge_thickness"], "9e-09")
        self.assertEqual(mesh_entry["interface_maximum_element_size"], "3e-09")

    def test_public_boundary_layers_helper_exports_runtime_metadata(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("boundary_layers_public_helper")
        study.engine("fem")

        body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="body")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        body.mesh(
            maximum_element_size=20e-9,
            **fm.mesh.boundary_layers(
                count=3,
                first_layer_thickness=1e-9,
                stretching=1.25,
                target_surface_tags=[11, 12],
                target_curve_tags=[21],
            ),
        )
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_study_object_mesh_boundary_layers.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            with patch("fullmag.world.build_geometry_assets_for_request", return_value=None):
                loaded = fm.load_problem_from_script(path)

        mesh_entry = export_builder_draft(loaded)["geometries"][0]["mesh"]
        self.assertEqual(mesh_entry["boundary_layer_count"], 3)
        self.assertEqual(mesh_entry["boundary_layer_thickness"], "1e-09")
        self.assertEqual(mesh_entry["boundary_layer_stretching"], 1.25)
        self.assertEqual(mesh_entry["boundary_layer_target_surface_tags"], [11, 12])
        self.assertEqual(mesh_entry["boundary_layer_target_curve_tags"], [21])

    def test_study_mesh_builder_exports_comsol_like_size_semantics(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("comsol_size_semantics")
        study.engine("fem")
        study.objects.mesh.defaults(
            maximum_element_size=25e-9,
            calibrate_for="general_physics",
            size_preset="finer",
            curvature_factor=0.4,
            narrow_region_resolution=0.7,
        )

        body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="body")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        body.mesh(
            maximum_element_size=20e-9,
            calibrate_for="general_physics",
            size_preset="fine",
            curvature_factor=0.5,
            narrow_region_resolution=0.6,
        )

        study.run(1e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_comsol_size_semantics.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            with patch("fullmag.world.build_geometry_assets_for_request", return_value=None):
                loaded = fm.load_problem_from_script(path)

        workflow = loaded.problem.runtime_metadata["mesh_workflow"]
        mesh_options = workflow["mesh_options"]
        self.assertEqual(mesh_options["calibrate_for"], "general_physics")
        self.assertEqual(mesh_options["size_preset"], "finer")
        self.assertEqual(mesh_options["curvature_factor"], 0.4)
        self.assertEqual(mesh_options["narrow_region_resolution"], 0.7)
        self.assertEqual(workflow["per_geometry"][0]["size_preset"], "fine")

        rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
        self.assertIn('study.objects.mesh.defaults(maximum_element_size=2.5e-08, calibrate_for="general_physics", size_preset="finer", curvature_factor=0.4, narrow_region_resolution=0.7)', rewritten)
        self.assertIn('body.mesh(maximum_element_size=2e-08, calibrate_for="general_physics", size_preset="fine", curvature_factor=0.5, narrow_region_resolution=0.6)', rewritten)
        self.assertNotIn("study.mesh(", rewritten)

    def test_legacy_study_mesh_entrypoints_raise_migration_errors(self) -> None:
        fm.reset()
        study = fm.study("legacy_mesh_entrypoints")
        study.engine("fem")
        with self.assertRaisesRegex(ValueError, "study.objects.mesh.defaults"):
            study.object_mesh_defaults(maximum_element_size=12e-9, order=2, growth_rate=1.6)
        with self.assertRaisesRegex(ValueError, "study.objects.mesh.defaults"):
            study.mesh(maximum_element_size=12e-9, order=2)
        with self.assertRaisesRegex(ValueError, "study.universe.mesh"):
            study.airbox(maximum_element_size=80e-9)
        with self.assertRaisesRegex(ValueError, "study.universe.mesh"):
            study.universe(mode="auto", airbox_hmax=80e-9)
        with self.assertRaisesRegex(ValueError, "study.objects.mesh.defaults"):
            fm.object_mesh_defaults(maximum_element_size=12e-9)
        with self.assertRaisesRegex(ValueError, "study.objects.mesh.defaults"):
            fm.mesh(maximum_element_size=12e-9)

    def test_builder_draft_exports_geometry_bounds_for_translated_box(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("bounds_box")
        study.engine("fdm")
        study.cell(5e-9, 5e-9, 5e-9)

        body = study.geometry(
            fm.Box(size=(10e-9, 20e-9, 30e-9), name="box").translate((5e-9, -2e-9, 1e-9)),
            name="box",
        )
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)

        study.run(1e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_builder_bounds_box.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path)

        draft = export_builder_draft(loaded)
        geometry = draft["geometries"][0]
        self.assertEqual(geometry["geometry_params"]["translation"], [5e-09, -2e-09, 1e-09])
        for actual, expected in zip(geometry["bounds_min"], [0.0, -12e-9, -14e-9], strict=True):
            self.assertAlmostEqual(actual, expected)
        for actual, expected in zip(geometry["bounds_max"], [10e-9, 8e-9, 16e-9], strict=True):
            self.assertAlmostEqual(actual, expected)

    def test_builder_draft_exports_geometry_bounds_for_translated_sin_waveguide(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("bounds_sin_waveguide")
        study.engine("fdm")
        study.cell(5e-9, 5e-9, 5e-9)

        body = study.geometry(
            fm.SinWaveguide(
                length=10e-9,
                width=4e-9,
                height=2e-9,
                period=8e-9,
                amplitude=3e-9,
                z0=1e-9,
                name="sinus",
            ).translate((5e-9, -2e-9, 4e-9)),
            name="sinus",
        )
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)

        study.run(1e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_builder_bounds_sin_waveguide.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path)

        draft = export_builder_draft(loaded)
        geometry = draft["geometries"][0]
        self.assertEqual(geometry["geometry_params"]["translation"], [5e-09, -2e-09, 4e-09])
        for actual, expected in zip(geometry["bounds_min"], [0.0, -4e-9, 1e-9], strict=True):
            self.assertAlmostEqual(actual, expected)
        for actual, expected in zip(geometry["bounds_max"], [10e-9, 0.0, 9e-9], strict=True):
            self.assertAlmostEqual(actual, expected)

    def test_builder_draft_exports_relative_imported_geometry_bounds_without_trimesh(self) -> None:
        script = """
        import fullmag as fm

        fm.engine("fem")
        body = fm.geometry(
            fm.ImportedGeometry(source="cube.stl", name="cube").translate((2.0, 3.0, 4.0)),
            name="cube",
        )
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        fm.run(1e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            self._write_binary_cube_stl(tmp_path / "cube.stl")
            path = tmp_path / "script_builder_bounds_imported.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            with patch(
                "fullmag.meshing.surface_assets._import_trimesh",
                side_effect=ImportError("missing trimesh"),
            ):
                loaded = fm.load_problem_from_script(path, lightweight_assets=True)
                draft = export_builder_draft(loaded)

        geometry = draft["geometries"][0]
        self.assertEqual(geometry["geometry_params"]["source"], "cube.stl")
        for actual, expected in zip(geometry["bounds_min"], [1.0, 2.0, 3.0], strict=True):
            self.assertAlmostEqual(actual, expected)
        for actual, expected in zip(geometry["bounds_max"], [3.0, 4.0, 5.0], strict=True):
            self.assertAlmostEqual(actual, expected)

    def test_flat_adaptive_mesh_policy_lowers_to_runtime_metadata(self) -> None:
        script = """
        import fullmag as fm

        fm.engine("fem")
        body = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        body.mesh(maximum_element_size=4e-9, order=1).build()
        fm.adaptive_mesh(
            policy="auto",
            theta=0.25,
            h_min=2e-9,
            h_max=8e-9,
            max_passes=4,
            error_tolerance=1e-3,
            chunk_until_seconds=2e-12,
        )
        fm.run(2e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_flat_adaptive_mesh_policy.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            with patch("fullmag.world.build_geometry_assets_for_request", return_value=None):
                loaded = fm.load_problem_from_script(path)

        adaptive = loaded.problem.runtime_metadata["adaptive_mesh"]
        self.assertTrue(adaptive["enabled"])
        self.assertEqual(adaptive["policy"], "auto")
        self.assertEqual(adaptive["max_passes"], 4)
        self.assertEqual(adaptive["theta"], 0.25)
        self.assertEqual(adaptive["chunk_until_seconds"], 2e-12)

    def test_script_rewrite_preserves_adaptive_mesh_policy(self) -> None:
        script = """
        import fullmag as fm

        fm.engine("fem")
        body = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        body.mesh(maximum_element_size=4e-9, order=1).build()
        fm.adaptive_mesh(policy="auto", theta=0.25, max_passes=4, error_tolerance=1e-3)
        fm.run(2e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_rewrite_adaptive_mesh.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            with patch("fullmag.world.build_geometry_assets_for_request", return_value=None):
                loaded = fm.load_problem_from_script(path)

        rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
        self.assertIn('fm.adaptive_mesh(True, policy="auto", indicator="geometric_only", target_quantity="auto", convergence_metric="energy_delta", theta=0.25, max_passes=4, error_tolerance=0.001)', rewritten)

    def test_flat_solver_accepts_g_factor(self) -> None:
        script = """
        import fullmag as fm

        fm.engine("fdm")
        fm.cell(5e-9, 5e-9, 5e-9)
        body = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
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
        body.m = fm.texture.uniform(1, 0, 0)
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
        body.m = fm.texture.uniform(1, 0, 0)
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
                m0=fm.texture.uniform((1.0, 0.0, 0.0)),
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
        body.m = fm.texture.uniform(1, 0, 0)
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
        body.m = fm.texture.uniform(1, 0, 0)
        body.mesh(maximum_element_size=4e-9, order=1).build()
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

    def test_cli_leaves_relaxation_without_time_budget_unbounded(self) -> None:
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
        self.assertEqual(captured["until_seconds"], float("inf"))

    def test_cli_ignores_adaptive_relaxation_dt_seed_when_no_time_budget(self) -> None:
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
        self.assertEqual(captured["until_seconds"], float("inf"))

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
        body.m = fm.texture.uniform(1, 0, 0)
        body.mesh(maximum_element_size=4e-9, order=1).build()
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
        self.assertEqual(payload["study_pipeline"]["version"], "study_pipeline.v1")
        self.assertEqual(len(payload["study_pipeline"]["nodes"]), 2)
        self.assertEqual(
            payload["ir"]["problem_meta"]["runtime_metadata"]["study_pipeline"]["version"],
            "study_pipeline.v1",
        )
        self.assertEqual(
            payload["ir"]["problem_meta"]["runtime_metadata"]["model_builder"]["study_pipeline"]["version"],
            "study_pipeline.v1",
        )
        self.assertEqual(
            payload["ir"]["problem_meta"]["runtime_metadata"]["script_sync"]["study_pipeline_version"],
            "study_pipeline.v1",
        )
        self.assertEqual(payload["stages"][0]["entrypoint_kind"], "flat_relax")
        self.assertEqual(payload["stages"][1]["entrypoint_kind"], "flat_run")
        self.assertEqual(payload["stages"][1]["default_until_seconds"], 4e-12)
        self.assertEqual(
            payload["stages"][0]["ir"]["problem_meta"]["runtime_metadata"]["study_pipeline"]["version"],
            "study_pipeline.v1",
        )
        self.assertEqual(
            payload["stages"][1]["ir"]["problem_meta"]["runtime_metadata"]["model_builder"]["study_pipeline"]["version"],
            "study_pipeline.v1",
        )

    def test_helper_exports_run_config_with_stage_actions(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("run_config_stage_actions")
        study.engine("fem")
        body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        study.stages.add_hysteresis_branch(
            field_values_t=[-5e-3, 5e-3],
            settle=fm.RelaxStop(torque_tolerance_apm=1e-5, max_steps=20),
            save_state=True,
        )
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_run_config_stage_actions.py"
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
        self.assertEqual(payload["ir"]["problem_meta"]["entrypoint_kind"], "flat_workspace")
        self.assertEqual(len(payload["stages"]), 4)
        self.assertIsNone(payload["stages"][0]["action"])
        self.assertEqual(
            payload["stages"][1]["action"],
            {
                "kind": "save_state",
                "artifact_name": "hysteresis_branch_point_001",
                "format": None,
                "dataset": None,
            },
        )
        self.assertEqual(
            payload["stages"][3]["action"],
            {
                "kind": "save_state",
                "artifact_name": "hysteresis_branch_point_002",
                "format": None,
                "dataset": None,
            },
        )


if __name__ == "__main__":
    unittest.main()
