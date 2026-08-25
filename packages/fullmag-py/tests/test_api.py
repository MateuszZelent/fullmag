from __future__ import annotations

import contextlib
import copy
import io
import json
import math
import os
import importlib.util
import subprocess
import struct
import sys
import textwrap
import types
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
from fullmag.runtime.loader import LoadedProblem, load_problem_from_script
from fullmag.runtime.scene_document import build_scene_document_from_builder
from fullmag.runtime.scene_document import build_builder_from_scene_document
from fullmag.runtime.scene_document import builder_overrides_from_scene_document
from fullmag.runtime.script_builder import export_builder_draft, rewrite_loaded_problem_script
from fullmag.meshing.gmsh_bridge import MeshData
from fullmag.model.discretization import PerObjectMeshRecipe
from fullmag.model.problem import build_geometry_assets_for_request


class ProblemApiTests(unittest.TestCase):
    def test_fem_order_rejects_boolean_and_noninteger_values(self) -> None:
        for invalid_order in (True, False, 1.5):
            with self.subTest(order=invalid_order):
                with self.assertRaisesRegex(ValueError, "order must be an integer >= 1"):
                    fm.FEM(order=invalid_order, maximum_element_size=1e-9)

    def test_fem_order_accepts_and_normalizes_numpy_integral(self) -> None:
        fem = fm.FEM(order=np.int64(1), maximum_element_size=1e-9)

        self.assertEqual(fem.order, 1)
        self.assertIs(type(fem.order), int)

    def test_fem_size_rejects_boolean_values(self) -> None:
        for field_name, kwargs in (
            ("maximum_element_size", {"maximum_element_size": True}),
            ("hmax", {"hmax": True}),
            (
                "hmax alongside maximum_element_size",
                {"maximum_element_size": 1e-9, "hmax": True},
            ),
        ):
            with self.subTest(field=field_name):
                with self.assertRaisesRegex(TypeError, "not bool"):
                    fm.FEM(order=1, **kwargs)

    def test_geometry_asset_cache_copies_by_default_and_can_be_borrowed_internally(self) -> None:
        cached_assets = {"fem_domain_mesh_asset": {"mesh": {"nodes": [[0.0, 0.0, 0.0]]}}}
        cache = {"cached": cached_assets}
        with patch(
            "fullmag.model.problem._geometry_asset_cache_key",
            return_value="cached",
        ):
            copied = build_geometry_assets_for_request(
                requested_backend=fm.BackendTarget.FEM,
                geometries=[],
                discretization=fm.DiscretizationHints(fem=fm.FEM(order=1, hmax=1e-9)),
                asset_cache=cache,
            )
            borrowed = build_geometry_assets_for_request(
                requested_backend=fm.BackendTarget.FEM,
                geometries=[],
                discretization=fm.DiscretizationHints(fem=fm.FEM(order=1, hmax=1e-9)),
                asset_cache=cache,
                _copy_cached_assets=False,
            )

        self.assertIsNot(copied, cached_assets)
        self.assertIs(borrowed, cached_assets)
        copied["fem_domain_mesh_asset"]["mesh"]["nodes"].append([1.0, 0.0, 0.0])
        self.assertEqual(len(cached_assets["fem_domain_mesh_asset"]["mesh"]["nodes"]), 1)

    def test_fdm_grid_cache_ignores_region_only_changes(self) -> None:
        geometry = fm.Cylinder(radius=10e-9, height=4e-9, name="film")
        discretization = fm.DiscretizationHints(
            fdm=fm.FDM(cell=(2e-9, 2e-9, 2e-9)),
        )
        voxels = VoxelMaskData(
            mask=np.ones((2, 2, 5), dtype=np.bool_),
            cell_size=(2e-9, 2e-9, 2e-9),
            origin=(-2e-9, -2e-9, -5e-9),
        )
        cache: dict[str, dict[str, object] | None] = {}
        region_a = [{"region_id": "film:core", "material_ref": "mat:a"}]
        region_b = [{"region_id": "film:core", "material_ref": "mat:b"}]

        with patch("fullmag.meshing.realize_fdm_grid_asset", return_value=voxels) as mocked:
            first = build_geometry_assets_for_request(
                requested_backend=fm.BackendTarget.FDM,
                geometries=[geometry],
                discretization=discretization,
                object_regions=region_a,
                asset_cache=cache,
            )
            second = build_geometry_assets_for_request(
                requested_backend=fm.BackendTarget.FDM,
                geometries=[geometry],
                discretization=discretization,
                object_regions=region_b,
                asset_cache=cache,
            )
            third = build_geometry_assets_for_request(
                requested_backend=fm.BackendTarget.FDM,
                geometries=[geometry],
                discretization=fm.DiscretizationHints(
                    fdm=fm.FDM(cell=(1e-9, 2e-9, 2e-9)),
                ),
                object_regions=region_b,
                asset_cache=cache,
            )

        self.assertEqual(mocked.call_count, 2)
        self.assertEqual(first, second)
        self.assertEqual(third, first)
    def test_script_builder_preserves_frozen_magnetic_submesh_source_in_global_mesh_config(self) -> None:
        from fullmag.runtime.script_builder import _study_global_mesh_config

        source = {
            "mesh_source": "mesh/frozen_film.npz",
            "region_markers": [{"geometry_name": "film", "marker": 1}],
        }
        problem = types.SimpleNamespace(
            runtime_metadata={
                "mesh_workflow": {
                    "build_requested": True,
                    "build_target": "domain",
                    "domain_mesh_mode": "generated_frozen_magnetic_submesh",
                    "frozen_magnetic_submesh_source": source,
                    "fem": {"order": 1, "hmax": 20e-9},
                }
            },
            discretization=types.SimpleNamespace(fem=fm.FEM(order=1, hmax=20e-9)),
        )

        config = _study_global_mesh_config(problem, {})

        self.assertEqual(config["domain_mesh_mode"], "generated_frozen_magnetic_submesh")
        self.assertEqual(config["frozen_magnetic_submesh_source"], source)

    def test_study_frozen_magnetic_submesh_source_sets_domain_mesh_workflow(self) -> None:
        script = textwrap.dedent(
            """
            import fullmag as fm

            study = fm.study("frozen_domain_mesh")
            study.engine("fem")
            study.universe(mode="manual", size=(4e-7, 4e-7, 9e-8), center=(0.0, 0.0, 0.0))
            study.universe.mesh(maximum_element_size=1.2e-7, minimum_element_size=1.6e-8)
            film = study.geometry(fm.Box(size=(2e-7, 2e-7, 1e-8), name="film"), name="film")
            film.Ms = 800e3
            film.Aex = 13e-12
            film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
            film.mesh(maximum_element_size=2e-8, minimum_element_size=8e-9)
            study.frozen_magnetic_submesh(
                source="mesh/frozen_film.npz",
                region_markers={"film": 1},
            )
            study.build_domain_mesh()
            study.stages.add_frequency_response(
                frequencies_hz=[2.75e9],
                excitation_field_au_per_m=(0.0, 0.0, 1.0),
                include_demag=True,
                bc=fm.PeriodicBC(["x_faces", "y_faces"]),
                magnetostatic_bc="periodic_airbox_k0",
            )
            """
        )

        with TemporaryDirectory() as tmp_dir:
            script_path = Path(tmp_dir) / "frozen_domain_mesh.py"
            script_path.write_text(script, encoding="utf-8")
            loaded = fm.load_problem_from_script(script_path, lightweight_assets=True)

        problem = loaded.stages[0].problem
        mesh_workflow = problem.runtime_metadata["mesh_workflow"]
        self.assertEqual(mesh_workflow["domain_mesh_mode"], "generated_frozen_magnetic_submesh")
        self.assertEqual(
            mesh_workflow["frozen_magnetic_submesh_source"],
            {
                "mesh_source": "mesh/frozen_film.npz",
                "region_markers": [{"geometry_name": "film", "marker": 1}],
            },
        )

    def test_study_frozen_magnetic_submesh_source_rewrite_preserves_declaration(self) -> None:
        script = textwrap.dedent(
            """
            import fullmag as fm

            study = fm.study("frozen_domain_mesh")
            study.engine("fem")
            study.universe(mode="manual", size=(4e-7, 4e-7, 9e-8), center=(0.0, 0.0, 0.0))
            study.universe.mesh(maximum_element_size=1.2e-7, minimum_element_size=1.6e-8)
            film = study.geometry(fm.Box(size=(2e-7, 2e-7, 1e-8), name="film"), name="film")
            film.Ms = 800e3
            film.Aex = 13e-12
            film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
            film.mesh(maximum_element_size=2e-8, minimum_element_size=8e-9)
            study.frozen_magnetic_submesh(
                source="mesh/frozen_film.npz",
                region_markers={"film": 1},
                air_mesh_source="mesh/airbox.npz",
            )
            study.build_domain_mesh()
            study.run(1e-12)
            """
        )

        with TemporaryDirectory() as tmp_dir:
            script_path = Path(tmp_dir) / "frozen_domain_mesh.py"
            script_path.write_text(script, encoding="utf-8")
            loaded = fm.load_problem_from_script(script_path, lightweight_assets=True)

        rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]

        self.assertIn(
            'study.frozen_magnetic_submesh(source="mesh/frozen_film.npz", region_markers={"film": 1}, air_mesh_source="mesh/airbox.npz")',
            rewritten,
        )
        self.assertIn("study.build_domain_mesh()", rewritten)

    def test_dmi_lowercase_properties_redirect_to_uppercase(self) -> None:
        fm.reset()
        geom = fm.Box(size=(10e-9, 10e-9, 10e-9), name="box")
        layer = fm.geometry(geom)
        
        # Test interfacial DMI getter/setter redirection
        layer.dind = 1.5e-3
        self.assertEqual(layer.Dind, 1.5e-3)
        self.assertEqual(layer.dind, 1.5e-3)
        
        # Test bulk DMI getter/setter redirection
        layer.dbulk = -2.5e-3
        self.assertEqual(layer.Dbulk, -2.5e-3)
        self.assertEqual(layer.dbulk, -2.5e-3)

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

    def test_demag_phi_can_be_requested_as_field_output(self) -> None:
        self.assertEqual(
            fm.SaveField("demag_phi", every=1e-12).to_ir(),
            {"kind": "field", "name": "demag_phi", "every_seconds": 1e-12},
        )
        self.assertEqual(
            fm.SaveQuantity("demag_phi", every=1e-12).to_ir(),
            {
                "kind": "save_quantity",
                "quantity_id": "demag_phi",
                "every_seconds": 1e-12,
            },
        )

    def test_problem_to_ir_contains_canonical_sections(self) -> None:
        problem = self._build_problem()
        ir = problem.to_ir()

        self.assertEqual(ir["ir_version"], "0.3.0")
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
        self.assertEqual(ir["object_regions"], [])
        self.assertEqual(ir["material_parameter_fields"], [])
        self.assertEqual(ir["couplings"], [])

    def test_legacy_anisotropy_energy_terms_migrate_to_the_single_material(self) -> None:
        base_problem = self._build_problem()
        material = replace(base_problem.magnets[0].material, Ku1=None, anisU=None)
        problem = replace(
            base_problem,
            magnets=[replace(base_problem.magnets[0], material=material)],
            energy=[
                fm.Exchange(),
                fm.UniaxialAnisotropy(ku1=0.5e6, ku2=0.1e6, axis=(0.0, 1.0, 0.0)),
                fm.CubicAnisotropy(
                    kc1=0.2e6,
                    kc2=0.03e6,
                    kc3=0.01e6,
                    axis1=(0.0, 1.0, 0.0),
                    axis2=(0.0, 0.0, 1.0),
                ),
            ],
        )

        ir = problem.to_ir(include_geometry_assets=False)

        self.assertEqual(ir["energy_terms"], [{"kind": "exchange"}])
        material = ir["materials"][0]
        self.assertEqual(material["uniaxial_anisotropy"], 0.5e6)
        self.assertEqual(material["uniaxial_anisotropy_k2"], 0.1e6)
        self.assertEqual(material["anisotropy_axis"], [0.0, 1.0, 0.0])
        self.assertEqual(material["cubic_anisotropy_kc1"], 0.2e6)
        self.assertEqual(material["cubic_anisotropy_kc2"], 0.03e6)
        self.assertEqual(material["cubic_anisotropy_kc3"], 0.01e6)
        self.assertEqual(material["cubic_anisotropy_axis1"], [0.0, 1.0, 0.0])
        self.assertEqual(material["cubic_anisotropy_axis2"], [0.0, 0.0, 1.0])

    def test_material_only_anisotropy_is_a_valid_problem(self) -> None:
        problem = replace(self._build_problem(), energy=[])

        ir = problem.to_ir(include_geometry_assets=False)

        self.assertEqual(ir["energy_terms"], [])
        self.assertEqual(ir["materials"][0]["uniaxial_anisotropy"], 0.5e6)

    def test_material_uses_signed_ku1_for_easy_plane_anisotropy(self) -> None:
        material = replace(
            self._build_problem().magnets[0].material,
            Ku1=-0.5e6,
            Ku2=-0.1e6,
        )

        self.assertEqual(material.to_ir()["uniaxial_anisotropy"], -0.5e6)
        self.assertEqual(material.to_ir()["uniaxial_anisotropy_k2"], -0.1e6)

    def test_legacy_anisotropy_energy_terms_reject_multiple_material_targets(self) -> None:
        problem = self._build_problem()
        second_magnet = fm.Ferromagnet(
            name="second",
            geometry=fm.Box(size=(100e-9, 20e-9, 5e-9), name="second"),
            material=fm.Material(name="Co", Ms=1.4e6, A=30e-12, alpha=0.02),
            m0=fm.texture.uniform((1.0, 0.0, 0.0)),
        )

        with self.assertRaisesRegex(ValueError, "single material"):
            replace(
                problem,
                magnets=[*problem.magnets, second_magnet],
                energy=[fm.Exchange(), fm.UniaxialAnisotropy(ku1=0.5e6)],
            )

    def test_legacy_anisotropy_script_rewrites_to_material_semantics(self) -> None:
        script = textwrap.dedent(
            """
            import fullmag as fm

            DEFAULT_UNTIL = 1e-12

            def build():
                geometry = fm.Box(size=(20e-9, 10e-9, 5e-9), name="film")
                material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.02)
                magnet = fm.Ferromagnet(
                    name="film",
                    geometry=geometry,
                    material=material,
                    m0=fm.texture.uniform((1.0, 0.0, 0.0)),
                )
                return fm.Problem(
                    name="legacy_anisotropy",
                    magnets=[magnet],
                    energy=[fm.Exchange(), fm.UniaxialAnisotropy(ku1=0.5e6, axis=(0.0, 1.0, 0.0))],
                    study=fm.TimeEvolution(
                        dynamics=fm.LLG(),
                        outputs=[fm.SaveField("m", every=1e-12)],
                    ),
                )
            """
        )

        with TemporaryDirectory() as tmp_dir:
            source_path = Path(tmp_dir) / "legacy_anisotropy.py"
            source_path.write_text(script, encoding="utf-8")
            loaded = load_problem_from_script(source_path, lightweight_assets=True)
            rendered = rewrite_loaded_problem_script(loaded)["rendered_source"]
            rewritten_path = Path(tmp_dir) / "rewritten.py"
            rewritten_path.write_text(rendered, encoding="utf-8")
            reloaded = load_problem_from_script(rewritten_path, lightweight_assets=True)

        self.assertIn("Ku1", rendered)
        ir = reloaded.problem.to_ir(include_geometry_assets=False)
        self.assertEqual(ir["materials"][0]["uniaxial_anisotropy"], 0.5e6)
        self.assertEqual(ir["materials"][0]["anisotropy_axis"], [0.0, 1.0, 0.0])
        self.assertEqual(ir["energy_terms"], [{"kind": "exchange"}])

    def test_flat_api_object_region_lowers_to_ir(self) -> None:
        fm.reset()
        fm.engine("fem")
        layer = fm.geometry(
            fm.Box(size=(200e-9, 80e-9, 4e-9), name="track"),
            name="track",
        )
        layer.Ms = 800e3
        layer.Aex = 13e-12
        layer.alpha = 0.01
        core = layer.add_region(
            "skyrmion_core",
            fm.Cylinder(radius=30e-9, height=4e-9),
            priority=10,
        )
        core.material.Ms = fm.fields.constant(750e3, unit="A/m")
        core.mesh(
            maximum_element_size=1e-9,
            minimum_element_size=1e-9,
            transition_distance=60e-9,
            order=1,
        )
        layer.set_material_field(
            "Ms",
            fm.fields.linear(
                base=800e3,
                gradient=(0.0, 1.0e11, 0.0),
                unit="A/m",
            ),
            assignment_id="track_ms_gradient",
        )
        fm.exchange()
        fm.solver(integrator="rk23")
        fm.run(1e-12)

        ir = flat_world._build_problem().to_ir(include_geometry_assets=False)

        self.assertEqual(len(ir["object_regions"]), 1)
        region_ir = ir["object_regions"][0]
        self.assertEqual(region_ir["region_id"], "track:r1")
        self.assertEqual(region_ir["owner_object"], "track")
        self.assertEqual(region_ir["shape"]["kind"], "cylinder")
        self.assertEqual(region_ir["shape"]["radius"], 30e-9)
        self.assertEqual(region_ir["mesh_policy"]["maximum_element_size"], 1e-9)
        self.assertEqual(region_ir["material_overrides"][0]["parameter"], "ms")
        self.assertEqual(
            region_ir["material_overrides"][0]["value"],
            {"kind": "constant", "value": 750e3, "unit": "A/m"},
        )
        self.assertEqual(len(ir["material_parameter_fields"]), 1)
        assignment_ir = ir["material_parameter_fields"][0]
        self.assertEqual(assignment_ir["assignment_id"], "track_ms_gradient")
        self.assertEqual(assignment_ir["owner_object"], "track")
        self.assertEqual(assignment_ir["parameter"], "ms")
        self.assertEqual(assignment_ir["value"]["kind"], "linear")
        self.assertEqual(assignment_ir["value"]["frame"], "object")

    def test_permalloy_difference_hole_region_lowers_to_ir(self) -> None:
        fm.reset()
        fm.engine("fem")
        hole_radius = 50e-9
        hole_height = 30e-9
        layer = fm.geometry(
            fm.Box(300e-9, 1000e-9, hole_height)
            - fm.Cylinder(radius=hole_radius, height=hole_height),
            name="permalloy_box",
        )
        layer.Ms = 800e3
        layer.Aex = 13e-12
        layer.alpha = 0.5
        layer.mesh(minimum_element_size=10e-9, maximum_element_size=50e-9, order=1)
        hole_refinement = layer.add_region(
            "hole_refinement",
            fm.Cylinder(radius=hole_radius + 30e-9, height=hole_height),
            priority=10,
        )
        hole_refinement.mesh(
            minimum_element_size=2e-9,
            maximum_element_size=5e-9,
            transition_distance=30e-9,
            order=1,
        )
        fm.demag(realization="poisson_robin")

        ir = flat_world._build_problem().to_ir(include_geometry_assets=False)

        geometry = ir["geometry"]["entries"][0]
        self.assertEqual(geometry["kind"], "difference")
        self.assertEqual(geometry["base"]["kind"], "box")
        self.assertEqual(geometry["tool"]["kind"], "cylinder")
        self.assertEqual(geometry["tool"]["radius"], hole_radius)
        self.assertEqual(len(ir["object_regions"]), 1)
        region_ir = ir["object_regions"][0]
        self.assertEqual(region_ir["owner_object"], "permalloy_box")
        self.assertEqual(region_ir["name"], "hole_refinement")
        self.assertEqual(region_ir["shape"]["kind"], "cylinder")
        self.assertEqual(region_ir["shape"]["radius"], hole_radius + 30e-9)
        self.assertEqual(region_ir["mesh_policy"]["minimum_element_size"], 2e-9)
        self.assertEqual(region_ir["mesh_policy"]["maximum_element_size"], 5e-9)
        self.assertEqual(region_ir["mesh_policy"]["transition_distance"], 30e-9)

    def test_object_region_mesh_rejects_minimum_larger_than_maximum(self) -> None:
        fm.reset()
        fm.engine("fem")
        layer = fm.geometry(
            fm.Box(100e-9, 100e-9, 10e-9),
            name="film",
        )
        region = layer.add_region(
            "hole_transition_refinement",
            fm.Cylinder(radius=40e-9, height=10e-9),
        )

        with self.assertRaisesRegex(
            ValueError,
            "film:hole_transition_refinement.mesh: minimum_element_size must be <= maximum_element_size",
        ):
            region.mesh(
                minimum_element_size=0.15e-9,
                maximum_element_size=0.11e-9,
            )

    def test_problem_asset_build_receives_owner_geometry_for_object_regions(self) -> None:
        fm.reset()
        fm.engine("fem")
        layer = fm.geometry(
            fm.Box(size=(200e-9, 80e-9, 4e-9), name="track_geometry"),
            name="track",
        )
        layer.Ms = 800e3
        layer.Aex = 13e-12
        layer.alpha = 0.01
        layer.add_region(
            "core",
            fm.Cylinder(radius=30e-9, height=4e-9),
            region_id="track:core",
            realization_policy="conformal",
        )
        fm.exchange()

        with patch(
            "fullmag.model.problem.build_geometry_assets_for_request",
            return_value=None,
        ) as build_assets:
            flat_world._build_problem().to_ir(include_geometry_assets=True)

        object_regions = build_assets.call_args.kwargs["object_regions"]
        self.assertEqual(len(object_regions), 1)
        self.assertEqual(object_regions[0]["region_id"], "track:core")
        self.assertEqual(object_regions[0]["owner_object"], "track")
        self.assertEqual(
            object_regions[0]["owner_geometry_name"],
            "track_geom",
        )

    def test_problem_asset_build_receives_direct_object_mesh_recipe(self) -> None:
        problem = self._build_problem()
        recipe = PerObjectMeshRecipe(
            maximum_element_size=4e-9,
        )
        problem = replace(problem, magnets=[replace(problem.magnets[0], mesh=recipe)])

        with patch(
            "fullmag.model.problem.build_geometry_assets_for_request",
            return_value=None,
        ) as build_assets:
            problem.to_ir(include_geometry_assets=True)

        self.assertEqual(
            build_assets.call_args.kwargs["per_object_recipes"],
            {"track": recipe},
        )

    def test_object_region_rejects_zero_ms_override(self) -> None:
        fm.reset()
        layer = fm.geometry(fm.Box(size=(20e-9, 20e-9, 2e-9)), name="film")
        region = layer.add_region("void_like", fm.Box(size=(5e-9, 5e-9, 2e-9)))

        with self.assertRaisesRegex(ValueError, "Ms must be > 0"):
            region.material.Ms = 0.0

    def test_object_region_rejects_sampled_texture_override(self) -> None:
        fm.reset()
        layer = fm.geometry(fm.Box(size=(20e-9, 20e-9, 2e-9)), name="film")
        region = layer.add_region("core", fm.Box(size=(5e-9, 5e-9, 2e-9)))

        with self.assertRaisesRegex(ValueError, "sampled_field initial magnetization"):
            region.texture = fm.init.SampledMagnetization([(1.0, 0.0, 0.0)])

    def test_region_registries_are_owner_scoped_and_study_read_only(self) -> None:
        fm.reset()
        study = fm.study("region_registry")
        film = study.geometry(fm.Box(size=(100e-9, 50e-9, 2e-9)), name="film")
        film.Ms = 800e3
        film.Aex = 13e-12
        core = film.add_region("core", fm.Cylinder(radius=15e-9, height=2e-9))
        shell = film.add_region("shell", fm.Box(size=(60e-9, 40e-9, 2e-9)))

        self.assertIs(film.regions["core"], core)
        self.assertIs(film.regions[0], core)
        self.assertEqual(film.regions.keys(), ("core", "shell"))
        self.assertIs(study.regions["film/core"], core)
        self.assertIs(study.regions[1], shell)
        self.assertEqual(study.regions.keys(), ("film/core", "film/shell"))
        with self.assertRaisesRegex(TypeError, "read-only"):
            study.regions["film/core"] = shell

        film.rename_region("core", "center")
        self.assertEqual(core.name, "center")
        self.assertEqual(core.region_id, "film:r1")
        self.assertIs(film.regions["center"], core)
        self.assertNotIn("core", film.regions)
        self.assertEqual(study.regions.keys(), ("film/center", "film/shell"))

        film.reorder_region("shell", 0)
        self.assertIs(film.regions[0], shell)
        self.assertIs(film.regions[1], core)

    def test_region_registry_allocates_stable_non_reused_ids(self) -> None:
        fm.reset()
        study = fm.study("region_registry_ids")
        film = study.geometry(fm.Box(size=(100e-9, 50e-9, 2e-9)), name="film")

        first = film.add_region("core", fm.Cylinder(radius=15e-9, height=2e-9))
        self.assertEqual(first.region_id, "film:r1")

        film.remove_region(first)
        second = film.add_region("core", fm.Cylinder(radius=20e-9, height=2e-9))

        self.assertEqual(second.name, "core")
        self.assertNotEqual(second.region_id, first.region_id)
        self.assertEqual(second.region_id, "film:r2")
        self.assertIs(study.regions["film/core"], second)
        self.assertIs(study.regions["film/r2"], second)
        self.assertIs(study.regions["film:r2"], second)

    def test_region_registry_round_trip_preserves_deleted_allocated_ids(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            script_path = Path(tmp_dir) / "region_registry_deleted_ids.py"
            script_path.write_text(
                textwrap.dedent(
                    """
                    import fullmag as fm

                    study = fm.study("region_registry_deleted_ids")
                    film = study.geometry(fm.Box(size=(100e-9, 50e-9, 2e-9)), name="film")
                    film.Ms = 800e3
                    film.Aex = 13e-12
                    first = film.add_region("core", fm.Cylinder(radius=15e-9, height=2e-9))
                    film.remove_region(first)
                    film.add_region("core", fm.Cylinder(radius=20e-9, height=2e-9))
                    study.exchange()
                    """
                ).strip()
                + "\n",
                encoding="utf-8",
            )

            loaded = load_problem_from_script(script_path, lightweight_assets=True)
            draft = export_builder_draft(loaded)
            exported = rewrite_loaded_problem_script(loaded)["rendered_source"]
            exported_path = Path(tmp_dir) / "region_registry_deleted_ids_exported.py"
            exported_path.write_text(exported, encoding="utf-8")
            reloaded = load_problem_from_script(exported_path, lightweight_assets=True)
            reloaded_draft = export_builder_draft(reloaded)

        self.assertEqual(
            draft["geometries"][0]["allocated_region_ids"],
            ["film:r1", "film:r2"],
        )
        self.assertEqual(
            draft["geometries"][0]["object_regions"][0]["region_id"],
            "film:r2",
        )
        self.assertIn('film.regions.reserve_id("film:r1")', exported)
        self.assertEqual(
            reloaded_draft["geometries"][0]["allocated_region_ids"],
            draft["geometries"][0]["allocated_region_ids"],
        )
        self.assertEqual(
            reloaded_draft["geometries"][0]["object_regions"],
            draft["geometries"][0]["object_regions"],
        )

    def test_shapes_namespace_authors_geometry_and_centered_region_shapes(self) -> None:
        fm.reset()
        study = fm.study("region_shapes_namespace")
        film = study.geometry(
            fm.shapes.box(
                size=(100e-9, 50e-9, 2e-9),
                center=(10e-9, 0.0, 0.0),
                name="film",
            ),
            name="film",
        )
        film.Ms = 800e3
        film.Aex = 13e-12
        region = film.add_region(
            "core",
            fm.shapes.cylinder(
                radius=15e-9,
                height=2e-9,
                center=(5e-9, -2e-9, 0.0),
            ),
        )

        ir = flat_world._build_problem().to_ir(include_geometry_assets=False)

        self.assertEqual(ir["geometry"]["entries"][0]["kind"], "translate")
        self.assertEqual(region.region_id, "film:r1")
        self.assertEqual(
            ir["object_regions"][0]["shape"],
            {
                "axis": [0.0, 0.0, 1.0],
                "center": [5e-9, -2e-9, 0.0],
                "height": 2e-9,
                "kind": "cylinder",
                "radius": 15e-9,
            },
        )

    def test_cylinder_axis_and_in_plane_anisotropy_survive_problem_ir(self) -> None:
        fm.reset()
        study = fm.study("axis_cylinder")
        ring = study.geometry(
            fm.Cylinder(radius=150e-9, height=1e-9, axis=(1.0, 0.0, 0.0)),
            name="cofeb_ring",
        )
        ring.Ms = 1.1e6
        ring.Aex = 15e-12
        ring.Ku1 = 1.0e6
        ring.anisU = (1.0, 0.0, 0.0)

        ir = flat_world._build_problem().to_ir(include_geometry_assets=False)

        self.assertEqual(ir["geometry"]["entries"][0]["axis"], [1.0, 0.0, 0.0])
        self.assertEqual(ir["materials"][0]["anisotropy_axis"], [1.0, 0.0, 0.0])
        self.assertEqual(ir["materials"][0]["uniaxial_anisotropy"], 1.0e6)

    def test_region_shape_translation_adds_to_existing_center(self) -> None:
        fm.reset()
        study = fm.study("region_shape_translate_center")
        film = study.geometry(fm.Box(size=(100e-9, 50e-9, 2e-9)), name="film")
        film.Ms = 800e3
        film.Aex = 13e-12
        film.add_region(
            "core",
            fm.shapes.box(
                size=(20e-9, 10e-9, 2e-9),
                center=(5e-9, 1e-9, 0.0),
            ).translate((2e-9, -3e-9, 0.0)),
        )

        ir = flat_world._build_problem().to_ir(include_geometry_assets=False)

        shape = ir["object_regions"][0]["shape"]
        self.assertEqual(shape["kind"], "box")
        self.assertEqual(shape["size"], [20e-9, 10e-9, 2e-9])
        for actual, expected in zip(shape["center"], [7e-9, -2e-9, 0.0], strict=True):
            self.assertAlmostEqual(actual, expected)

    def test_script_export_writes_default_region_ids_explicitly(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            script_path = Path(tmp_dir) / "region_registry_export.py"
            script_path.write_text(
                textwrap.dedent(
                    """
                    import fullmag as fm

                    study = fm.study("region_registry_export")
                    study.engine("fem")
                    film = study.geometry(
                        fm.Box(size=(100e-9, 50e-9, 2e-9), name="film"),
                        name="film",
                    )
                    film.Ms = 800e3
                    film.Aex = 13e-12
                    film.add_region("core", fm.Cylinder(radius=15e-9, height=2e-9))
                    study.exchange()
                    """
                ).strip()
                + "\n",
                encoding="utf-8",
            )
            loaded = load_problem_from_script(script_path, lightweight_assets=True)
            exported = rewrite_loaded_problem_script(loaded)["rendered_source"]

        self.assertIn('region_id="film:r1"', exported)

    def test_remove_region_drops_material_fields_and_region_couplings(self) -> None:
        fm.reset()
        study = fm.study("region_remove")
        film = study.geometry(fm.Box(size=(100e-9, 50e-9, 2e-9)), name="film")
        film.Ms = 800e3
        film.Aex = 13e-12
        core = film.add_region("core", fm.Cylinder(radius=15e-9, height=2e-9))
        shell = film.add_region("shell", fm.Box(size=(60e-9, 40e-9, 2e-9)))
        film.set_material_field(
            "Ms",
            fm.fields.linear(base=800e3, gradient=(0.0, 1.0e11, 0.0)),
            assignment_id="core_ms",
            region="core",
        )
        study.couplings.exchange(core, shell, coupling_id="core_shell_exchange")
        study.exchange()

        before = flat_world._build_problem().to_ir(include_geometry_assets=False)
        self.assertEqual(len(before["material_parameter_fields"]), 1)
        self.assertEqual(len(before["couplings"]), 1)

        removed = film.remove_region("core")
        self.assertIs(removed, core)
        self.assertEqual(film.regions.keys(), ("shell",))
        after = flat_world._build_problem().to_ir(include_geometry_assets=False)
        self.assertEqual(after["material_parameter_fields"], [])
        self.assertEqual(after["couplings"], [])

        with self.assertRaisesRegex(RuntimeError, "not attached"):
            removed.delete()

    def test_class_api_exchange_coupling_lowers_to_ir(self) -> None:
        material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.01)
        track = fm.Ferromagnet(
            name="track",
            geometry=fm.Box(size=(100e-9, 20e-9, 2e-9), name="track"),
            material=material,
        )
        reference = fm.Ferromagnet(
            name="reference",
            geometry=fm.Box(size=(100e-9, 20e-9, 2e-9), name="reference"),
            material=material,
        )
        registry = fm.CouplingRegistry()
        coupling = registry.exchange(
            "track",
            "reference",
            mode="harmonic_mean",
            scale=0.5,
            coupling_id="track_reference_exchange",
        )
        problem = fm.Problem(
            name="exchange_pair",
            magnets=[track, reference],
            energy=[fm.Exchange()],
            study=fm.TimeEvolution(
                dynamics=fm.LLG(),
                outputs=[fm.SaveField("m", every=1e-12)],
            ),
            couplings=[coupling],
        )

        ir = problem.to_ir(include_geometry_assets=False)

        self.assertEqual(len(ir["couplings"]), 1)
        coupling_ir = ir["couplings"][0]
        self.assertEqual(coupling_ir["coupling_id"], "track_reference_exchange")
        self.assertEqual(coupling_ir["kind"], "exchange")
        self.assertEqual(coupling_ir["source"], {"kind": "object", "object": "track"})
        self.assertEqual(coupling_ir["target"], {"kind": "object", "object": "reference"})
        self.assertEqual(coupling_ir["parameters"]["mode"], "harmonic_mean")
        self.assertEqual(coupling_ir["parameters"]["scale"], 0.5)

    def test_flat_api_surface_rkky_coupling_lowers_to_ir(self) -> None:
        fm.reset()
        study = fm.study("rkky_stack")
        layer_a = study.geometry(
            fm.Box(size=(100e-9, 100e-9, 2e-9), name="layer_a"),
            name="layer_a",
        )
        layer_b = study.geometry(
            fm.Box(size=(100e-9, 100e-9, 2e-9), name="layer_b"),
            name="layer_b",
        )
        for layer in (layer_a, layer_b):
            layer.Ms = 800e3
            layer.Aex = 13e-12
        study.couplings.rkky(
            layer_a.surface("top"),
            layer_b.surface("bottom"),
            J1=-0.3e-3,
            coupling_id="layer_a_layer_b_rkky",
        )
        study.exchange()
        study.solver(integrator="rk23")
        fm.run(1e-12)

        ir = flat_world._build_problem().to_ir(include_geometry_assets=False)

        self.assertEqual(len(ir["couplings"]), 1)
        coupling_ir = ir["couplings"][0]
        self.assertEqual(coupling_ir["kind"], "rkky")
        self.assertEqual(
            coupling_ir["source"],
            {"kind": "surface", "object": "layer_a", "selector": "top"},
        )
        self.assertEqual(
            coupling_ir["target"],
            {"kind": "surface", "object": "layer_b", "selector": "bottom"},
        )
        self.assertEqual(coupling_ir["parameters"], {"kind": "rkky", "j1": -0.3e-3})

    def test_rkky_requires_surface_endpoints_in_python(self) -> None:
        registry = fm.CouplingRegistry()

        with self.assertRaisesRegex(ValueError, "endpoints must be surfaces"):
            registry.rkky("layer_a", "layer_b", J1=-0.3e-3)

    def test_interlayer_exchange_lowers_to_ir(self) -> None:
        registry = fm.CouplingRegistry()

        coupling = registry.interlayer_exchange(
            fm.couplings.surface("layer_a", "top"),
            fm.couplings.surface("layer_b", "bottom"),
            J1=1.0e-3,
            J2=-1.0e-5,
        )

        self.assertEqual(
            coupling.to_ir()["parameters"],
            {"kind": "interlayer_exchange", "j1": 1.0e-3, "j2": -1.0e-5},
        )

    def test_public_couplings_namespace_builds_surface_endpoint(self) -> None:
        self.assertEqual(
            fm.couplings.surface("layer", "top").to_ir(),
            {"kind": "surface", "object": "layer", "selector": "top"},
        )

    def test_script_builder_round_trips_region_owned_authoring(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            script_path = Path(tmp_dir) / "region_owned.py"
            script_path.write_text(
                textwrap.dedent(
                    """
                    import fullmag as fm

                    study = fm.study("region_owned")
                    study.engine("fem")

                    film = study.geometry(
                        fm.Box(size=(100e-9, 50e-9, 2e-9), name="film"),
                        name="film",
                    )
                    film.Ms = 800e3
                    film.Aex = 13e-12
                    film.alpha = 0.1
                    core = film.add_region(
                        "core",
                        fm.Cylinder(radius=15e-9, height=2e-9),
                        region_id="film:core_region",
                        priority=7,
                        realization_policy="conformal",
                    )
                    core.material.Ms = fm.fields.constant(760e3, unit="A/m")
                    core.mesh(
                        maximum_element_size=1e-9,
                        minimum_element_size=1e-9,
                        transition_distance=40e-9,
                        order=1,
                    )
                    core.texture = fm.texture.neel_skyrmion(
                        radius=20e-9,
                        wall_width=4e-9,
                        chirality=1,
                        core_polarity=-1,
                    )
                    film.set_material_field(
                        "Ms",
                        fm.fields.linear(
                            base=800e3,
                            gradient=(0.0, 1.0e11, 0.0),
                            unit="A/m",
                        ),
                        assignment_id="film_ms_gradient",
                        region=core,
                        priority=3,
                    )

                    reference = study.geometry(
                        fm.Box(size=(100e-9, 50e-9, 2e-9), name="reference"),
                        name="reference",
                    )
                    reference.Ms = 780e3
                    reference.Aex = 12e-12
                    reference.alpha = 0.1

                    study.couplings.rkky(
                        film.surface("top"),
                        reference.surface("bottom"),
                        J1=-0.3e-3,
                        coupling_id="film_reference_rkky",
                    )
                    study.exchange()
                    """
                ).strip()
                + "\n",
                encoding="utf-8",
            )

            loaded = load_problem_from_script(script_path, lightweight_assets=True)
            draft = export_builder_draft(loaded)
            scene = build_scene_document_from_builder(draft)
            rebuilt_draft = build_builder_from_scene_document(scene)
            exported = rewrite_loaded_problem_script(loaded)["rendered_source"]
            exported_path = Path(tmp_dir) / "region_owned_exported.py"
            exported_path.write_text(exported, encoding="utf-8")
            reloaded = load_problem_from_script(exported_path, lightweight_assets=True)

        self.assertEqual(
            rebuilt_draft["geometries"][0]["object_regions"],
            draft["geometries"][0]["object_regions"],
        )
        self.assertEqual(
            rebuilt_draft["geometries"][0]["allocated_region_ids"],
            draft["geometries"][0]["allocated_region_ids"],
        )
        self.assertEqual(
            rebuilt_draft["geometries"][0]["material_parameter_fields"],
            draft["geometries"][0]["material_parameter_fields"],
        )
        self.assertEqual(rebuilt_draft["couplings"], draft["couplings"])
        self.assertEqual(
            scene["objects"][0]["regions"],
            draft["geometries"][0]["object_regions"],
        )
        self.assertEqual(scene["version"], "scene.v2")
        self.assertEqual(
            scene["objects"][0]["allocated_region_ids"],
            draft["geometries"][0]["allocated_region_ids"],
        )
        self.assertEqual(scene["couplings"], draft["couplings"])

        self.assertIn('study = fm.study("region_owned")', exported)
        self.assertIn("film_core_region = film.add_region", exported)
        self.assertIn('region_id="film:core_region"', exported)
        self.assertIn('fm.fields.constant(760000, unit="A/m")', exported)
        self.assertIn("film_core_region.texture = fm.texture.neel_skyrmion", exported)
        self.assertIn("film.set_material_field", exported)
        self.assertIn("study.couplings.rkky", exported)
        self.assertIn('film.surface("top")', exported)

        original_ir = loaded.problem.to_ir(include_geometry_assets=False)
        reloaded_ir = reloaded.problem.to_ir(include_geometry_assets=False)
        texture_override = original_ir["object_regions"][0]["texture_override"]
        self.assertEqual(
            texture_override["initial_magnetization"]["kind"],
            "preset_texture",
        )
        self.assertEqual(
            texture_override["initial_magnetization"]["preset_kind"],
            "neel_skyrmion",
        )
        self.assertEqual(reloaded_ir["object_regions"], original_ir["object_regions"])
        self.assertEqual(
            reloaded_ir["material_parameter_fields"],
            original_ir["material_parameter_fields"],
        )
        self.assertEqual(reloaded_ir["couplings"], original_ir["couplings"])

    def test_script_builder_rewrites_region_coupling_endpoints_to_region_variables(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            script_path = Path(tmp_dir) / "region_coupling.py"
            script_path.write_text(
                textwrap.dedent(
                    """
                    import fullmag as fm

                    study = fm.study("region_coupling")
                    film = study.geometry(
                        fm.Box(size=(100e-9, 50e-9, 2e-9), name="film"),
                        name="film",
                    )
                    film.Ms = 800e3
                    film.Aex = 13e-12
                    core = film.add_region("core", fm.Cylinder(radius=15e-9, height=2e-9))
                    shell = film.add_region("shell", fm.Box(size=(80e-9, 40e-9, 2e-9)))
                    study.couplings.exchange(
                        core,
                        shell,
                        mode="explicit",
                        inter_exchange=6.5e-12,
                        coupling_id="core_shell_exchange",
                    )
                    study.exchange()
                    """
                ).strip()
                + "\n",
                encoding="utf-8",
            )

            loaded = load_problem_from_script(script_path, lightweight_assets=True)
            exported = rewrite_loaded_problem_script(loaded)["rendered_source"]

        self.assertIn(
            "study.couplings.exchange(film_core_region, film_shell_region",
            exported,
        )
        self.assertNotIn("fm.couplings.region", exported)

    def test_demag_fredkin_koehler_lowers_to_ir(self) -> None:
        self.assertEqual(
            fm.Demag(model="fredkin_koehler").to_ir(),
            {"kind": "demag", "realization": "fredkin_koehler"},
        )

    def test_demag_fredkin_koehler_realization_round_trip_lowers_to_ir(self) -> None:
        self.assertEqual(
            fm.Demag(realization="fredkin_koehler").to_ir(),
            {"kind": "demag", "realization": "fredkin_koehler"},
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

    def test_problem_to_ir_rejects_periodic_airbox_demag_for_fdm(self) -> None:
        problem = replace(
            self._build_problem(),
            pbc=fm.FdmPbc(
                axes=(True, False, False),
                demag="periodic_airbox_k0",
            ),
        )

        with self.assertRaisesRegex(ValueError, "periodic_airbox_k0.*FEM"):
            problem.to_ir(requested_backend=fm.BackendTarget.FDM)

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
            self.assertEqual(
                flat_world._state._default_mesh_spec.periodic_pair_ids,
                ["x_faces", "y_faces"],
            )
        finally:
            fm.reset()

    def test_flat_pbc_configures_fem_periodic_airbox_demag(self) -> None:
        fm.reset()
        try:
            fm.pbc(x=True, y=True, demag="periodic_airbox_k0")

            self.assertEqual(
                flat_world._state._pbc.to_ir(),
                {
                    "axes": ["periodic", "periodic", "open"],
                    "demag": "periodic_airbox_k0",
                },
            )
            self.assertEqual(
                flat_world._state._default_mesh_spec.periodic_pair_ids,
                ["x_faces", "y_faces"],
            )
        finally:
            fm.reset()

    def test_study_pbc_serializes_problem_ir_and_default_fem_pairs(self) -> None:
        fm.reset()
        try:
            study = fm.study("pbc_test")
            study.engine("fem")
            study.pbc(x=True, y=True)
            film = study.geometry(fm.Box(size=(20e-9, 20e-9, 5e-9), name="film"), name="film")
            film.Ms = 800e3
            film.Aex = 13e-12
            film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))

            self.assertEqual(
                flat_world._state._pbc.to_ir(),
                {
                    "axes": ["periodic", "periodic", "open"],
                    "demag": "open",
                },
            )
            self.assertEqual(
                flat_world._state._default_mesh_spec.periodic_pair_ids,
                ["x_faces", "y_faces"],
            )
            self.assertEqual(
                flat_world._build_problem().to_ir(include_geometry_assets=False)["pbc"],
                {
                    "axes": ["periodic", "periodic", "open"],
                    "demag": "open",
                },
            )
        finally:
            fm.reset()

    def test_study_pbc_serializes_z_axis_and_default_fem_pair(self) -> None:
        fm.reset()
        try:
            study = fm.study("pbc_z_test")
            study.engine("fem")
            study.pbc(z=True)
            film = study.geometry(fm.Box(size=(20e-9, 20e-9, 5e-9), name="film"), name="film")
            film.Ms = 800e3
            film.Aex = 13e-12
            film.m = fm.init.UniformMagnetization((0.0, 0.0, 1.0))

            self.assertEqual(
                flat_world._state._pbc.to_ir(),
                {
                    "axes": ["open", "open", "periodic"],
                    "demag": "open",
                },
            )
            self.assertEqual(
                flat_world._state._default_mesh_spec.periodic_pair_ids,
                ["z_faces"],
            )
            self.assertEqual(
                flat_world._build_problem().to_ir(include_geometry_assets=False)["pbc"],
                {
                    "axes": ["open", "open", "periodic"],
                    "demag": "open",
                },
            )
        finally:
            fm.reset()

    def test_canonical_script_round_trip_preserves_problem_pbc(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("canonical_pbc_round_trip")
        study.engine("fem")
        body = study.geometry(fm.Box(size=(20e-9, 20e-9, 5e-9), name="film"), name="film")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        study.pbc(x=True, y=True, demag="periodic_airbox_k0")
        study.relax(max_steps=2, dt=1e-15)
        """

        with TemporaryDirectory() as tmp_dir:
            source_path = Path(tmp_dir) / "canonical_pbc_source.py"
            source_path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(source_path, lightweight_assets=True)
            rendered = rewrite_loaded_problem_script(loaded)["rendered_source"]
            self.assertIn(
                'study.pbc(x=True, y=True, demag="periodic_airbox_k0")',
                rendered,
            )

            round_trip_path = Path(tmp_dir) / "canonical_pbc_round_trip.py"
            round_trip_path.write_text(rendered, encoding="utf-8")
            round_tripped = fm.load_problem_from_script(
                round_trip_path,
                lightweight_assets=True,
            )

        self.assertEqual(
            loaded.problem.to_ir(include_geometry_assets=False)["pbc"],
            round_tripped.problem.to_ir(include_geometry_assets=False)["pbc"],
        )

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

    def test_eigenmodes_rejects_frequency_response_outputs(self) -> None:
        with self.assertRaisesRegex(ValueError, "Eigenmodes outputs"):
            fm.Eigenmodes(outputs=[fm.SaveResponse("susceptibility_tensor")])

    def test_eigenmodes_serializes_frequency_window_target(self) -> None:
        problem = replace(
            self._build_problem(),
            energy=[fm.Exchange()],
            study=fm.Eigenmodes(
                outputs=[fm.SaveSpectrum()],
                count=20,
                target="frequency_window",
                frequency_min=100e6,
                frequency_max=5e9,
            ),
        )
        ir = problem.to_ir()

        self.assertEqual(
            ir["study"]["target"],
            {
                "kind": "frequency_window",
                "frequency_min_hz": 100e6,
                "frequency_max_hz": 5e9,
            },
        )

    def test_eigenmodes_rejects_invalid_frequency_window(self) -> None:
        with self.assertRaisesRegex(ValueError, "frequency_min must be less"):
            fm.Eigenmodes(
                outputs=[fm.SaveSpectrum()],
                target="frequency_window",
                frequency_min=5e9,
                frequency_max=100e6,
            )

    def test_frequency_response_lowers_to_first_class_study_ir(self) -> None:
        problem = replace(
            self._build_problem(),
            energy=[fm.Exchange()],
            study=fm.FrequencyResponse(
                outputs=[fm.SaveResponse("susceptibility_tensor")],
                frequencies_hz=[1.0e9, 2.0e9],
                excitation_field_au_per_m=(0.0, 0.0, 2.5),
                excitation_phase_rad=0.125,
                include_demag=False,
                magnetostatic_bc="periodic_airbox_k0",
                k_sampling=fm.KPoint("Gamma", (0.0, 0.0, 0.0)),
                damping_policy="include",
            ),
        )
        ir = problem.to_ir()

        self.assertEqual(ir["study"]["kind"], "frequency_response")
        self.assertEqual(ir["study"]["operator"], {
            "kind": "linearized_llg",
            "include_demag": False,
        })
        self.assertEqual(ir["study"]["equilibrium"], {"kind": "provided"})
        self.assertEqual(ir["study"]["magnetostatic_bc"], "periodic_airbox_k0")
        self.assertEqual(
            ir["study"]["k_sampling"],
            {
                "kind": "single",
                "k_vector": [0.0, 0.0, 0.0],
            },
        )
        self.assertEqual(
            ir["study"]["excitation"],
            {"field_au_per_m": [0.0, 0.0, 2.5], "phase_rad": 0.125},
        )
        self.assertEqual(
            ir["study"]["frequencies_hz"],
            {"values_hz": [1.0e9, 2.0e9]},
        )
        self.assertEqual(
            ir["study"]["sampling"]["outputs"],
            [
                {
                    "kind": "frequency_response_output",
                    "observable": "susceptibility_tensor",
                },
            ],
        )
        self.assertEqual(runtime_cli._resolve_until_seconds(problem.study, None), 0.0)

    def test_frequency_response_accepts_floquet_airbox_magnetostatic_bc(self) -> None:
        problem = replace(
            self._build_problem(),
            energy=[fm.Exchange(), fm.Demag(realization="poisson_robin")],
            study=fm.FrequencyResponse(
                outputs=[fm.SaveResponse("susceptibility_tensor")],
                frequencies_hz=[2.0e9],
                include_demag=True,
                spin_wave_bc=fm.FloquetBC(["x_faces"]),
                k_sampling=fm.KPoint("kx", (1.0e6, 0.0, 0.0)),
                magnetostatic_bc="floquet_airbox",
            ),
        )
        ir = problem.to_ir()

        self.assertEqual(
            ir["study"]["spin_wave_bc"],
            {
                "kind": "floquet",
                "pair_ids": ["x_faces"],
                "phase_convention": "exp_minus_i_k_dot_delta_r",
            },
        )
        self.assertEqual(ir["study"]["magnetostatic_bc"], "floquet_airbox")

    def test_static_periodic_frequency_response_smoke_example_loads_contract(self) -> None:
        example_path = (
            Path(__file__).resolve().parents[3]
            / "examples"
            / "fem_frequency_response_static_periodic_smoke.py"
        )

        loaded = fm.load_problem_from_script(example_path, lightweight_assets=True)

        self.assertEqual(len(loaded.stages), 0)
        self.assertIsNotNone(loaded.problem)
        problem = loaded.problem
        assert problem is not None
        study = problem.study.to_ir()
        self.assertEqual(study["kind"], "frequency_response")
        self.assertEqual(study["operator"]["include_demag"], False)
        self.assertEqual(study["spin_wave_bc"], {"kind": "periodic", "pair_ids": ["x_faces"]})

        mesh_source = problem.to_ir()["geometry_assets"]["fem_mesh_assets"][0]["mesh_source"]
        mesh_payload = json.loads(Path(mesh_source).read_text(encoding="utf-8"))
        self.assertEqual(mesh_payload["periodic_boundary_pairs"][0]["pair_id"], "x_faces")
        self.assertEqual(len(mesh_payload["periodic_node_pairs"]), 4)
        self.assertEqual(
            {pair["pair_id"] for pair in mesh_payload["periodic_node_pairs"]},
            {"x_faces"},
        )

    def test_in_plane_10mt_hole_fmr_frequency_response_smoke_example_loads_contract(self) -> None:
        example_path = (
            Path(__file__).resolve().parents[3]
            / "examples"
            / "fem_frequency_response_smoke.py"
        )

        loaded = fm.load_problem_from_script(example_path, lightweight_assets=True)

        self.assertEqual(len(loaded.stages), 2)
        relax = loaded.stages[0].problem.study.to_ir()
        self.assertEqual(relax["kind"], "relaxation")
        self.assertEqual(relax["stop"]["max_steps"], 200)
        self.assertEqual(relax["stop"]["torque_tolerance_apm"], 3e-3)

        problem = loaded.stages[1].problem
        study = problem.study.to_ir()
        self.assertEqual(study["kind"], "frequency_response")
        self.assertEqual(study["operator"]["include_demag"], True)
        self.assertEqual(study["magnetostatic_bc"], "periodic_airbox_k0")
        self.assertEqual(study["equilibrium"], {"kind": "relaxed_initial_state"})
        self.assertEqual(study["damping_policy"], "include")
        self.assertEqual(
            study["spin_wave_bc"],
            {"kind": "periodic", "pair_ids": ["x_faces", "y_faces"]},
        )
        self.assertEqual(
            study["frequencies_hz"],
            {
                "values_hz": [
                    1.0e9,
                    1.5e9,
                    2.0e9,
                    2.5e9,
                    3.0e9,
                    3.5e9,
                    4.0e9,
                    4.5e9,
                    5.0e9,
                    5.5e9,
                    6.0e9,
                ],
            },
        )
        problem_ir = problem.to_ir(requested_backend=fm.BackendTarget.FEM)
        self.assertEqual(
            problem_ir["pbc"],
            {
                "axes": ["periodic", "periodic", "open"],
                "demag": "periodic_airbox_k0",
            },
        )
        runtime_metadata = problem_ir["problem_meta"]["runtime_metadata"]
        self.assertEqual(runtime_metadata["study_universe"]["mode"], "manual")
        self.assertEqual(
            problem_ir["backend_policy"]["discretization_hints"]["fem"]["demag_solver_policy"],
            {
                "solver": "CG",
                "preconditioner": "AMG",
                "rtol": 0.0001,
                "max_iterations": 500,
                "print_level": 0,
            },
        )
        for actual, expected in zip(
            runtime_metadata["study_universe"]["size"],
            [200e-9, 200e-9, 90e-9],
            strict=True,
        ):
            self.assertAlmostEqual(actual, expected, delta=1e-18)
        self.assertEqual(runtime_metadata["mesh_workflow"]["build_target"], "domain")
        self.assertEqual(
            runtime_metadata["mesh_workflow"]["domain_mesh_mode"],
            "generated_shared_domain_mesh",
        )
        self.assertIn(
            {"kind": "demag", "realization": "poisson_robin"},
            problem_ir["energy_terms"],
        )
        self.assertIn(
            {"kind": "exchange"},
            problem_ir["energy_terms"],
        )

        mesh_workflow = runtime_metadata["mesh_workflow"]
        default_mesh = mesh_workflow["default_mesh"]
        self.assertEqual(default_mesh["algorithm_2d"], 6)
        self.assertEqual(default_mesh["algorithm_3d"], 1)
        self.assertEqual(default_mesh["smoothing_steps"], 4)
        self.assertEqual(default_mesh["optimize_iterations"], 3)
        self.assertEqual(default_mesh["size_from_curvature"], 24)
        self.assertEqual(default_mesh["narrow_regions"], 3)
        film_mesh = mesh_workflow["per_geometry"][0]
        self.assertEqual(film_mesh["mesh_strategy"], "thin_film_tetrahedral")
        self.assertEqual(film_mesh["through_thickness_elements"], 2)
        self.assertLessEqual(film_mesh["maximum_element_size"], 8e-9 + 1e-18)
        self.assertLessEqual(film_mesh["minimum_element_size"], 3e-9 + 1e-18)
        self.assertLessEqual(film_mesh["interface_hmax"], 5e-9 + 1e-18)
        self.assertLessEqual(film_mesh["edge_hmax"], 4e-9 + 1e-18)
        self.assertLessEqual(film_mesh["corner_hmax"], 4e-9 + 1e-18)
        zeeman_terms = [
            term for term in problem_ir["energy_terms"] if term["kind"] == "zeeman"
        ]
        self.assertEqual(zeeman_terms, [{"kind": "zeeman", "B": [0.01, 0.0, 0.0]}])
        geometry = problem_ir["geometry"]["entries"][0]
        self.assertEqual(geometry["kind"], "difference")
        self.assertEqual(len(geometry["base"]["size"]), 3)
        for actual, expected in zip(
            geometry["base"]["size"],
            [200e-9, 200e-9, 10e-9],
            strict=True,
        ):
            self.assertAlmostEqual(actual, expected, delta=1e-18)
        self.assertAlmostEqual(geometry["tool"]["radius"], 25e-9, delta=1e-18)
        self.assertAlmostEqual(geometry["tool"]["height"], 10e-9, delta=1e-18)
        object_regions = problem_ir.get("object_regions", [])
        self.assertEqual(len(object_regions), 2)
        object_regions_by_name = {region["name"]: region for region in object_regions}
        self.assertEqual(
            set(object_regions_by_name),
            {"hole_edge_refinement", "hole_transition_refinement"},
        )
        self.assertLessEqual(
            object_regions_by_name["hole_edge_refinement"]["mesh_policy"][
                "maximum_element_size"
            ],
            4e-9 + 1e-18,
        )
        self.assertLessEqual(
            object_regions_by_name["hole_transition_refinement"]["mesh_policy"][
                "maximum_element_size"
            ],
            6e-9 + 1e-18,
        )
        assets = problem_ir["geometry_assets"]
        domain_asset = assets.get("fem_domain_mesh_asset")
        self.assertIsInstance(domain_asset, dict)
        if isinstance(domain_asset.get("mesh"), dict):
            mesh_payload = domain_asset["mesh"]
        else:
            mesh_source = domain_asset["mesh_source"]
            mesh_payload = json.loads(Path(mesh_source).read_text(encoding="utf-8"))
        boundary_pairs = {
            pair["pair_id"]: pair
            for pair in mesh_payload.get("periodic_boundary_pairs", [])
        }
        self.assertEqual(set(boundary_pairs), {"x_faces", "y_faces"})
        for actual, expected in zip(
            boundary_pairs["x_faces"]["translation"],
            [200e-9, 0.0, 0.0],
            strict=True,
        ):
            self.assertAlmostEqual(actual, expected)
        for actual, expected in zip(
            boundary_pairs["y_faces"]["translation"],
            [0.0, 200e-9, 0.0],
            strict=True,
        ):
            self.assertAlmostEqual(actual, expected)
        node_pair_ids = {
            pair["pair_id"]
            for pair in mesh_payload.get("periodic_node_pairs", [])
        }
        self.assertEqual(node_pair_ids, {"x_faces", "y_faces"})

    def test_in_plane_10mt_hole_fmr_frequency_response_smoke_example_env_overrides(self) -> None:
        example_path = (
            Path(__file__).resolve().parents[3]
            / "examples"
            / "fem_frequency_response_smoke.py"
        )

        with patch.dict(
            os.environ,
            {
                "FULLMAG_FMR_RELAX_MAX_STEPS": "12",
                "FULLMAG_FMR_RELAX_TOL": "0.004",
                "FULLMAG_FMR_FREQUENCIES_GHZ": "2.75",
                "FULLMAG_FMR_RESPONSE_RTOL": "0.02",
                "FULLMAG_FMR_RESPONSE_MAX_ITERATIONS": "7",
                "FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS": "3",
            },
        ):
            loaded = fm.load_problem_from_script(example_path, lightweight_assets=True)
            self.assertEqual(os.environ["FULLMAG_FEM_FREQUENCY_RESPONSE_RTOL"], "0.02")
            self.assertEqual(os.environ["FULLMAG_FEM_FREQUENCY_RESPONSE_MAX_ITERATIONS"], "7")
            self.assertEqual(os.environ["FULLMAG_FEM_FREQUENCY_RESPONSE_RESTART_ITERATIONS"], "3")

        relax = loaded.stages[0].problem.study.to_ir()
        self.assertEqual(relax["stop"]["max_steps"], 12)
        self.assertEqual(relax["stop"]["torque_tolerance_apm"], 0.004)

        study = loaded.stages[1].problem.study.to_ir()
        self.assertEqual(study["frequencies_hz"], {"values_hz": [2.75e9]})

    def test_in_plane_10mt_hole_fmr_frequency_response_smoke_example_can_use_frozen_submesh(
        self,
    ) -> None:
        example_path = (
            Path(__file__).resolve().parents[3]
            / "examples"
            / "fem_frequency_response_smoke.py"
        )

        with patch.dict(
            os.environ,
            {
                "FULLMAG_FMR_FROZEN_MAGNETIC_SUBMESH_SOURCE": (
                    "mesh/periodic_antidot_frozen_magnetic_submesh.npz"
                ),
            },
        ):
            loaded = fm.load_problem_from_script(example_path, lightweight_assets=True)

        problem = loaded.stages[1].problem
        runtime_metadata = problem.runtime_metadata
        mesh_workflow = runtime_metadata["mesh_workflow"]
        self.assertEqual(mesh_workflow["domain_mesh_mode"], "generated_frozen_magnetic_submesh")
        self.assertEqual(
            mesh_workflow["frozen_magnetic_submesh_source"],
            {
                "mesh_source": "mesh/periodic_antidot_frozen_magnetic_submesh.npz",
                "region_markers": [{"geometry_name": "periodic_film", "marker": 1}],
            },
        )

    def test_in_plane_10mt_hole_fmr_frequency_response_smoke_example_fast_mesh_preset(
        self,
    ) -> None:
        example_path = (
            Path(__file__).resolve().parents[3]
            / "examples"
            / "fem_frequency_response_smoke.py"
        )

        with patch.dict(os.environ, {"FULLMAG_FMR_FAST_RUNTIME_MESH": "1"}):
            loaded = fm.load_problem_from_script(example_path, lightweight_assets=True)

        problem = loaded.stages[1].problem
        problem_ir = problem.to_ir(requested_backend=fm.BackendTarget.FEM)
        runtime_metadata = problem_ir["problem_meta"]["runtime_metadata"]
        mesh_workflow = runtime_metadata["mesh_workflow"]
        default_mesh = mesh_workflow["default_mesh"]
        film_mesh = mesh_workflow["per_geometry"][0]

        self.assertEqual(default_mesh["size_from_curvature"], 8)
        self.assertEqual(default_mesh["narrow_regions"], 1)
        self.assertEqual(film_mesh["through_thickness_elements"], 1)
        self.assertLessEqual(film_mesh["maximum_element_size"], 20e-9 + 1e-18)
        self.assertLessEqual(film_mesh["minimum_element_size"], 8e-9 + 1e-18)

    def test_free_demag_airbox_fmr_eigenmodes_smoke_example_loads_contract(self) -> None:
        example_path = (
            Path(__file__).resolve().parents[3]
            / "examples"
            / "fem_fmr_free_demag_airbox_smoke.py"
        )

        loaded = fm.load_problem_from_script(example_path, lightweight_assets=True)

        self.assertEqual(len(loaded.stages), 2)
        relax = loaded.stages[0].problem.study.to_ir()
        self.assertEqual(relax["kind"], "relaxation")
        self.assertEqual(relax["stop"]["max_steps"], 120)

        problem = loaded.stages[1].problem
        study = problem.study.to_ir()
        self.assertEqual(study["kind"], "eigenmodes")
        self.assertEqual(study["operator"]["include_demag"], True)
        self.assertIsNone(study["k_sampling"])
        self.assertEqual(study["spin_wave_bc"], "free")
        self.assertEqual(
            study["sampling"]["outputs"],
            [
                {"kind": "eigen_spectrum", "quantity": "eigenfrequency", "scope": "per_sample"},
                {"kind": "eigen_mode", "field": "mode", "indices": list(range(8))},
            ],
        )
        ir = loaded.to_ir(
            requested_backend="fem",
            execution_mode="strict",
            execution_precision="double",
            include_geometry_assets=False,
        )
        self.assertIn("demag", {term["kind"] for term in ir["energy_terms"]})
        mesh_workflow = ir["problem_meta"]["runtime_metadata"]["mesh_workflow"]
        self.assertEqual(mesh_workflow["build_target"], "domain")
        self.assertEqual(mesh_workflow["domain_mesh_mode"], "generated_shared_domain_mesh")
        nodes = ir["problem_meta"]["runtime_metadata"]["study_pipeline"]["nodes"]
        self.assertEqual([node["stage_kind"] for node in nodes], ["relax", "eigenmodes"])
        self.assertEqual(nodes[1]["payload"]["eigen_include_demag"], True)
        self.assertEqual(nodes[1]["payload"]["eigen_spin_wave_bc"], "free")

    def test_frequency_response_rejects_invalid_eigen_options(self) -> None:
        with self.assertRaisesRegex(ValueError, "operator"):
            fm.FrequencyResponse(
                outputs=[fm.SaveSpectrum()],
                frequencies_hz=[1.0e9],
                operator="unsupported",
            )
        with self.assertRaisesRegex(ValueError, "normalization"):
            fm.FrequencyResponse(
                outputs=[fm.SaveSpectrum()],
                frequencies_hz=[1.0e9],
                normalization="unsupported",
            )
        with self.assertRaisesRegex(ValueError, "excitation_field_au_per_m"):
            fm.FrequencyResponse(
                outputs=[fm.SaveSpectrum()],
                frequencies_hz=[1.0e9],
                excitation_field_au_per_m=(0.0, 1.0),
            )
        with self.assertRaisesRegex(ValueError, "excitation_phase_rad"):
            fm.FrequencyResponse(
                outputs=[fm.SaveSpectrum()],
                frequencies_hz=[1.0e9],
                excitation_phase_rad=float("nan"),
            )

    def test_interfacial_dmi_interface_normal_serializes_to_ir(self) -> None:
        term = fm.InterfacialDMI(D=3e-3, interface_normal=(0.0, 3.0, 4.0))
        self.assertEqual(
            term.to_ir(),
            {"kind": "interfacial_dmi", "D": 3e-3, "interface_normal": [0.0, 3.0, 4.0]},
        )

    def test_dmi_terms_preserve_signed_constants_in_ir(self) -> None:
        self.assertEqual(
            fm.InterfacialDMI(D=-3e-3).to_ir(),
            {"kind": "interfacial_dmi", "D": -3e-3},
        )
        self.assertEqual(
            fm.BulkDMI(D=-2e-3).to_ir(),
            {"kind": "bulk_dmi", "D": -2e-3},
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

    def test_runtime_selection_rejects_unimplemented_multi_gpu_request(self) -> None:
        with self.assertRaisesRegex(ValueError, "multi-GPU execution is not implemented"):
            fm.backend.cuda(2)

    def test_study_execution_mode_serializes_to_ir(self) -> None:
        fm.reset()
        study = fm.study("projection_mode")
        study.engine("fem").mode("extended")
        film = study.geometry(
            fm.Box(size=(20e-9, 20e-9, 2e-9), name="film"),
            name="film",
        )
        film.Ms = 800e3
        film.Aex = 13e-12

        ir = flat_world._build_problem().to_ir(include_geometry_assets=False)

        self.assertEqual(ir["validation_profile"]["execution_mode"], "extended")
        self.assertEqual(
            ir["problem_meta"]["runtime_metadata"]["runtime_selection"][
                "execution_mode"
            ],
            "extended",
        )

    def test_random_initializer_serializes_to_ir(self) -> None:
        initializer = fm.texture.random(seed=42)
        self.assertEqual(
            initializer.to_ir(),
            {
                "kind": "preset_texture",
                "preset_kind": "random",
                "preset_version": 2,
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

    def test_fullmag_import_does_not_require_h5py(self) -> None:
        script = textwrap.dedent(
            """
            import builtins

            real_import = builtins.__import__

            def guarded_import(name, *args, **kwargs):
                if name == "h5py" or name.startswith("h5py."):
                    raise ModuleNotFoundError("No module named 'h5py'")
                return real_import(name, *args, **kwargs)

            builtins.__import__ = guarded_import

            import fullmag as fm

            assert fm.Exchange is not None
            """
        )
        env = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src")}

        completed = subprocess.run(
            [sys.executable, "-c", script],
            check=False,
            capture_output=True,
            text=True,
            env=env,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)

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

    def test_field_state_roundtrip_across_h5_and_zarr(self) -> None:
        values = [[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]]

        with TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            zarr_path = tmp_path / "h_eff.zarr.zip"
            h5_path = tmp_path / "h_eff.h5"

            fm.save_field_state(
                zarr_path,
                values,
                quantity=fm.H_eff,
                target_kind="airbox",
                target_id="airbox",
                units="A/m",
            )
            fm.save_field_state(
                h5_path,
                values,
                quantity=fm.H_eff,
                target_kind="airbox",
                target_id="airbox",
                units="A/m",
            )

            for path in (zarr_path, h5_path):
                loaded = fm.load_field_state(path)
                self.assertEqual(loaded.quantity_id, "H_eff")
                self.assertEqual(loaded.target_kind, "airbox")
                self.assertEqual(loaded.target_id, "airbox")
                self.assertEqual(loaded.units, "A/m")
                self.assertEqual(loaded.values, [tuple(row) for row in values])

    def test_flat_target_load_and_save_field_state(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            m_path = tmp_path / "m_state.h5"
            copied_path = tmp_path / "m_state_copy.zarr.zip"

            fm.save_field_state(
                m_path,
                [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
                quantity=fm.m,
                target_kind="object",
                target_id="flower",
            )

            fm.reset()
            fm.engine("fdm")
            fm.cell(5e-9, 5e-9, 5e-9)
            flower = fm.geometry(fm.Box(size=(10e-9, 10e-9, 5e-9), name="flower"), name="flower")
            flower.Ms = 800e3
            flower.Aex = 13e-12
            loaded = flower.load(m_path, quantity=fm.m)

            problem = flat_world._build_problem()
            self.assertIsInstance(problem.magnets[0].m0, fm.init.SampledMagnetization)
            self.assertEqual(problem.magnets[0].m0.values, loaded.values)
            flower.save(copied_path, quantity=fm.m)
            copied = fm.load_field_state(copied_path)
            self.assertEqual(copied.target_kind, "object")
            self.assertEqual(copied.target_id, "flower")
            self.assertEqual(copied.quantity_id, "m")
            self.assertEqual(copied.values, loaded.values)

    def test_study_airbox_load_and_save_attached_field_state(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            source_path = tmp_path / "airbox_h_eff.h5"
            copy_path = tmp_path / "airbox_h_eff_copy.zarr.zip"
            values = [[10.0, 0.0, 0.0], [0.0, 20.0, 0.0]]

            fm.save_field_state(
                source_path,
                values,
                quantity=fm.H_eff,
                target_kind="airbox",
                target_id="airbox",
            )

            fm.reset()
            study = fm.study("airbox_state")
            loaded = study.airbox.load(source_path, quantity=fm.H_eff, mode="attach")
            self.assertEqual(loaded.quantity_id, "H_eff")
            self.assertEqual(loaded.target_kind, "airbox")

            study.airbox.save(copy_path, quantity=fm.H_eff)
            copied = fm.load_field_state(copy_path)
            self.assertEqual(copied.quantity_id, "H_eff")
            self.assertEqual(copied.target_kind, "airbox")
            self.assertEqual(copied.values, [tuple(row) for row in values])

    def test_field_state_cli_prints_normalized_json(self) -> None:
        from contextlib import redirect_stdout
        from io import StringIO

        from fullmag.init import field_state_cli

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "body_m.h5"
            fm.save_field_state(
                path,
                [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
                quantity=fm.m,
                target_kind="object",
                target_id="body",
            )

            stdout = StringIO()
            with redirect_stdout(stdout):
                exit_code = field_state_cli.main([str(path)])
            payload = json.loads(stdout.getvalue())

            self.assertEqual(exit_code, 0)
            self.assertEqual(payload["fullmag_kind"], "field_state")
            self.assertEqual(payload["schema_version"], 1)
            self.assertEqual(payload["quantity_id"], "m")
            self.assertEqual(payload["target"], {"kind": "object", "id": "body"})
            self.assertEqual(payload["component_count"], 3)
            self.assertEqual(payload["values"], [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])

    def test_field_state_cli_writes_h5_from_normalized_json(self) -> None:
        from fullmag.init import field_state_cli

        with TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            input_path = tmp_path / "field-state.json"
            output_path = tmp_path / "body_m.h5"
            input_path.write_text(
                json.dumps(
                    {
                        "fullmag_kind": "field_state",
                        "schema_version": 1,
                        "quantity_id": "m",
                        "target": {"kind": "object", "id": "body"},
                        "component_count": 3,
                        "values": [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
                    }
                ),
                encoding="utf-8",
            )

            exit_code = field_state_cli.main(
                ["write", str(output_path), "--input-json", str(input_path), "--format", "h5"]
            )
            loaded = fm.load_field_state(output_path)

            self.assertEqual(exit_code, 0)
            self.assertEqual(loaded.quantity_id, "m")
            self.assertEqual(loaded.target_kind, "object")
            self.assertEqual(loaded.target_id, "body")
            self.assertEqual(loaded.values, [(1.0, 0.0, 0.0), (0.0, 1.0, 0.0)])

    def test_zarr3_local_store_is_accepted_without_directory_store(self) -> None:
        from fullmag.init import state_io

        class LocalStore:
            def __init__(self, path: str, *, read_only: bool = False) -> None:
                self.path = path
                self.read_only = read_only

        class ZipStore:
            def __init__(self, path: str, *, mode: str | None = None) -> None:
                self.path = path
                self.mode = mode

        fake_zarr = types.ModuleType("zarr")
        fake_zarr.__version__ = "3.2.1"
        fake_storage = types.ModuleType("zarr.storage")
        fake_storage.LocalStore = LocalStore
        fake_storage.ZipStore = ZipStore

        with patch.dict(sys.modules, {"zarr": fake_zarr, "zarr.storage": fake_storage}):
            _, Store, ResolvedZipStore = state_io._require_zarr()
            directory_store = state_io._open_zarr_store(Path("state.zarr"), mode="w")
            zip_store = state_io._open_zarr_store(Path("state.zarr.zip"), mode="r")

        self.assertIs(Store, LocalStore)
        self.assertIs(ResolvedZipStore, ZipStore)
        self.assertIsInstance(directory_store, LocalStore)
        self.assertFalse(directory_store.read_only)
        self.assertIsInstance(zip_store, ZipStore)
        self.assertEqual(zip_store.mode, "r")

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

    def test_script_builder_rewrites_bulk_dmi(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            script_path = Path(tmp_dir) / "builder_bulk_dmi.py"
            script_path.write_text(
                textwrap.dedent(
                    """
                    import fullmag as fm

                    fm.engine("fem")
                    body = fm.geometry(fm.Box(size=(5e-9, 5e-9, 5e-9), name="body"), name="body")
                    body.Ms = 800e3
                    body.Aex = 13e-12
                    body.alpha = 0.2
                    body.Dbulk = -2e-3
                    body.m = fm.texture.uniform(1, 0, 0)
                    """
                ).strip()
                + "\n",
                encoding="utf-8",
            )

            loaded = load_problem_from_script(script_path, lightweight_assets=True)
            draft = export_builder_draft(loaded)
            material = draft["geometries"][0]["material"]
            self.assertEqual(material["Dbulk"], -2e-3)
            self.assertIn(
                {"kind": "bulk_dmi", "enabled": True, "params": {"dbulk": -2e-3}},
                draft["geometries"][0]["physics_stack"],
            )

            rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
            self.assertIn("body.Dbulk = -0.002", rewritten)

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
        with patch.dict(os.environ, {"FULLMAG_DEMAG_PRINT_LEVEL": "0"}):
            loaded = load_problem_from_script(example_path, lightweight_assets=True)

        self.assertEqual(loaded.entrypoint_kind, "flat_workspace")
        self.assertEqual(len(loaded.stages), 1)
        relax_ir = loaded.stages[0].problem.study.to_ir()
        self.assertEqual(relax_ir["kind"], "relaxation")
        self.assertEqual(relax_ir["dynamics"]["adaptive_timestep"]["dt_max"], 1e-14)
        self.assertAlmostEqual(
            relax_ir["stop"]["torque_tolerance_apm"],
            1e-4 / 1.2566e-6,
        )
        mesh_workflow = loaded.problem.runtime_metadata["mesh_workflow"]
        study_universe = loaded.problem.runtime_metadata["study_universe"]
        self.assertEqual(study_universe["airbox_hmax"], 500e-9)
        self.assertEqual(study_universe["airbox_hmin"], 20e-9)
        self.assertEqual(study_universe["airbox_growth_rate"], 1.5)
        self.assertEqual(mesh_workflow["fem"]["hmax"], 10e-9)
        mesh_options = mesh_workflow["mesh_options"]
        self.assertEqual(mesh_options["algorithm_2d"], 6)
        self.assertEqual(mesh_options["algorithm_3d"], 1)
        self.assertEqual(mesh_options["maximum_element_growth_rate"], 1.3)
        self.assertTrue(mesh_options["compute_quality"])
        per_geometry = mesh_workflow["per_geometry"]
        self.assertEqual(len(per_geometry), 1)
        arch_mesh = per_geometry[0]
        self.assertEqual(arch_mesh["geometry"], "arch_waveguide")
        self.assertEqual(arch_mesh["maximum_element_size"], 10e-9)
        self.assertEqual(arch_mesh["minimum_element_size"], 5e-9)
        self.assertEqual(arch_mesh["interface_hmax"], 10e-9)
        self.assertEqual(arch_mesh["interface_thickness"], 10e-9)
        self.assertEqual(arch_mesh["transition_distance"], "airbox_boundary")
        self.assertEqual(arch_mesh["mesh_strategy"], "thin_film_tetrahedral")
        self.assertEqual(arch_mesh["through_thickness_elements"], 1)
        self.assertEqual(arch_mesh["edge_hmax"], 5e-9)
        self.assertEqual(arch_mesh["edge_thickness"], 10e-9)
        self.assertEqual(arch_mesh["edge_transition_distance"], "airbox_boundary")
        self.assertEqual(arch_mesh["corner_hmax"], 5e-9)
        self.assertEqual(arch_mesh["corner_extent"], 10e-9)
        self.assertEqual(arch_mesh["corner_transition_distance"], "airbox_boundary")
        self.assertNotIn("algorithm_3d", arch_mesh)
        self.assertNotIn("optimize", arch_mesh)
        self.assertEqual(arch_mesh["size_fields"][0]["kind"], "ComponentRestrictedCylinder")
        self.assertEqual(arch_mesh["size_fields"][0]["params"]["VIn"], 1e-9)
        self.assertEqual(arch_mesh["size_fields"][0]["params"]["VOut"], 10e-9)
        self.assertEqual(arch_mesh["size_fields"][0]["params"]["Radius"], 350e-9)
        demag_solver = loaded.problem.discretization.fem.demag_solver_policy
        self.assertIsNotNone(demag_solver)
        self.assertEqual(demag_solver.print_level, 0)
        draft = export_builder_draft(loaded)
        scene = build_scene_document_from_builder(draft)
        object_mesh = scene["objects"][0]["object_mesh"]
        self.assertEqual(object_mesh["mesh_strategy"], "thin_film_tetrahedral")
        self.assertIsNone(object_mesh["algorithm_3d"])
        self.assertEqual(object_mesh["hmin"], "5e-09")
        self.assertEqual(object_mesh["edge_maximum_element_size"], "5e-09")
        self.assertEqual(object_mesh["edge_thickness"], "1e-08")
        self.assertEqual(object_mesh["edge_transition_distance"], "airbox_boundary")
        self.assertEqual(object_mesh["corner_maximum_element_size"], "5e-09")
        self.assertEqual(object_mesh["corner_extent"], "1e-08")
        self.assertEqual(object_mesh["corner_transition_distance"], "airbox_boundary")
        self.assertEqual(object_mesh["interface_maximum_element_size"], "1e-08")

    def test_arch_skyrmion_example_uses_skyrmion_texture_and_gpu_ready_relax(self) -> None:
        example_path = Path(__file__).resolve().parents[3] / "examples" / "arch_skyrmion_relax_50nm.py"
        with patch.dict(os.environ, {"FULLMAG_DEMAG_PRINT_LEVEL": "0"}):
            loaded = load_problem_from_script(example_path, lightweight_assets=True)

        self.assertEqual(loaded.entrypoint_kind, "flat_workspace")
        self.assertEqual(len(loaded.stages), 1)
        texture = loaded.problem.magnets[0].m0
        self.assertEqual(texture.preset_kind, "neel_skyrmion")
        self.assertEqual(texture.params["radius"], 120e-9)
        self.assertEqual(texture.params["wall_width"], 25e-9)
        runtime_selection = loaded.problem.runtime.to_runtime_metadata()
        self.assertEqual(runtime_selection["backend"], "fem")
        self.assertEqual(runtime_selection["device"], "cuda")
        self.assertEqual(runtime_selection["gpu_count"], 1)
        self.assertEqual(runtime_selection["device_index"], 0)

        relax_dynamics = loaded.stages[0].problem.study.to_ir()["dynamics"]
        self.assertEqual(relax_dynamics["integrator"], "rk45")
        self.assertEqual(relax_dynamics["adaptive_timestep"]["atol"], 1e-4)
        self.assertEqual(relax_dynamics["adaptive_timestep"]["dt_min"], 1e-17)
        self.assertEqual(relax_dynamics["adaptive_timestep"]["dt_max"], 1e-14)

    def test_region_owned_gradient_ms_example_keeps_one_physical_object(self) -> None:
        example_path = (
            Path(__file__).resolve().parents[3]
            / "examples"
            / "region_owned_gradient_ms.py"
        )
        loaded = load_problem_from_script(example_path, lightweight_assets=True)

        ir = loaded.problem.to_ir(include_geometry_assets=False)
        self.assertEqual(len(ir["geometry"]["entries"]), 1)
        self.assertEqual(len(ir["object_regions"]), 1)
        self.assertEqual(len(ir["material_parameter_fields"]), 1)

        region_ir = ir["object_regions"][0]
        field_ir = ir["material_parameter_fields"][0]
        self.assertEqual(region_ir["owner_object"], "permalloy_track")
        self.assertEqual(field_ir["owner_object"], "permalloy_track")
        self.assertEqual(field_ir["region_id"], region_ir["region_id"])
        self.assertEqual(field_ir["parameter"], "ms")
        self.assertEqual(field_ir["value"]["kind"], "linear")
        self.assertEqual(ir["couplings"], [])
        self.assertEqual(
            loaded.stages[0].problem.study.to_ir()["dynamics"]["adaptive_timestep"]["dt_max"],
            1e-14,
        )

    def test_two_object_couplings_example_uses_explicit_exchange_and_rkky(self) -> None:
        example_path = (
            Path(__file__).resolve().parents[3] / "examples" / "two_object_couplings.py"
        )
        loaded = load_problem_from_script(example_path, lightweight_assets=True)

        ir = loaded.problem.to_ir(include_geometry_assets=False)
        self.assertEqual(len(ir["geometry"]["entries"]), 2)
        self.assertEqual(len(ir["couplings"]), 2)

        couplings_by_id = {entry["coupling_id"]: entry for entry in ir["couplings"]}
        exchange = couplings_by_id["free_layer_reference_exchange"]
        self.assertEqual(exchange["kind"], "exchange")
        self.assertEqual(exchange["source"], {"kind": "object", "object": "free_layer"})
        self.assertEqual(exchange["target"], {"kind": "object", "object": "reference_layer"})
        self.assertEqual(exchange["parameters"]["mode"], "explicit")
        self.assertEqual(exchange["parameters"]["inter_exchange"], 6.5e-12)

        rkky = couplings_by_id["free_layer_reference_rkky"]
        self.assertEqual(rkky["kind"], "rkky")
        self.assertEqual(
            rkky["source"],
            {"kind": "surface", "object": "free_layer", "selector": "top"},
        )
        self.assertEqual(
            rkky["target"],
            {"kind": "surface", "object": "reference_layer", "selector": "bottom"},
        )
        self.assertEqual(rkky["parameters"], {"kind": "rkky", "j1": -0.0003})
        self.assertEqual(
            loaded.stages[0].problem.study.to_ir()["dynamics"]["adaptive_timestep"]["dt_max"],
            1e-14,
        )

    def test_skyrmion_core_mesh_refinement_example_scopes_region_mesh_policy(self) -> None:
        example_path = (
            Path(__file__).resolve().parents[3]
            / "examples"
            / "skyrmion_core_mesh_refinement.py"
        )
        loaded = load_problem_from_script(example_path, lightweight_assets=True)

        ir = loaded.problem.to_ir(include_geometry_assets=False)
        self.assertEqual(len(ir["geometry"]["entries"]), 1)
        self.assertEqual(len(ir["object_regions"]), 1)

        mesh_workflow = loaded.problem.runtime_metadata["mesh_workflow"]
        self.assertEqual(mesh_workflow["per_geometry"][0]["geometry"], "permalloy_track")
        self.assertEqual(mesh_workflow["per_geometry"][0]["maximum_element_size"], 10e-9)

        core_region = ir["object_regions"][0]
        self.assertEqual(core_region["owner_object"], "permalloy_track")
        self.assertEqual(core_region["name"], "skyrmion_core")
        self.assertEqual(core_region["shape"]["kind"], "cylinder")
        self.assertEqual(core_region["mesh_policy"]["maximum_element_size"], 1e-9)
        self.assertEqual(core_region["mesh_policy"]["minimum_element_size"], 1e-9)
        self.assertEqual(core_region["mesh_policy"]["transition_distance"], 40e-9)
        self.assertEqual(
            loaded.stages[0].problem.study.to_ir()["dynamics"]["adaptive_timestep"]["dt_max"],
            1e-14,
        )

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

    def test_study_magnet_handle_lowers_uniform_cubic_anisotropy(self) -> None:
        fm.reset()
        study = fm.study("study_cubic_anisotropy")
        body = study.geometry(fm.Box(size=(20e-9, 10e-9, 5e-9)), name="body")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.Kc1 = 48e3

        problem = flat_world._build_problem()

        self.assertEqual(problem.magnets[0].material.Kc1, 48e3)
        self.assertEqual(problem.to_ir()["materials"][0]["cubic_anisotropy_kc1"], 48e3)

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
            self.assertIn('study.stages.add_run(until=1e-12)', rewritten)

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

    def test_flat_script_can_disable_exchange_and_demag_effective_field_terms(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "disabled_effective_field_terms.py"
            path.write_text(
                "\n".join(
                    [
                        "import fullmag as fm",
                        "fm.engine('fem')",
                        "fm.exchange(enabled=False)",
                        "fm.demag(enabled=False)",
                        "fm.b_ext(0.0, 0.0, 0.01)",
                        "body = fm.geometry(fm.Box(20e-9, 20e-9, 10e-9), name='body')",
                        "body.Ms = 800e3",
                        "body.Aex = 13e-12",
                        "body.alpha = 0.1",
                        "body.m = fm.texture.uniform(1, 0, 0)",
                        "fm.run(1e-12)",
                        "",
                    ]
                ),
                encoding="utf-8",
            )

            loaded = fm.load_problem_from_script(path)
            term_kinds = [term["kind"] for term in loaded.problem.to_ir()["energy_terms"]]
            self.assertNotIn("exchange", term_kinds)
            self.assertNotIn("demag", term_kinds)
            self.assertIn("zeeman", term_kinds)

            draft = export_builder_draft(loaded)
            self.assertEqual(draft["exchange_enabled"], False)
            self.assertEqual(draft["demag_enabled"], False)

            scene = build_scene_document_from_builder(draft)
            self.assertEqual(scene["study"]["exchange_enabled"], False)
            self.assertEqual(scene["study"]["demag_enabled"], False)
            round_trip = build_builder_from_scene_document(scene)
            self.assertEqual(round_trip["exchange_enabled"], False)
            self.assertEqual(round_trip["demag_enabled"], False)

            rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
            self.assertIn("fm.exchange(enabled=False)", rewritten)
            self.assertIn("fm.demag(enabled=False)", rewritten)

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

    def test_study_build_domain_mesh_keeps_airbox_hmax_out_of_object_base(self) -> None:
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
        self.assertEqual(workflow["fem"]["hmax"], 25e-9)
        self.assertEqual(loaded.problem.runtime_metadata["study_universe"]["airbox_hmax"], 80e-9)
        self.assertEqual(workflow["per_geometry"][0]["hmax"], 25e-9)

    def test_object_mesh_rejects_imported_mesh_source(self) -> None:
        fm.reset()
        study = fm.study("object_mesh_source_rejected")
        body = study.geometry(fm.Box(20e-9, 20e-9, 10e-9), name="body")

        with self.assertRaisesRegex(
            ValueError,
            r"per-object mesh source is unavailable; use FEM\(mesh=\.\.\.\)",
        ):
            body.mesh(source="object.mesh")

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
            object_region_markers={"left:skyrmion_core": 3},
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
        self.assertEqual(
            workflow["domain_object_region_markers"],
            [
                {"geometry_name": "left:skyrmion_core", "marker": 3},
            ],
        )

        stub_mesh = MeshData.from_legacy_tet4(
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
        self.assertEqual(
            ir["geometry_assets"]["fem_domain_mesh_asset"]["object_region_markers"],
            [
                {"geometry_name": "left:skyrmion_core", "marker": 3},
            ],
        )

        rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
        self.assertIn(
            'study.domain_mesh(source="prebuilt_domain.json", region_markers={"left": 1, "right": 2}, object_region_markers={"left:skyrmion_core": 3})',
            rewritten,
        )

    def test_study_domain_mesh_rejects_object_region_marker_collisions(self) -> None:
        fm.reset()
        study = fm.study("invalid_explicit_shared_domain")
        study.engine("fem")

        with self.assertRaisesRegex(
            ValueError,
            "object_region_markers marker 1 duplicates a region_markers marker",
        ):
            study.domain_mesh(
                "prebuilt_domain.json",
                region_markers={"film": 1},
                object_region_markers={"film:core": 1},
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

    def test_scene_document_preserves_bulk_dmi_material_round_trip(self) -> None:
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
                    "material": {"Ms": 800e3, "Aex": 13e-12, "alpha": 0.1, "Dbulk": -2e-3},
                    "magnetization": {"kind": "uniform", "value": [1.0, 0.0, 0.0]},
                    "mesh": {"mode": "inherit", "hmax": ""},
                }
            ],
            "current_modules": [],
            "excitation_analysis": None,
        }

        scene = build_scene_document_from_builder(builder)
        self.assertIn(
            {"kind": "bulk_dmi", "enabled": True, "params": {"dbulk": -2e-3}},
            scene["objects"][0]["physics_stack"],
        )

        rebuilt = build_builder_from_scene_document(scene)
        geometry = rebuilt["geometries"][0]
        self.assertEqual(geometry["material"]["Dbulk"], -2e-3)
        self.assertIn(
            {"kind": "bulk_dmi", "enabled": True, "params": {"dbulk": -2e-3}},
            geometry["physics_stack"],
        )

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
        self.assertAlmostEqual(
            ir["study"]["stop"]["torque_tolerance_apm"],
            1e-3 / (4.0e-7 * math.pi),
        )
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

    def test_flat_tableautosave_registers_default_sampling_table(self) -> None:
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
        self.assertEqual(
            ir["study"]["sampling"]["table_autosave"],
            {
                "kind": "table_autosave",
                "table_id": "default",
                "sample_period_s": 5e-12,
                "quantities": ["step", "t", "mx", "my", "mz", "e_total", "max_torque"],
            },
        )

    def test_flat_tableautosave_accepts_custom_table_columns(self) -> None:
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
        self.assertEqual(
            ir["study"]["sampling"]["table_autosave"],
            {
                "kind": "table_autosave",
                "table_id": "default",
                "sample_period_s": 5e-12,
                "quantities": ["t", "mx", "e_total"],
            },
        )

    def test_cylinder_serializes_to_ir(self) -> None:
        geometry = fm.Cylinder(radius=50e-9, height=10e-9, name="pillar")

        self.assertEqual(
            geometry.to_ir(),
            {
                "kind": "cylinder",
                "name": "pillar",
                "radius": 50e-9,
                "height": 10e-9,
                "axis": [0.0, 0.0, 1.0],
            },
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

    def test_fdm_per_magnet_round_trip_preserves_missing_default(self) -> None:
        hints = fm.FDM(
            default_cell=None,
            per_magnet={
                "left": fm.FDMGrid(cell=(1e-9, 2e-9, 3e-9)),
                "right": fm.FDMGrid(cell=(2e-9, 2e-9, 3e-9)),
            },
        )

        payload = hints.to_ir()

        self.assertNotIn("default_cell", payload)
        self.assertEqual(payload["per_magnet"]["left"]["cell"], [1e-9, 2e-9, 3e-9])
        self.assertEqual(payload["per_magnet"]["right"]["cell"], [2e-9, 2e-9, 3e-9])

    def test_script_export_preserves_per_magnet_fdm_grids(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            script_path = Path(tmp_dir) / "per_magnet_export.py"
            script_path.write_text(
                textwrap.dedent(
                    """
                    import fullmag as fm

                    fm.engine("fdm")
                    fm.fdm(
                        per_magnet={
                            "left": fm.FDMGrid(cell=(1e-9, 2e-9, 3e-9)),
                            "right": fm.FDMGrid(cell=(2e-9, 2e-9, 3e-9)),
                        },
                        demag=fm.FDMDemag(
                            strategy="multilayer_convolution",
                            mode="two_d_stack",
                            common_cells_xy=(32, 32),
                            explain=False,
                        ),
                        boundary_phi_floor=0.1,
                        boundary_delta_min=0.2e-9,
                    )
                    left = fm.geometry(fm.Box(size=(10e-9, 10e-9, 3e-9), name="left"), name="left")
                    right = fm.geometry(fm.Box(size=(10e-9, 10e-9, 3e-9), name="right"), name="right")
                    left.Ms = right.Ms = 800e3
                    left.Aex = right.Aex = 13e-12
                    fm.run(1e-12)
                    """
                ).strip()
                + "\n",
                encoding="utf-8",
            )
            loaded = load_problem_from_script(script_path, lightweight_assets=True)
            rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
            self.assertIn('fm.fdm(per_magnet={"left": fm.FDMGrid', rewritten)
            self.assertIn('demag=fm.FDMDemag(strategy="multilayer_convolution"', rewritten)

            rewritten_path = Path(tmp_dir) / "per_magnet_export_rewritten.py"
            rewritten_path.write_text(rewritten, encoding="utf-8")
            round_tripped = load_problem_from_script(rewritten_path, lightweight_assets=True)

        fdm = round_tripped.problem.discretization.fdm
        self.assertIsNotNone(fdm)
        self.assertIsNone(fdm.default_cell)
        self.assertEqual(fdm.per_magnet["left"].cell, (1e-9, 2e-9, 3e-9))
        self.assertEqual(fdm.per_magnet["right"].cell, (2e-9, 2e-9, 3e-9))
        self.assertEqual(fdm.demag.strategy, "multilayer_convolution")
        self.assertEqual(fdm.demag.common_cells_xy, (32, 32))
        self.assertFalse(fdm.demag.explain)
        self.assertEqual(fdm.boundary_phi_floor, 0.1)
        self.assertEqual(fdm.boundary_delta_min, 0.2e-9)

    def test_fdm_demag_rejects_removed_single_grid_fallback_switch(self) -> None:
        with self.assertRaisesRegex(ValueError, "allow_single_grid_fallback.*removed"):
            fm.FDMDemag(allow_single_grid_fallback=True)

        self.assertNotIn("allow_single_grid_fallback", fm.FDMDemag().to_ir())

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

        mesh = MeshData.from_legacy_tet4(
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

    def test_fem_backend_forwards_study_universe_to_shared_domain_realization(self) -> None:
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

        mesh = MeshData.from_legacy_tet4(
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
            "fullmag.meshing.asset_pipeline.realize_fem_domain_mesh_asset_from_components_with_report",
            return_value=(mesh, [{"geometry_name": "box_geom", "marker": 1}], None),
        ) as mocked_domain, patch("fullmag._core.validate_mesh_ir", return_value=True):
            problem.to_ir(requested_backend=fm.BackendTarget.FEM)

        self.assertEqual(mocked_mesh.call_count, 0)
        self.assertEqual(mocked_domain.call_count, 1)
        forwarded_domain_universe = mocked_domain.call_args.kwargs["study_universe"]
        self.assertIsNotNone(forwarded_domain_universe)
        self.assertEqual(forwarded_domain_universe["mode"], "manual")
        self.assertEqual(forwarded_domain_universe["size"], [80e-9, 60e-9, 40e-9])
        self.assertEqual(forwarded_domain_universe["center"], [5e-9, -2e-9, 1e-9])
        self.assertEqual(forwarded_domain_universe["airbox_hmin"], 12e-9)
        self.assertEqual(forwarded_domain_universe["airbox_growth_rate"], 1.25)
        self.assertEqual(forwarded_domain_universe["airbox_grading"], "linear")

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

        mesh = MeshData.from_legacy_tet4(
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
        domain_mesh = MeshData.from_legacy_tet4(
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

        surface_mesh = MeshData.from_legacy_tet4(
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

        mesh = MeshData.from_legacy_tet4(
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

    def test_scene_document_region_edits_export_as_canonical_python(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("scene_region_export")
        study.engine("fem")

        body = study.geometry(fm.Box(100e-9, 40e-9, 5e-9), name="body")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)

        core = body.add_region(
            "core",
            fm.Cylinder(radius=10e-9, height=5e-9),
            region_id="body:core",
        )
        core.mesh(maximum_element_size=3e-9)
        core.set_material("ms", fm.fields.constant(760e3, unit="A/m"), priority=2)

        study.exchange()
        study.run(1e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_scene_region_export.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)

            draft = export_builder_draft(loaded)
            scene = build_scene_document_from_builder(draft)
            scene_region = scene["objects"][0]["regions"][0]
            scene_region["region_id"] = "body:ui-core"
            scene_region["name"] = "ui_core"
            scene_region["mesh_policy"] = {
                "maximum_element_size": 1e-9,
                "minimum_element_size": 1e-9,
                "transition_distance": 20e-9,
                "order": 1,
            }
            scene_region["material_overrides"] = [
                {
                    "parameter": "ms",
                    "value": {"kind": "constant", "value": 700e3, "unit": "A/m"},
                    "priority": 5,
                    "conflict_policy": "higher_priority_wins",
                }
            ]
            scene["objects"][0]["material_parameter_fields"] = [
                {
                    "assignment_id": "field:ui-core-alpha",
                    "parameter": "alpha",
                    "value": {"kind": "constant", "value": 0.05, "unit": "dimensionless"},
                    "region_id": "body:ui-core",
                    "priority": 6,
                    "conflict_policy": "higher_priority_wins",
                }
            ]

            rewritten = rewrite_loaded_problem_script(
                loaded,
                overrides=builder_overrides_from_scene_document(scene),
            )["rendered_source"]

        self.assertIn('region_id="body:ui-core"', rewritten)
        self.assertIn('body_ui_core_region = body.add_region("ui_core"', rewritten)
        self.assertIn('body_ui_core_region.mesh(maximum_element_size=1e-09', rewritten)
        self.assertIn(
            'body_ui_core_region.set_material("ms", fm.fields.constant(700000, unit="A/m"), priority=5',
            rewritten,
        )
        self.assertIn(
            'body.set_material_field("alpha", fm.fields.constant(0.05, unit="dimensionless"), assignment_id="field:ui-core-alpha", region=body_ui_core_region',
            rewritten,
        )

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
        fm.relax(max_steps=25, tolA=1e-5, algorithm="llg_overdamped")
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

    def test_builder_rewrite_preserves_frequency_response_stage_and_output(self) -> None:
        problem = replace(
            self._build_problem(),
            energy=[fm.Exchange()],
            discretization=None,
            study=fm.FrequencyResponse(
                outputs=[fm.SaveResponse("susceptibility_tensor")],
                frequencies_hz=[1.0e9, 2.0e9],
                excitation_field_au_per_m=(0.0, 0.0, 2.5),
                excitation_phase_rad=0.25,
                include_demag=False,
                magnetostatic_bc="periodic_airbox_k0",
                k_vector=(0.0, 0.0, 0.0),
                damping_policy="include",
                spin_wave_bc=fm.PeriodicBC(["x_faces"]),
            ),
        )

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_builder_frequency_response.py"
            path.write_text("import fullmag as fm\n", encoding="utf-8")
            loaded = LoadedProblem(
                problem=problem,
                source_path=path,
                script_source=path.read_text(encoding="utf-8"),
                entrypoint_kind="build",
            )

            draft = export_builder_draft(loaded)
            rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
            rewrite_path = Path(tmp_dir) / "script_builder_frequency_response_rewritten.py"
            rewrite_path.write_text(rewritten, encoding="utf-8")
            reloaded = fm.load_problem_from_script(rewrite_path, lightweight_assets=True)

        self.assertEqual(draft["stages"][0]["kind"], "frequency_response")
        self.assertEqual(
            draft["stages"][0]["frequency_magnetostatic_bc"],
            "periodic_airbox_k0",
        )
        self.assertEqual(
            draft["study_pipeline"]["nodes"][0]["payload"]["frequency_magnetostatic_bc"],
            "periodic_airbox_k0",
        )
        self.assertEqual(draft["study_pipeline"]["nodes"][0]["stage_kind"], "frequency_response")
        self.assertIn('fm.save_response("susceptibility_tensor")', rewritten)
        self.assertIn("fm.frequency_response(", rewritten)
        self.assertIn("excitation_phase_rad=0.25", rewritten)
        self.assertIn('bc=fm.PeriodicBC(["x_faces"])', rewritten)
        self.assertIn('magnetostatic_bc="periodic_airbox_k0"', rewritten)
        self.assertEqual(reloaded.stages[0].problem.study.to_ir()["kind"], "frequency_response")
        self.assertEqual(
            reloaded.stages[0].problem.study.to_ir()["frequencies_hz"],
            {"values_hz": [1.0e9, 2.0e9]},
        )
        self.assertEqual(
            reloaded.stages[0].problem.study.to_ir()["excitation"]["phase_rad"],
            0.25,
        )
        self.assertEqual(
            reloaded.stages[0].problem.study.to_ir()["spin_wave_bc"],
            {"kind": "periodic", "pair_ids": ["x_faces"]},
        )
        self.assertEqual(
            reloaded.stages[0].problem.study.to_ir()["magnetostatic_bc"],
            "periodic_airbox_k0",
        )

    def test_frequency_response_solver_policy_round_trips_from_python_stage(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("frequency_response_solver_policy")
        film = study.geometry(fm.Box(size=(2e-7, 2e-7, 1e-8), name="film"), name="film")
        film.Ms = 800e3
        film.Aex = 13e-12
        film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
        study.stages.add_frequency_response(
            frequencies_hz=[2.0e9],
            solver_method="gpu_operator_host_krylov",
            solver_preconditioner="block_jacobi",
            solver_max_iterations=128,
            solver_restart_iterations=32,
            solver_rtol=1e-2,
            excitation_field_au_per_m=(0.0, 0.0, 1.0),
            include_demag=True,
            equilibrium_source="relax",
            damping_policy="include",
            bc=fm.PeriodicBC(["x_faces", "y_faces"]),
            magnetostatic_bc="open",
        )
        """

        with TemporaryDirectory() as tmp_dir:
            script_path = Path(tmp_dir) / "frequency_response_solver_policy.py"
            script_path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(script_path, lightweight_assets=True)
            rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
            rewrite_path = Path(tmp_dir) / "frequency_response_solver_policy_rewritten.py"
            rewrite_path.write_text(rewritten, encoding="utf-8")
            reloaded = fm.load_problem_from_script(rewrite_path, lightweight_assets=True)

        policy = loaded.stages[0].problem.study.to_ir()["solver_policy"]
        self.assertEqual(
            policy,
            {
                "method": "gpu_operator_host_krylov",
                "preconditioner": "block_jacobi",
                "rtol": 1e-2,
                "max_iterations": 128,
                "restart_iterations": 32,
            },
        )
        self.assertIn('solver_method="gpu_operator_host_krylov"', rewritten)
        self.assertIn('solver_preconditioner="block_jacobi"', rewritten)
        self.assertIn("solver_max_iterations=128", rewritten)
        self.assertIn("solver_restart_iterations=32", rewritten)
        self.assertIn("solver_rtol=0.01", rewritten)
        self.assertEqual(
            reloaded.stages[0].problem.study.to_ir()["solver_policy"],
            policy,
        )

    def test_frequency_response_accepts_uppercase_max_iterations_alias(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("frequency_response_solver_alias")
        film = study.geometry(fm.Box(size=(2e-7, 2e-7, 1e-8), name="film"), name="film")
        film.Ms = 800e3
        film.Aex = 13e-12
        film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
        study.stages.add_frequency_response(
            frequencies_hz=[2.0e9],
            MAX_ITERATIONS=128,
        )
        """

        with TemporaryDirectory() as tmp_dir:
            script_path = Path(tmp_dir) / "frequency_response_solver_alias.py"
            script_path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(script_path, lightweight_assets=True)

        self.assertEqual(
            loaded.stages[0].problem.study.to_ir()["solver_policy"]["max_iterations"],
            128,
        )

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
        study.stages.add_stage(fm.relax_stage(
            max_steps=25, tolA=1e-5, algorithm="llg_overdamped", dt=1e-15
        ))
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
        self.assertIn("tolA=1e-05", rewritten)
        self.assertIn("max_steps=25", rewritten)
        self.assertIn('study.stages.add_run(stage_id="run-1", until=4e-12)', rewritten)

    def test_study_stage_builder_change_device_roundtrips_as_pipeline_action(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("stage_change_device")
        study.engine("fem")
        study.device("gpu", precision="double")
        body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        study.stages.add_relax(max_steps=25, dt=1e-15)
        study.stages.change_device("cpu")
        study.stages.add_eigenmodes(count=4)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_builder_study_stage_change_device.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)

        draft = export_builder_draft(loaded)
        self.assertEqual(len(draft["stages"]), 3)
        self.assertEqual(draft["stages"][1]["kind"], "change_device")
        self.assertEqual(draft["stages"][1]["device"], "cpu")
        self.assertEqual(draft["study_pipeline"]["nodes"][1]["stage_kind"], "change_device")
        self.assertEqual(draft["study_pipeline"]["nodes"][1]["payload"]["device"], "cpu")

        rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
        self.assertIn('study.stages.change_device("cpu")', rewritten)

    def test_study_stage_builder_eigenmodes_operator_roundtrips(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("stage_eigen_operator")
        study.engine("fem")
        study.device("cpu", precision="double")
        body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        study.stages.add_eigenmodes(
            count=4,
            target="frequency_window",
            frequency_min=100e6,
            frequency_max=5e9,
            operator="full_2x2",
            include_demag=True,
        )
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_builder_eigen_operator.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)

        self.assertEqual(
            loaded.stages[0].problem.study.to_ir()["operator"]["kind"],
            "full_2x2",
        )

        rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
        self.assertIn('operator="full_2x2"', rewritten)

    def test_study_builder_eigenmodes_forwards_operator(self) -> None:
        builder = flat_world.study("immediate_eigen_operator")

        with patch("fullmag.world.eigenmodes", return_value="eigen-result") as mocked:
            result = builder.eigenmodes(operator="full_2x2")

        self.assertEqual(result, "eigen-result")
        self.assertEqual(mocked.call_args.kwargs["operator"], "full_2x2")

    def test_study_builder_frequency_response_forwards_solver_preconditioner(self) -> None:
        builder = flat_world.study("immediate_frequency_preconditioner")

        with patch("fullmag.world.frequency_response", return_value="response-result") as mocked:
            result = builder.frequency_response(
                frequencies_hz=[1.0e9],
                solver_preconditioner="block_jacobi",
            )

        self.assertEqual(result, "response-result")
        self.assertEqual(
            mocked.call_args.kwargs["solver_preconditioner"],
            "block_jacobi",
        )

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

    def test_study_builder_relax_stage_roundtrips_adaptive_dt_max(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("stage_authoring")
        study.engine("fem")
        body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        study.stages.add_relax(
            max_steps=25,
            solver="rk45",
            max_error=1e-6,
            dt_min=1e-17,
            dt_max=1e-15,
        )
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_builder_study_stage_relax_dt_max.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)

        rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
        self.assertIn('solver="rk45"', rewritten)
        self.assertIn("dt_min=1e-17", rewritten)
        self.assertIn("dt_max=1e-15", rewritten)

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
        study_ir = loaded.stages[0].problem.study.to_ir()
        self.assertEqual(study_ir["algorithm"], "nonlinear_cg")
        self.assertAlmostEqual(
            study_ir["stop"]["torque_tolerance_apm"],
            1e-6 / (4.0e-7 * math.pi),
        )
        self.assertNotIn("dynamics", study_ir)

        stage_payload = export_builder_draft(loaded)["stages"][0]
        for field in (
            "integrator",
            "fixed_timestep",
            "demag_interval_s",
            "max_relaxation_time_s",
            "max_pseudotime_s",
            "max_physical_time_s",
        ):
            self.assertNotIn(field, stage_payload)

        rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
        stage_line = next(
            line for line in rewritten.splitlines() if "stages.add_relax(" in line
        )
        for field in (
            "solver=",
            "dt=",
            "max_error=",
            "dt_min=",
            "dt_max=",
            "relax_alpha=",
            "max_pseudotime_s=",
            "max_physical_time_s=",
        ):
            self.assertNotIn(field, stage_line)

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
            timestep=fm.AdaptiveTimestep(
                atol=1e-7,
                rtol=2e-5,
                dt_min=1e-16,
                dt_max=1e-13,
            ),
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
            adaptive = stage.problem.study.to_ir()["dynamics"]["adaptive_timestep"]
            self.assertEqual(adaptive["atol"], 1e-7)
            self.assertEqual(adaptive["rtol"], 2e-5)
            self.assertEqual(adaptive["dt_min"], 1e-16)
            self.assertEqual(adaptive["dt_max"], 1e-13)

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

    def test_study_stage_builder_add_hysteresis_sweep(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("stage_hysteresis_sweep")
        study.engine("fem")
        body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        study.stages.add_hysteresis_sweep(
            field_min_mT=-100.0,
            field_max_mT=100.0,
            field_step_mT=5.0,
            orientation=fm.FieldOrientation.preset("oop_positive"),
            initial_protocol="positive_saturation",
            saturation=fm.SaturationProbe(mode="auto", max_field_mT=300.0, on_failure="stop_stage"),
            branch_mode="major_loop",
            settle_pipeline=fm.SettlePipeline([
                fm.MinimizeStep(max_steps=2000),
                fm.RelaxStep(max_steps=10000)
            ]),
            storage=fm.HysteresisStorage(magnetization="selected", every_n=5)
        )
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_builder_stage_hysteresis_sweep.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)

        self.assertEqual(len(loaded.stages), 1)
        stage = loaded.stages[0]
        self.assertEqual(stage.entrypoint_kind, "flat_hysteresis")
        ir = stage.problem.study.to_ir()
        self.assertEqual(ir["kind"], "hysteresis")
        self.assertEqual(ir["field_min_mT"], -100.0)
        self.assertEqual(ir["field_max_mT"], 100.0)
        self.assertEqual(ir["field_step_mT"], 5.0)
        self.assertEqual(
            ir["field_unit_provenance"],
            {
                "authored_quantity": "mu0_h",
                "authored_unit": "mT",
                "canonical_quantity": "h_ext",
                "canonical_unit": "A/m",
                "display_unit": "mT",
                "mu0_h_per_m": 1.2566370614359172e-6,
            },
        )
        self.assertEqual(ir["orientation"], {"kind": "preset", "preset_name": "oop_positive"})
        self.assertEqual(ir["initial_protocol"], "positive_saturation")
        self.assertEqual(ir["branch_mode"], "major_loop")
        self.assertEqual(ir["saturation"]["max_field_mT"], 300.0)
        self.assertEqual(ir["saturation"]["on_failure"], "stop_stage")
        self.assertEqual(ir["settle_pipeline"]["kind"], "sequence")
        self.assertEqual(len(ir["settle_pipeline"]["steps"]), 2)
        self.assertEqual(ir["settle_pipeline"]["steps"][0]["max_steps"], 2000)
        self.assertEqual(ir["settle_pipeline"]["steps"][1]["max_steps"], 10000)
        self.assertEqual(ir["storage"]["magnetization"], "selected")
        self.assertEqual(ir["storage"]["every_n"], 5)
        pipeline = loaded.study_pipeline_document()
        self.assertIsNotNone(pipeline)
        node = pipeline["nodes"][0]
        self.assertEqual(node["stage_kind"], "hysteresis")
        self.assertEqual(node["payload"]["kind"], "hysteresis")
        self.assertEqual(node["payload"]["field_step_mT"], 5.0)
        self.assertEqual(node["payload"]["settle_pipeline"]["kind"], "sequence")
        builder_draft = export_builder_draft(loaded)
        self.assertEqual(builder_draft["stages"][0]["kind"], "hysteresis")
        self.assertEqual(builder_draft["study_pipeline"]["nodes"][0]["stage_kind"], "hysteresis")

        rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
        self.assertIn("study.stages.add_hysteresis_sweep(", rewritten)
        self.assertIn('orientation=fm.FieldOrientation.preset("oop_positive")', rewritten)
        self.assertIn("saturation=fm.SaturationProbe(", rewritten)
        self.assertIn('mode="auto"', rewritten)
        self.assertIn("max_field_mT=300", rewritten)
        self.assertIn("susceptibility_threshold=0.001", rewritten)
        self.assertIn("transverse_threshold=0.01", rewritten)
        self.assertIn('on_failure="stop_stage"', rewritten)
        self.assertIn("settle_pipeline=fm.SettlePipeline([", rewritten)
        self.assertIn("fm.MinimizeStep(", rewritten)
        self.assertIn("fm.RelaxStep(", rewritten)
        self.assertIn("max_steps=2000", rewritten)
        self.assertIn("max_steps=10000", rewritten)
        self.assertIn("storage=fm.HysteresisStorage(", rewritten)
        self.assertIn('magnetization="selected"', rewritten)
        self.assertIn("every_n=5", rewritten)

        with TemporaryDirectory() as tmp_dir:
            rewritten_path = Path(tmp_dir) / "rewritten_hysteresis_sweep.py"
            rewritten_path.write_text(rewritten, encoding="utf-8")
            reloaded = fm.load_problem_from_script(rewritten_path, lightweight_assets=True)

        self.assertEqual(reloaded.stages[0].problem.study.to_ir()["kind"], "hysteresis")
        self.assertEqual(
            reloaded.stages[0].problem.study.to_ir()["settle_pipeline"]["steps"][0]["max_steps"],
            2000,
        )
        self.assertEqual(
            reloaded.stages[0].problem.study.to_ir()["field_unit_provenance"],
            ir["field_unit_provenance"],
        )

    def test_study_stage_builder_hysteresis_checkpoint_initial_state_ref_round_trip(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("stage_hysteresis_checkpoint")
        body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.m = fm.texture.uniform(1, 0, 0)
        study.stages.add_hysteresis_sweep(
            field_min_mT=-100.0,
            field_max_mT=100.0,
            field_step_mT=10.0,
            orientation=fm.FieldOrientation.preset("oop_positive"),
            initial_protocol="checkpoint",
            initial_state_ref="hysteresis_snapshots/hysteresis_point_003/m.json",
        )
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_builder_stage_hysteresis_checkpoint.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)

        ir = loaded.stages[0].problem.study.to_ir()
        self.assertEqual(ir["initial_protocol"], "checkpoint")
        self.assertEqual(
            ir["initial_state_ref"],
            "hysteresis_snapshots/hysteresis_point_003/m.json",
        )

        rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
        self.assertIn('initial_protocol="checkpoint"', rewritten)
        self.assertIn(
            'initial_state_ref="hysteresis_snapshots/hysteresis_point_003/m.json"',
            rewritten,
        )

        with TemporaryDirectory() as tmp_dir:
            rewritten_path = Path(tmp_dir) / "rewritten_hysteresis_checkpoint.py"
            rewritten_path.write_text(rewritten, encoding="utf-8")
            reloaded = fm.load_problem_from_script(rewritten_path, lightweight_assets=True)

        self.assertEqual(
            reloaded.stages[0].problem.study.to_ir()["initial_state_ref"],
            "hysteresis_snapshots/hysteresis_point_003/m.json",
        )

    def test_fdm_hysteresis_smoke_example_loads_canonical_stage(self) -> None:
        example_path = Path(__file__).resolve().parents[3] / "examples" / "fdm_hysteresis_smoke.py"

        loaded = fm.load_problem_from_script(example_path, lightweight_assets=True)

        self.assertEqual(len(loaded.stages), 1)
        stage = loaded.stages[0]
        self.assertEqual(stage.entrypoint_kind, "flat_hysteresis")
        study = stage.problem.study.to_ir()
        self.assertEqual(study["kind"], "hysteresis")
        self.assertEqual(study["field_values_mT"], [50.0, 0.0, -50.0])
        self.assertEqual(study["orientation"], {"kind": "preset", "preset_name": "in_plane_y"})
        self.assertEqual(study["measurement_axis"], "field_axis")
        self.assertEqual(study["initial_protocol"], "as_authored")
        self.assertEqual(study["storage"]["magnetization"], "none")

    def test_study_stage_builder_hysteresis_custom_measurement_axis_round_trips(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("stage_hysteresis_custom_measurement_axis")
        body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.m = fm.texture.uniform(1, 0, 0)
        study.stages.add_hysteresis_sweep(
            field_values_mT=[100.0, 0.0, -100.0],
            orientation=fm.FieldOrientation.sample(theta_deg=90.0, phi_deg=35.0),
            measurement_axis=fm.MeasurementAxis.custom((0.0, 3.0, 4.0)),
            initial_protocol="as_authored",
            storage=fm.HysteresisStorage(magnetization="none"),
        )
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "hysteresis_custom_measurement_axis.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)

        study = loaded.stages[0].problem.study.to_ir()
        self.assertEqual(
            study["measurement_axis"],
            {"kind": "custom", "vector": [0.0, 3.0, 4.0]},
        )

        rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
        self.assertIn("measurement_axis=fm.MeasurementAxis.custom([0, 3, 4])", rewritten)

        with TemporaryDirectory() as tmp_dir:
            rewritten_path = Path(tmp_dir) / "rewritten_hysteresis_custom_measurement_axis.py"
            rewritten_path.write_text(rewritten, encoding="utf-8")
            reloaded = fm.load_problem_from_script(rewritten_path, lightweight_assets=True)

        self.assertEqual(
            reloaded.stages[0].problem.study.to_ir()["measurement_axis"],
            {"kind": "custom", "vector": [0.0, 3.0, 4.0]},
        )

    def test_fdm_hysteresis_snapshot_smoke_example_loads_snapshot_storage(self) -> None:
        example_path = (
            Path(__file__).resolve().parents[3] / "examples" / "fdm_hysteresis_snapshot_smoke.py"
        )

        loaded = fm.load_problem_from_script(example_path, lightweight_assets=True)

        self.assertEqual(len(loaded.stages), 1)
        stage = loaded.stages[0]
        self.assertEqual(stage.entrypoint_kind, "flat_hysteresis")
        study = stage.problem.study.to_ir()
        self.assertEqual(study["kind"], "hysteresis")
        self.assertEqual(study["field_values_mT"], [50.0, 0.0, -50.0])
        self.assertEqual(study["storage"]["magnetization"], "every_n")
        self.assertEqual(study["storage"]["every_n"], 1)

    def test_hysteresis_waveguide_smoke_example_loads_fast_fem_stage(self) -> None:
        example_path = (
            Path(__file__).resolve().parents[3]
            / "examples"
            / "hysteresis_waveguide_300x50x10nm.py"
        )

        loaded = fm.load_problem_from_script(example_path, lightweight_assets=True)

        self.assertEqual(len(loaded.stages), 1)
        stage = loaded.stages[0]
        self.assertEqual(stage.entrypoint_kind, "flat_hysteresis")
        runtime_metadata = stage.problem.runtime_metadata
        universe = runtime_metadata["study_universe"]
        self.assertEqual(universe["mode"], "manual")
        for actual, expected in zip(universe["size"], [1000e-9, 200e-9, 100e-9]):
            self.assertAlmostEqual(actual, expected)
        self.assertAlmostEqual(universe["airbox_hmax"], 100e-9)

        study = stage.problem.study.to_ir()
        self.assertEqual(study["kind"], "hysteresis")
        self.assertEqual(
            study["field_values_mT"],
            [50.0, 25.0, 0.0, -25.0, -50.0, -25.0, 0.0, 25.0, 50.0],
        )
        self.assertEqual(study["orientation"], {"kind": "preset", "preset_name": "in_plane_x"})
        self.assertEqual(study["measurement_axis"], "field_axis")
        self.assertEqual(study["settle_pipeline"]["steps"][0]["kind"], "minimize")
        self.assertEqual(study["settle_pipeline"]["steps"][0]["max_steps"], 200)
        self.assertEqual(study["storage"]["magnetization"], "none")

    def test_hysteresis_waveguide_example_can_enable_every_step_playback(self) -> None:
        example_path = (
            Path(__file__).resolve().parents[3]
            / "examples"
            / "hysteresis_waveguide_300x50x10nm.py"
        )

        with patch.dict(
            os.environ,
            {
                "FULLMAG_HYSTERESIS_FIELD_VALUES_MT": "50,0,-50",
                "FULLMAG_HYSTERESIS_MAX_STEPS": "25",
                "FULLMAG_HYSTERESIS_MAGNETIZATION_STORAGE": "every_step",
            },
        ):
            loaded = fm.load_problem_from_script(example_path, lightweight_assets=True)

        self.assertEqual(len(loaded.stages), 1)
        study = loaded.stages[0].problem.study.to_ir()
        self.assertEqual(study["field_values_mT"], [50.0, 0.0, -50.0])
        self.assertEqual(study["settle_pipeline"]["steps"][0]["max_steps"], 25)
        self.assertEqual(study["storage"]["magnetization"], "every_step")
        self.assertEqual(study["storage"]["every_n"], 1)

    def test_hysteresis_fdm_thinfilm_oop_ip_example_loads_angular_family(self) -> None:
        example_path = (
            Path(__file__).resolve().parents[3]
            / "examples"
            / "hysteresis_fdm_thinfilm_oop_ip_validation.py"
        )

        with patch.dict(
            os.environ,
            {
                "FULLMAG_HYSTERESIS_FIELD_VALUES_MT": "150,0,-150",
                "FULLMAG_HYSTERESIS_MAX_STEPS": "25",
                "FULLMAG_HYSTERESIS_IN_PLANE_PHI_DEG": "7.5",
            },
        ):
            loaded = fm.load_problem_from_script(example_path, lightweight_assets=True)

        self.assertEqual(len(loaded.stages), 1)
        stage = loaded.stages[0]
        self.assertEqual(stage.entrypoint_kind, "flat_hysteresis")
        study = stage.problem.study.to_ir()
        self.assertEqual(study["kind"], "hysteresis")
        self.assertEqual(study["field_values_mT"], [150.0, 0.0, -150.0])
        self.assertEqual(
            study["orientation"],
            {"kind": "sample", "theta": 90.0, "phi": 7.5},
        )
        self.assertEqual(study["measurement_axis"], "field_axis")
        self.assertEqual(study["settle_pipeline"]["steps"][0]["kind"], "minimize")
        self.assertEqual(study["settle_pipeline"]["steps"][0]["max_steps"], 25)
        family = study["angular_family"]
        self.assertEqual(family["family_id"], "thinfilm_oop_ip")
        self.assertEqual(
            [variant["variant_id"] for variant in family["variants"]],
            ["ip_near_x", "oop"],
        )
        self.assertEqual(
            family["variants"][0]["orientation"],
            {"kind": "sample", "theta": 90.0, "phi": 7.5},
        )
        self.assertEqual(
            family["variants"][1]["orientation"],
            {"kind": "preset", "preset_name": "oop_positive"},
        )

    def test_study_stage_builder_hysteresis_piecewise_field_schedule(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("stage_hysteresis_piecewise_schedule")
        body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.m = fm.texture.uniform(1, 0, 0)
        study.stages.add_hysteresis_sweep(
            orientation=fm.FieldOrientation.preset("oop_positive"),
            field_schedule=fm.PiecewiseFieldSchedule.mT([
                fm.FieldSegment(
                    start=1000.0,
                    stop=200.0,
                    step=50.0,
                    segment_id="coarse_start",
                    label="coarse_start",
                    endpoint_policy="include_stop",
                    reason="far_from_remanence",
                ),
                fm.FieldSegment(
                    start=200.0,
                    stop=-50.0,
                    step=5.0,
                    segment_id="dense_after_remanence",
                    label="dense_after_remanence",
                    endpoint_policy="skip_start",
                    reason="remanence_and_coercivity",
                ),
                fm.FieldSegment(
                    start=-50.0,
                    stop=-1000.0,
                    step=25.0,
                    segment_id="negative_branch",
                    label="negative_branch",
                    endpoint_policy="skip_start",
                    reason="negative_saturation",
                ),
            ]),
        )
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_builder_stage_hysteresis_piecewise.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)

        ir = loaded.stages[0].problem.study.to_ir()
        self.assertEqual(ir["kind"], "hysteresis")
        segments = ir["field_schedule"]["segments"]
        self.assertEqual(len(segments), 3)
        self.assertEqual(segments[0]["segment_id"], "coarse_start")
        self.assertEqual(segments[0]["label"], "coarse_start")
        self.assertEqual(segments[0]["endpoint_policy"], "include_stop")
        self.assertEqual(segments[1]["step"], 5.0)
        self.assertEqual(segments[1]["segment_id"], "dense_after_remanence")
        self.assertEqual(segments[1]["reason"], "remanence_and_coercivity")

    def test_study_stage_builder_hysteresis_settle_step_time_controls_round_trip(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("stage_hysteresis_settle_time_controls")
        body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.m = fm.texture.uniform(1, 0, 0)
        study.stages.add_hysteresis_sweep(
            field_min_mT=-10.0,
            field_max_mT=10.0,
            field_step_mT=10.0,
            settle_pipeline=fm.SettlePipeline([
                fm.MinimizeStep(
                    timestep_s=2e-13,
                    max_pseudotime_s=4e-10,
                    max_steps=200,
                ),
                fm.RelaxStep(
                    timestep_s=1e-13,
                    max_pseudotime_s=2e-10,
                    max_physical_time_s=6e-10,
                    max_steps=500,
                ),
            ]),
        )
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_builder_hysteresis_settle_time_controls.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)

        steps = loaded.stages[0].problem.study.to_ir()["settle_pipeline"]["steps"]
        self.assertEqual(steps[0]["timestep_s"], 2e-13)
        self.assertEqual(steps[0]["max_pseudotime_s"], 4e-10)
        self.assertNotIn("max_physical_time_s", steps[0])
        self.assertEqual(steps[1]["timestep_s"], 1e-13)
        self.assertEqual(steps[1]["max_pseudotime_s"], 2e-10)
        self.assertEqual(steps[1]["max_physical_time_s"], 6e-10)

        rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
        self.assertIn("timestep_s=2e-13", rewritten)
        self.assertIn("max_pseudotime_s=4e-10", rewritten)
        self.assertIn("timestep_s=1e-13", rewritten)
        self.assertIn("max_pseudotime_s=2e-10", rewritten)
        self.assertIn("max_physical_time_s=6e-10", rewritten)

        with TemporaryDirectory() as tmp_dir:
            rewritten_path = Path(tmp_dir) / "rewritten_hysteresis_settle_time_controls.py"
            rewritten_path.write_text(rewritten, encoding="utf-8")
            reloaded = fm.load_problem_from_script(rewritten_path, lightweight_assets=True)

        self.assertEqual(
            reloaded.stages[0].problem.study.to_ir()["settle_pipeline"]["steps"],
            steps,
        )

    def test_hysteresis_direct_minimizer_settle_step_rejects_physical_time(self) -> None:
        with self.assertRaisesRegex(ValueError, "direct minimizer.*max_physical_time_s"):
            fm.MinimizeStep(max_physical_time_s=1e-9)

        with self.assertRaisesRegex(ValueError, "direct minimizer.*max_physical_time_s"):
            fm.RelaxStep(method="nonlinear_cg", max_physical_time_s=1e-9)

        self.assertEqual(
            fm.MinimizeStep(max_pseudotime_s=1e-9).to_ir()["max_pseudotime_s"],
            1e-9,
        )
        self.assertEqual(
            fm.RelaxStep(method="llg_overdamped", max_physical_time_s=1e-9).to_ir()[
                "max_physical_time_s"
            ],
            1e-9,
        )

    def test_study_stage_builder_hysteresis_settle_step_selection_round_trip(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("stage_hysteresis_settle_selection")
        body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.m = fm.texture.uniform(1, 0, 0)
        study.stages.add_hysteresis_sweep(
            field_min_mT=-10.0,
            field_max_mT=10.0,
            field_step_mT=10.0,
            settle_pipeline=fm.SettlePipeline([
                fm.RelaxStep(
                    applies_to="major",
                    stop_criteria=["torque_below", "max_steps"],
                    max_steps=50,
                ),
                fm.MinimizeStep(
                    applies_to=["key_events", "minor"],
                    stop_criteria={"kind": "any_of", "criteria": ["energy_delta_below", "m_delta_below"]},
                    on_non_convergence="continue_with_warning",
                    max_steps=25,
                ),
            ]),
        )
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_builder_hysteresis_settle_selection.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)

        steps = loaded.stages[0].problem.study.to_ir()["settle_pipeline"]["steps"]
        self.assertEqual(steps[0]["applies_to"], "major")
        self.assertEqual(steps[0]["stop_criteria"], ["torque_below", "max_steps"])
        self.assertEqual(steps[1]["applies_to"], ["key_events", "minor"])
        self.assertEqual(
            steps[1]["stop_criteria"],
            {"kind": "any_of", "criteria": ["energy_delta_below", "m_delta_below"]},
        )

        rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
        self.assertIn('applies_to="major"', rewritten)
        self.assertIn('stop_criteria=["torque_below", "max_steps"]', rewritten)
        self.assertIn('applies_to=["key_events", "minor"]', rewritten)
        self.assertIn('"kind": "any_of"', rewritten)
        self.assertIn('"criteria": ["energy_delta_below", "m_delta_below"]', rewritten)

        with TemporaryDirectory() as tmp_dir:
            rewritten_path = Path(tmp_dir) / "rewritten_hysteresis_settle_selection.py"
            rewritten_path.write_text(rewritten, encoding="utf-8")
            reloaded = fm.load_problem_from_script(rewritten_path, lightweight_assets=True)

        self.assertEqual(
            reloaded.stages[0].problem.study.to_ir()["settle_pipeline"]["steps"],
            steps,
        )

    def test_study_stage_builder_hysteresis_normalizes_legacy_signed_segment_step(self) -> None:
        segment = fm.FieldSegment(
            start=1000.0,
            stop=200.0,
            step=-50.0,
            label="legacy_signed_step",
        )

        self.assertEqual(segment.to_ir()["step"], 50.0)
        self.assertEqual(segment.to_ir()["segment_id"], "legacy_signed_step")

    def test_study_stage_builder_hysteresis_dense_windows(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("stage_hysteresis_dense_windows")
        body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.m = fm.texture.uniform(1, 0, 0)
        study.stages.add_hysteresis_sweep(
            field_min_mT=-150.0,
            field_max_mT=150.0,
            field_step_mT=10.0,
            schedule_refinements=[
                fm.FieldWindow(
                    center_mT=0.0,
                    half_width_mT=25.0,
                    step_mT=1.0,
                    reason="remanence",
                    priority=10,
                ),
                fm.FieldWindow(
                    center_mT=-45.0,
                    half_width_mT=10.0,
                    step_mT=0.5,
                    reason="expected_coercivity",
                    priority=20,
                ),
            ],
        )
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_builder_stage_hysteresis_windows.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)

        ir = loaded.stages[0].problem.study.to_ir()
        windows = ir["schedule_refinements"]
        self.assertEqual(windows[0]["priority"], 10)
        self.assertEqual(windows[0]["reason"], "remanence")
        self.assertEqual(windows[1]["step_mT"], 0.5)

    def test_study_stage_builder_hysteresis_adaptive_refinement_round_trip(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("stage_hysteresis_adaptive_refinement")
        body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.m = fm.texture.uniform(1, 0, 0)
        study.stages.add_hysteresis_sweep(
            field_min_mT=-150.0,
            field_max_mT=150.0,
            field_step_mT=10.0,
            adaptive_refinement=fm.AdaptiveRefinement(
                enabled=True,
                max_passes=2,
                max_insertions_per_pass=12,
                dm_dh_threshold_per_mT=0.015,
                max_step_mT=2.5,
                min_step_mT=0.25,
                include_zero_crossings=True,
                include_high_susceptibility=True,
                include_in_metrics=True,
            ),
        )
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_builder_stage_hysteresis_adaptive.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)

            rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
            self.assertIn("adaptive_refinement=fm.AdaptiveRefinement(", rewritten)
            rewritten_path = Path(tmp_dir) / "rewritten_hysteresis_adaptive.py"
            rewritten_path.write_text(rewritten, encoding="utf-8")
            reloaded = fm.load_problem_from_script(rewritten_path, lightweight_assets=True)

        ir = reloaded.stages[0].problem.study.to_ir()
        policy = ir["adaptive_refinement"]
        self.assertEqual(policy["kind"], "adaptive_refinement")
        self.assertEqual(policy["max_passes"], 2)
        self.assertEqual(policy["max_insertions_per_pass"], 12)
        self.assertEqual(policy["dm_dh_threshold_per_mT"], 0.015)
        self.assertEqual(policy["max_step_mT"], 2.5)
        self.assertEqual(policy["min_step_mT"], 0.25)
        self.assertTrue(policy["include_zero_crossings"])
        self.assertTrue(policy["include_high_susceptibility"])
        self.assertTrue(policy["include_in_metrics"])

    def test_study_stage_builder_hysteresis_angular_family_round_trip(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("stage_hysteresis_angular_family")
        body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.m = fm.texture.uniform(1, 0, 0)
        study.stages.add_hysteresis_sweep(
            field_values_mT=[50.0, 0.0, -50.0],
            orientation=fm.FieldOrientation.preset("oop_positive"),
            angular_family=fm.HysteresisAngularFamily(
                family_id="oop_ip_family",
                label="OOP/IP family",
                variants=[
                    fm.HysteresisAngularVariant(
                        variant_id="oop",
                        label="OOP",
                        orientation=fm.FieldOrientation.preset("oop_positive"),
                        measurement_axis="field_axis",
                    ),
                    fm.HysteresisAngularVariant(
                        variant_id="ip35",
                        orientation=fm.FieldOrientation.sample(theta_deg=90.0, phi_deg=35.0),
                        measurement_axis=fm.MeasurementAxis.custom((1.0, 1.0, 0.0)),
                    ),
                ],
            ),
        )
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_builder_stage_hysteresis_angular_family.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)

            rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
            self.assertIn("angular_family=fm.HysteresisAngularFamily(", rewritten)
            self.assertIn("fm.HysteresisAngularVariant(", rewritten)
            rewritten_path = Path(tmp_dir) / "rewritten_hysteresis_angular_family.py"
            rewritten_path.write_text(rewritten, encoding="utf-8")
            reloaded = fm.load_problem_from_script(rewritten_path, lightweight_assets=True)

        family = reloaded.stages[0].problem.study.to_ir()["angular_family"]
        self.assertEqual(family["kind"], "angular_family")
        self.assertEqual(family["family_id"], "oop_ip_family")
        self.assertEqual(len(family["variants"]), 2)
        self.assertEqual(family["variants"][0]["variant_id"], "oop")
        self.assertEqual(
            family["variants"][1]["measurement_axis"],
            {"kind": "custom", "vector": [1.0, 1.0, 0.0]},
        )

    def test_study_stage_builder_hysteresis_minor_loops_contract(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("stage_hysteresis_minor_loops")
        body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.m = fm.texture.uniform(1, 0, 0)
        study.stages.add_hysteresis_sweep(
            field_min_mT=-100.0,
            field_max_mT=100.0,
            field_step_mT=10.0,
            branch_mode="major_with_minor_loops",
            minor_loops=[
                fm.MinorLoop(
                    reversal_mT=25.0,
                    return_mT=-25.0,
                    continuation_policy="resume_parent",
                ),
                fm.MinorLoop(
                    reversal_mT=50.0,
                    return_mT=-50.0,
                    continuation_policy="replace_parent",
                ),
                fm.MinorLoop(
                    reversal_mT=-50.0,
                    intermediate_fields_mT=[0.0],
                    return_mT=50.0,
                ),
            ],
        )
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_builder_stage_hysteresis_minor_loops.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)

        ir = loaded.stages[0].problem.study.to_ir()
        self.assertEqual(ir["branch_mode"], "major_with_minor_loops")
        self.assertEqual(len(ir["minor_loops"]), 3)
        self.assertEqual(ir["minor_loops"][0]["reversal_mT"], 25.0)
        self.assertEqual(ir["minor_loops"][0]["return_mT"], -25.0)
        self.assertEqual(ir["minor_loops"][0]["continuation_policy"], "resume_parent")
        self.assertEqual(ir["minor_loops"][1]["continuation_policy"], "replace_parent")
        self.assertEqual(ir["minor_loops"][2]["continuation_policy"], "branch_only")
        self.assertEqual(ir["minor_loops"][2]["intermediate_fields_mT"], [0.0])

        rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
        self.assertIn('branch_mode="major_with_minor_loops"', rewritten)
        self.assertIn("minor_loops=[", rewritten)
        self.assertIn("fm.MinorLoop(", rewritten)
        self.assertIn('continuation_policy="resume_parent"', rewritten)
        self.assertIn('continuation_policy="replace_parent"', rewritten)
        self.assertIn("intermediate_fields_mT=[0]", rewritten)

        with TemporaryDirectory() as tmp_dir:
            rewritten_path = Path(tmp_dir) / "rewritten_hysteresis_minor_loops.py"
            rewritten_path.write_text(rewritten, encoding="utf-8")
            reloaded = fm.load_problem_from_script(rewritten_path, lightweight_assets=True)

        reloaded_ir = reloaded.stages[0].problem.study.to_ir()
        self.assertEqual(reloaded_ir["branch_mode"], "major_with_minor_loops")
        self.assertEqual(reloaded_ir["minor_loops"], ir["minor_loops"])

    def test_hysteresis_minor_loop_rejects_unknown_continuation_policy(self) -> None:
        with self.assertRaisesRegex(
            ValueError,
            "MinorLoop.continuation_policy must be one of",
        ):
            fm.MinorLoop(
                reversal_mT=25.0,
                return_mT=-25.0,
                continuation_policy="teleport_parent",
            )

    def test_study_stage_builder_hysteresis_rejects_invalid_schedule(self) -> None:
        with self.assertRaisesRegex(ValueError, "FieldSegment.step must not be zero"):
            fm.FieldSegment(start=100.0, stop=0.0, step=0.0)

        descending = fm.FieldSegment(
            start=100.0,
            stop=0.0,
            step=5.0,
            segment_id="descending",
        )
        self.assertEqual(descending.to_ir()["step"], 5.0)

        with self.assertRaisesRegex(ValueError, "FieldSegment.segment_id is required"):
            fm.FieldSegment(start=100.0, stop=0.0, step=5.0)

        with self.assertRaisesRegex(ValueError, "FieldWindow.step_mT must be positive"):
            fm.FieldWindow(center_mT=0.0, half_width_mT=25.0, step_mT=0.0)

        with self.assertRaisesRegex(ValueError, "overlapping FieldWindow"):
            fm.PiecewiseFieldSchedule.dense_windows([
                fm.FieldWindow(center_mT=0.0, half_width_mT=10.0, step_mT=1.0),
                fm.FieldWindow(center_mT=5.0, half_width_mT=10.0, step_mT=0.5),
            ])

    def test_study_stage_builder_hysteresis_rejects_invalid_settle_pipeline(self) -> None:
        with self.assertRaisesRegex(ValueError, "SettlePipeline requires at least one step"):
            fm.SettlePipeline([])

        with self.assertRaisesRegex(ValueError, "run_next_algorithm requires a following step"):
            fm.SettlePipeline([
                fm.MinimizeStep(on_non_convergence="run_next_algorithm"),
            ])

        with self.assertRaisesRegex(ValueError, "run_next_algorithm requires a non_converged fallback branch"):
            fm.SettleTree(
                default=fm.MinimizeStep(on_non_convergence="run_next_algorithm"),
                branches=[],
            )

        with self.assertRaisesRegex(ValueError, "retry_with_smaller_dt requires retry_timestep_scale"):
            fm.RelaxStep(on_non_convergence="retry_with_smaller_dt")

        with self.assertRaisesRegex(ValueError, "retry_timestep_scale must be smaller than 1.0"):
            fm.RelaxStep(
                on_non_convergence="retry_with_smaller_dt",
                retry_timestep_scale=1.0,
            )

        with self.assertRaisesRegex(ValueError, "timestep_s must be positive"):
            fm.RelaxStep(timestep_s=0.0)

        with self.assertRaisesRegex(ValueError, "max_pseudotime_s must be positive"):
            fm.MinimizeStep(max_pseudotime_s=-1.0)

        with self.assertRaisesRegex(ValueError, "max_physical_time_s must be positive"):
            fm.DynamicsSettleStep(max_physical_time_s=0.0)

        with self.assertRaisesRegex(ValueError, "DynamicsSettleStep stop_criteria"):
            fm.DynamicsSettleStep(stop_criteria="torque_below")

        with self.assertRaisesRegex(ValueError, "applies_to must be one of"):
            fm.RelaxStep(applies_to="branch_id")

        with self.assertRaisesRegex(ValueError, "applies_to.point_ids"):
            fm.RelaxStep(applies_to={"kind": "point_selector"})

        branch_step = fm.RelaxStep(
            applies_to={"kind": "branch_id", "branch_id": "descending"}
        )
        self.assertEqual(
            branch_step.to_ir()["applies_to"],
            {"kind": "branch_id", "branch_id": "descending"},
        )
        self.assertEqual(
            fm.RelaxStep(applies_to="major_descending").to_ir()["applies_to"],
            "major_descending",
        )

        with self.assertRaisesRegex(ValueError, "max_steps must be positive"):
            fm.RelaxStep(max_steps=0)

        retry_step = fm.RelaxStep(
            on_non_convergence="retry_with_smaller_dt",
            retry_timestep_scale=0.5,
            retry_max_attempts=2,
        )
        self.assertEqual(retry_step.to_ir()["retry_timestep_scale"], 0.5)
        self.assertEqual(retry_step.to_ir()["retry_max_attempts"], 2)

    def test_study_stage_builder_hysteresis_rejects_invalid_public_contract_values(self) -> None:
        with self.assertRaisesRegex(ValueError, "FieldOrientation preset must be one of"):
            fm.FieldOrientation.preset("unsupported_axis")

        with self.assertRaisesRegex(ValueError, "FieldOrientation.sample theta_deg and phi_deg"):
            fm.FieldOrientation.sample(float("nan"), 0.0)

        with self.assertRaisesRegex(ValueError, "FieldOrientation.vector must not be the zero vector"):
            fm.FieldOrientation.global_vector((0.0, 0.0, 0.0))

        with self.assertRaisesRegex(ValueError, "SaturationProbe.max_field_mT"):
            fm.SaturationProbe(max_field_mT=float("nan"))

        self.assertEqual(
            fm.SaturationProbe().to_ir()["on_failure"],
            "continue_with_warning",
        )

        with self.assertRaisesRegex(ValueError, "SaturationProbe.on_failure"):
            fm.SaturationProbe(on_failure="pretend_saturated")

        with self.assertRaisesRegex(ValueError, "HysteresisStorage.magnetization"):
            fm.HysteresisStorage(magnetization="sometimes")

        with self.assertRaisesRegex(ValueError, "HysteresisStorage.every_n must be positive"):
            fm.HysteresisStorage(magnetization="selected", every_n=0)

        with self.assertRaisesRegex(ValueError, "HysteresisStorage.every_n must be positive"):
            fm.HysteresisStorage(magnetization="every_n", every_n=0)

        with self.assertRaisesRegex(ValueError, "field_min_mT must be finite"):
            fm.Hysteresis(outputs=[], field_min_mT=float("nan"))

        with self.assertRaisesRegex(ValueError, "measurement_axis must be one of"):
            fm.Hysteresis(outputs=[], measurement_axis="sideways")

        with self.assertRaisesRegex(ValueError, "fm.MeasurementAxis.custom"):
            fm.Hysteresis(outputs=[], measurement_axis="custom")

        with self.assertRaisesRegex(ValueError, "MeasurementAxis.vector must not be the zero vector"):
            fm.MeasurementAxis.custom((0.0, 0.0, 0.0))

        with self.assertRaisesRegex(ValueError, "HysteresisAngularFamily.variants must not be empty"):
            fm.HysteresisAngularFamily(variants=[])

        with self.assertRaisesRegex(ValueError, "variant_id values must be unique"):
            fm.HysteresisAngularFamily(
                variants=[
                    fm.HysteresisAngularVariant(
                        "dup",
                        fm.FieldOrientation.preset("oop_positive"),
                    ),
                    fm.HysteresisAngularVariant(
                        "dup",
                        fm.FieldOrientation.preset("in_plane_x"),
                    ),
                ]
            )

        with self.assertRaisesRegex(ValueError, "branch_mode must be one of"):
            fm.Hysteresis(outputs=[], branch_mode="minor_loop")

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
            timestep=1e-15,
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
            loaded.stages[0].problem.study.to_ir()["dynamics"]["fixed_timestep"],
            1e-15,
        )
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
        fm.relax(max_steps=25, tolA=1e-5, algorithm="llg_overdamped")
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

        self.assertIn('fm.relax(algorithm="nonlinear_cg", tolA=2e-06, max_steps=250, energy_tolerance=3e-12)', rewritten)
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
        self.assertIn('bc=fm.FloquetBC(["x_periodic"])', rewritten)

    def test_study_stage_preserves_floquet_k_path_demag_intent(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("floquet_k_path_demag_intent")
        study.engine("fem")
        study.device("cpu", precision="double")
        body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        study.pbc(x=True)
        study.save("spectrum")
        study.save("dispersion")
        study.stages.add_eigenmodes(
            count=2,
            operator="full_2x2",
            include_demag=True,
            k_sampling=fm.KPath(
                points=[
                    fm.KPoint("G", (0.0, 0.0, 0.0)),
                    fm.KPoint("X", (2.0e7, 0.0, 0.0)),
                ],
                samples_per_segment=[2],
            ),
            bc=fm.FloquetBC(["x_faces"]),
        )
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "floquet_k_path_demag_intent.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)

        study_ir = loaded.stages[0].problem.study.to_ir()
        self.assertEqual(study_ir["operator"], {
            "kind": "full_2x2",
            "include_demag": True,
        })
        self.assertEqual(
            study_ir["k_sampling"],
            {
                "kind": "path",
                "points": [
                    {"label": "G", "k_vector": [0.0, 0.0, 0.0]},
                    {"label": "X", "k_vector": [2.0e7, 0.0, 0.0]},
                ],
                "samples_per_segment": [2],
                "closed": False,
            },
        )
        self.assertEqual(
            study_ir["spin_wave_bc"],
            {
                "kind": "floquet",
                "pair_ids": ["x_faces"],
                "phase_convention": "exp_minus_i_k_dot_delta_r",
            },
        )

        draft = export_builder_draft(loaded)
        stage = draft["stages"][0]
        self.assertEqual(stage["eigen_include_demag"], True)
        self.assertEqual(stage["eigen_k_path"], "G:0,0,0; X:20000000,0,0 | samples=2")
        self.assertEqual(stage["eigen_spin_wave_bc"], "floquet")

        rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
        self.assertIn("include_demag=True", rewritten)
        self.assertIn("k_sampling=fm.KPath", rewritten)
        self.assertIn('bc=fm.FloquetBC(["x_faces"])', rewritten)

    def test_study_dispersion_validation_lowers_to_runtime_metadata(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("low_k_de_bv_validation")
        study.engine("fem")
        study.device("cpu", precision="double")
        body = study.geometry(fm.Box(size=(80e-9, 40e-9, 10e-9), name="film"), name="film")
        body.Ms = 140e3
        body.Aex = 3.5e-12
        body.alpha = 0.001
        body.m = fm.texture.uniform(1, 0, 0)
        study.pbc(x=True, y=True)
        study.save("spectrum")
        study.save("dispersion")
        study.dispersion_validation(
            fm.ThinFilmDEBVDispersionValidation(
                film_thickness_m=80e-9,
                equilibrium_magnetization=(1.0, 0.0, 0.0),
                film_normal=(0.0, 0.0, 1.0),
                frequency_window_hz=(0.0, 5.0e9),
                max_k_rad_per_m=3.0e6,
                scenarios=[
                    fm.DispersionValidationScenario("backward_volume", "branch_0", [0, 1, 2]),
                    fm.DispersionValidationScenario("damon_eshbach", "branch_0", [0, 3, 4]),
                ],
            )
        )
        study.stages.add_eigenmodes(
            count=1,
            target="frequency_window",
            frequency_min=1.0e6,
            frequency_max=5.0e9,
            operator="full_2x2",
            include_demag=True,
            equilibrium_source="provided",
            k_sampling=fm.KPath(
                points=[
                    fm.KPoint("G", (0.0, 0.0, 0.0)),
                    fm.KPoint("BV", (3.0e6, 0.0, 0.0)),
                    fm.KPoint("G", (0.0, 0.0, 0.0)),
                    fm.KPoint("DE", (0.0, 3.0e6, 0.0)),
                ],
                samples_per_segment=[2, 1, 2],
            ),
            bc=fm.FloquetBC(["x_faces", "y_faces"]),
        )
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "low_k_de_bv_validation.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)

        metadata = loaded.problem.runtime_metadata["dispersion_validation"]
        self.assertEqual(metadata["kind"], "thin_film_de_bv_low_k")
        self.assertEqual(metadata["analytic_model"], "kalinikos_slab_n0")
        self.assertEqual(metadata["film_thickness_m"], 80e-9)
        self.assertEqual(metadata["equilibrium_magnetization"], [1.0, 0.0, 0.0])
        self.assertEqual(metadata["film_normal"], [0.0, 0.0, 1.0])
        self.assertEqual(metadata["frequency_window_hz"], {"min": 0.0, "max": 5.0e9})
        self.assertEqual(metadata["max_k_rad_per_m"], 3.0e6)
        self.assertEqual(
            {scenario["geometry"] for scenario in metadata["scenarios"]},
            {"backward_volume", "damon_eshbach"},
        )

    def test_thin_film_de_bv_dispersion_validation_rejects_broad_k_range(self) -> None:
        with self.assertRaisesRegex(ValueError, "max_k_rad_per_m"):
            fm.ThinFilmDEBVDispersionValidation(
                film_thickness_m=80e-9,
                equilibrium_magnetization=(1.0, 0.0, 0.0),
                scenarios=[
                    fm.DispersionValidationScenario("bv", "branch_0", [0, 1, 2]),
                    fm.DispersionValidationScenario("de", "branch_0", [0, 3, 4]),
                ],
                max_k_rad_per_m=4.0e6,
            )

    def test_study_k0_kittel_validation_lowers_to_runtime_metadata(self) -> None:
        script = """
        import math
        import fullmag as fm

        mu0 = 4.0e-7 * math.pi

        study = fm.study("k0_kittel_validation")
        study.engine("fem")
        study.device("cpu", precision="double")
        body = study.geometry(fm.Box(size=(80e-9, 40e-9, 10e-9), name="film"), name="film")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.001
        body.m = fm.texture.uniform(1, 0, 0)
        study.save("spectrum")
        study.k0_kittel_validation(
            fm.K0KittelFieldSweepValidation(
                model="thin_film_in_plane",
                effective_magnetisation=800e3,
                samples=[
                    fm.K0KittelFieldSample(0, (20e-3 / mu0, 0.0, 0.0)),
                    fm.K0KittelFieldSample(1, (50e-3 / mu0, 0.0, 0.0)),
                    fm.K0KittelFieldSample(2, (100e-3 / mu0, 0.0, 0.0)),
                ],
            )
        )
        study.stages.add_eigenmodes(
            count=1,
            target="frequency_window",
            frequency_min=1.0e6,
            frequency_max=5.0e9,
            operator="full_2x2",
            include_demag=True,
            equilibrium_source="provided",
            k_sampling=fm.KPath(
                points=[
                    fm.KPoint("B20mT", (0.0, 0.0, 0.0)),
                    fm.KPoint("B100mT", (0.0, 0.0, 0.0)),
                ],
                samples_per_segment=[2],
            ),
            bc="free",
        )
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "k0_kittel_validation.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)

        metadata = loaded.problem.runtime_metadata["k0_kittel_validation"]
        self.assertEqual(metadata["kind"], "k0_kittel_field_sweep")
        self.assertEqual(metadata["model"], "thin_film_in_plane")
        self.assertEqual(metadata["field_units"], "A_per_m")
        self.assertEqual(metadata["relative_tolerance"], 0.05)
        self.assertEqual(metadata["material"]["effective_magnetisation"], 800e3)
        self.assertEqual(len(metadata["samples"]), 3)
        self.assertEqual(metadata["samples"][0]["sample_index"], 0)
        self.assertEqual(metadata["samples"][0]["bias_field"][1:], [0.0, 0.0])

    def test_k0_kittel_validation_rejects_too_few_samples(self) -> None:
        with self.assertRaisesRegex(ValueError, "at least three"):
            fm.K0KittelFieldSweepValidation(
                samples=[
                    fm.K0KittelFieldSample(0, (1.0, 0.0, 0.0)),
                    fm.K0KittelFieldSample(1, (2.0, 0.0, 0.0)),
                ],
            )

    def test_k0_kittel_validation_accepts_public_periodic_airbox_demag(self) -> None:
        validation = fm.K0KittelFieldSweepValidation(
            case_id="K0-3",
            model="thin_film_in_plane",
            effective_magnetisation=800e3,
            demag_kind="periodic_airbox_k0",
            samples=[
                fm.K0KittelFieldSample(0, (1.0, 0.0, 0.0)),
                fm.K0KittelFieldSample(1, (2.0, 0.0, 0.0)),
                fm.K0KittelFieldSample(2, (3.0, 0.0, 0.0)),
            ],
        )

        self.assertEqual(validation.to_ir()["demag_kind"], "periodic_airbox_k0")

    def test_k0_kittel_zeeman_no_demag_example_loads_validation_contract(self) -> None:
        loaded = fm.load_problem_from_script(
            Path(__file__).resolve().parents[3]
            / "examples"
            / "fem_eigen_k0_kittel_zeeman_no_demag.py",
            lightweight_assets=True,
        )

        metadata = loaded.problem.runtime_metadata["k0_kittel_validation"]
        self.assertEqual(metadata["kind"], "k0_kittel_field_sweep")
        self.assertEqual(metadata["model"], "macrospin_larmor")
        self.assertEqual(metadata["field_units"], "A_per_m")
        self.assertEqual(metadata["material"], {})
        samples = metadata["samples"]
        self.assertGreaterEqual(len(samples), 5)
        for sample in samples:
            bias_field = sample["bias_field"]
            self.assertEqual(len(bias_field), 3)
            self.assertGreater(sum(component * component for component in bias_field), 0.0)
            self.assertEqual(bias_field[1:], [0.0, 0.0])

    def test_k0_kittel_thinfilm_demag_example_loads_k0_3_contract(self) -> None:
        loaded = fm.load_problem_from_script(
            Path(__file__).resolve().parents[3]
            / "examples"
            / "fem_eigen_k0_kittel_thinfilm_demag.py",
            lightweight_assets=True,
        )

        metadata = loaded.problem.runtime_metadata["k0_kittel_validation"]
        self.assertEqual(metadata["kind"], "k0_kittel_field_sweep")
        self.assertEqual(metadata["case_id"], "K0-3")
        self.assertEqual(metadata["demag_kind"], "synthetic_demag_factor")
        self.assertEqual(metadata["model"], "thin_film_in_plane")
        self.assertEqual(metadata["relative_tolerance"], 0.02)
        self.assertEqual(metadata["material"]["effective_magnetisation"], 800e3)
        samples = metadata["samples"]
        self.assertGreaterEqual(len(samples), 5)
        for sample in samples:
            bias_field = sample["bias_field"]
            self.assertEqual(len(bias_field), 3)
            self.assertGreater(sum(component * component for component in bias_field), 0.0)
            self.assertEqual(bias_field[1:], [0.0, 0.0])

    def test_k0_kittel_periodic_airbox_example_loads_k0_3b_contract(self) -> None:
        loaded = fm.load_problem_from_script(
            Path(__file__).resolve().parents[3]
            / "examples"
            / "fem_eigen_k0_kittel_periodic_airbox.py",
            lightweight_assets=True,
        )

        metadata = loaded.problem.runtime_metadata["k0_kittel_validation"]
        self.assertEqual(metadata["kind"], "k0_kittel_field_sweep")
        self.assertEqual(metadata["case_id"], "K0-3")
        self.assertEqual(metadata["demag_kind"], "periodic_airbox_k0")
        self.assertEqual(metadata["model"], "thin_film_in_plane")
        self.assertEqual(metadata["material"]["effective_magnetisation"], 800e3)
        self.assertEqual(
            loaded.stages[0].problem.study.to_ir()["dynamics"]["fixed_timestep"],
            1e-15,
        )

    def test_script_rewrite_preserves_windowed_dispersion_k_path(self) -> None:
        loaded = fm.load_problem_from_script(
            Path(__file__).resolve().parents[3]
            / "examples"
            / "fem_eigenmodes_dispersion_window_k_path.py",
            lightweight_assets=True,
        )

        rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]

        self.assertIn('target="frequency_window"', rewritten)
        self.assertIn("frequency_min=1000000000", rewritten)
        self.assertIn("frequency_max=3000000000", rewritten)
        self.assertIn('operator="full_2x2"', rewritten)
        self.assertIn("include_demag=False", rewritten)
        self.assertIn("k_sampling=fm.KPath", rewritten)
        self.assertIn('fm.KPoint("G", (0, 0, 0))', rewritten)
        self.assertIn('fm.KPoint("X", (2000000, 0, 0))', rewritten)
        self.assertIn('fm.KPoint("-X", (-2000000, 0, 0))', rewritten)
        self.assertIn("samples_per_segment=[1, 1, 1]", rewritten)
        self.assertIn('bc=fm.FloquetBC(["x_faces"])', rewritten)

    def test_builder_draft_preserves_windowed_dispersion_k_path(self) -> None:
        loaded = fm.load_problem_from_script(
            Path(__file__).resolve().parents[3]
            / "examples"
            / "fem_eigenmodes_dispersion_window_k_path.py",
            lightweight_assets=True,
        )

        draft = export_builder_draft(loaded)
        stage = draft["stages"][0]

        self.assertEqual(stage["kind"], "eigenmodes")
        self.assertEqual(stage["eigen_target"], "frequency_window")
        self.assertEqual(stage["eigen_frequency_min"], "1000000000")
        self.assertEqual(stage["eigen_frequency_max"], "3000000000")
        self.assertEqual(stage["eigen_operator"], "full_2x2")
        self.assertEqual(stage["eigen_include_demag"], False)
        self.assertEqual(
            stage["eigen_k_path"],
            "G:0,0,0; X:2000000,0,0; G:0,0,0; -X:-2000000,0,0 | samples=1,1,1",
        )
        self.assertEqual(stage["eigen_spin_wave_bc"], "floquet")
        self.assertEqual(
            stage["eigen_spin_wave_bc_config"],
            {
                "kind": "floquet",
                "pair_ids": ["x_faces"],
                "phase_convention": "exp_minus_i_k_dot_delta_r",
            },
        )

    def test_windowed_dispersion_closed_k_path_round_trips_through_builder_text(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("closed_dispersion_k_path")
        study.engine("fem")
        study.device("cpu", precision="double")
        body = study.geometry(fm.Box(40e-9, 20e-9, 10e-9), name="body")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.02
        body.m = fm.texture.uniform(1, 0, 0)
        study.pbc(x=True)
        study.save("spectrum")
        study.save("dispersion")
        study.stages.add_eigenmodes(
            count=2,
            target="frequency_window",
            frequency_min=1.0e9,
            frequency_max=3.0e9,
            operator="full_2x2",
            include_demag=False,
            k_sampling=fm.KPath(
                points=[
                    fm.KPoint("G", (0.0, 0.0, 0.0)),
                    fm.KPoint("X", (2.0e7, 0.0, 0.0)),
                    fm.KPoint("M", (2.0e7, 2.0e7, 0.0)),
                ],
                samples_per_segment=[2, 3, 4],
                closed=True,
            ),
            bc=fm.FloquetBC(["x_faces"]),
        )
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "closed_dispersion_k_path.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)

        study_ir = loaded.stages[0].problem.study.to_ir()
        self.assertEqual(study_ir["target"]["kind"], "frequency_window")
        self.assertEqual(study_ir["sampling"]["outputs"][1]["kind"], "dispersion_curve")
        self.assertEqual(
            study_ir["k_sampling"],
            {
                "kind": "path",
                "points": [
                    {"label": "G", "k_vector": [0.0, 0.0, 0.0]},
                    {"label": "X", "k_vector": [2.0e7, 0.0, 0.0]},
                    {"label": "M", "k_vector": [2.0e7, 2.0e7, 0.0]},
                ],
                "samples_per_segment": [2, 3, 4],
                "closed": True,
            },
        )

        draft = export_builder_draft(loaded)
        stage = draft["stages"][0]
        self.assertEqual(
            stage["eigen_k_path"],
            "G:0,0,0; X:20000000,0,0; M:20000000,20000000,0 | samples=2,3,4; closed=true",
        )

        rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
        self.assertIn("samples_per_segment=[2, 3, 4], closed=True", rewritten)

    def test_script_rewrite_applies_windowed_dispersion_builder_text_overrides(self) -> None:
        loaded = fm.load_problem_from_script(
            Path(__file__).resolve().parents[3]
            / "examples"
            / "fem_eigenmodes_dispersion_window_k_path.py",
            lightweight_assets=True,
        )
        draft = export_builder_draft(loaded)
        stage = dict(draft["stages"][0])
        stage.update(
            {
                "eigen_count": "3",
                "eigen_frequency_min": "1.5e9",
                "eigen_frequency_max": "2.5e9",
                "eigen_k_path": "G:0,0,0; X:1e7,0,0; G:0,0,0 | samples=2,2",
            }
        )

        rewritten = rewrite_loaded_problem_script(
            loaded,
            overrides={"stages": [stage]},
        )["rendered_source"]

        self.assertIn("count=3", rewritten)
        self.assertIn("frequency_min=1500000000", rewritten)
        self.assertIn("frequency_max=2500000000", rewritten)
        self.assertIn('fm.KPoint("X", (10000000, 0, 0))', rewritten)
        self.assertIn("samples_per_segment=[2, 2]", rewritten)

    def test_scene_document_overrides_preserve_windowed_dispersion_authoring(self) -> None:
        loaded = fm.load_problem_from_script(
            Path(__file__).resolve().parents[3]
            / "examples"
            / "fem_eigenmodes_dispersion_window_k_path.py",
            lightweight_assets=True,
        )
        draft = export_builder_draft(loaded)
        stage = dict(draft["stages"][0])
        stage.update(
            {
                "eigen_count": "3",
                "eigen_frequency_min": "1.5e9",
                "eigen_frequency_max": "2.5e9",
                "eigen_operator": "full_2x2",
                "eigen_k_path": "G:0,0,0; X:1e7,0,0; G:0,0,0 | samples=2,2",
            }
        )
        draft["stages"] = [stage]
        draft["study_pipeline"]["nodes"][0]["payload"] = stage

        scene = build_scene_document_from_builder(draft)
        overrides = builder_overrides_from_scene_document(scene)
        rewritten = rewrite_loaded_problem_script(loaded, overrides=overrides)["rendered_source"]

        self.assertIn("count=3", rewritten)
        self.assertIn("frequency_min=1500000000", rewritten)
        self.assertIn("frequency_max=2500000000", rewritten)
        self.assertIn('operator="full_2x2"', rewritten)
        self.assertIn('fm.KPoint("X", (10000000, 0, 0))', rewritten)
        self.assertIn("samples_per_segment=[2, 2]", rewritten)

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
                    max_relaxation_time_s=4e-12,
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
        self.assertEqual(ir["study"]["stop"]["max_relaxation_time_s"], 4e-12)
        self.assertNotIn("max_pseudotime_s", ir["study"]["stop"])
        self.assertNotIn("max_physical_time_s", ir["study"]["stop"])
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
        self.assertIn("fm.solver(fix_dt=2e-13, demag_interval_s=8e-13)", rewritten)
        self.assertIn(
            'fm.relax(algorithm="llg_overdamped", tolT=1.25663706144e-11, stop=fm.RelaxStop(torque_tolerance_apm=1e-05, max_steps=50000, max_relaxation_time_s=4e-12))',
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
        fm.relax(tolA=1e-4, max_steps=250)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_flat_relax.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path)

        self.assertEqual(loaded.entrypoint_kind, "flat_relax")
        self.assertIsNone(loaded.default_until_seconds)
        self.assertEqual(loaded.problem.study.to_ir()["kind"], "relaxation")
        self.assertEqual(loaded.problem.study.torque_tolerance_unit, "A/m")
        dynamics = loaded.problem.study.to_ir()["dynamics"]
        self.assertEqual(dynamics["integrator"], "rk23")
        self.assertIsNone(dynamics["fixed_timestep"])

    def test_relax_stage_normalizes_default_tesla_and_explicit_ampere_tolerances(self) -> None:
        expected_apm = 1e-6 / (4.0e-7 * math.pi)

        default = fm.relax_stage(max_steps=20, dt=1e-15)
        tesla = fm.relax_stage(tolT=1e-6, max_steps=20, dt=1e-15)
        ampere = fm.relax_stage(tolA=expected_apm, max_steps=20, dt=1e-15)

        self.assertAlmostEqual(default.stop.torque_tolerance_apm, expected_apm)
        self.assertAlmostEqual(tesla.stop.torque_tolerance_apm, expected_apm)
        self.assertAlmostEqual(ampere.stop.torque_tolerance_apm, expected_apm)
        self.assertEqual(default.tol_unit, "T")
        self.assertEqual(tesla.tol_unit, "T")
        self.assertEqual(ampere.tol_unit, "A/m")

    def test_relax_stage_rejects_legacy_and_ambiguous_tolerance_keywords(self) -> None:
        with self.assertRaisesRegex(ValueError, "tolT or tolA"):
            fm.relax_stage(tol=1e-4, max_steps=20, dt=1e-15)
        with self.assertRaisesRegex(ValueError, "only one"):
            fm.relax_stage(tolT=1e-6, tolA=1.0, max_steps=20, dt=1e-15)

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

    def test_flat_solver_dt_min_lowers_to_adaptive_timestep(self) -> None:
        script = """
        import fullmag as fm

        fm.engine("fdm")
        fm.cell(5e-9, 5e-9, 5e-9)
        body = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        fm.solver(dt=2e-15, max_error=1e-6, dt_min=1e-17, integrator="rk23")
        fm.save("m", every=1e-12)
        fm.run(2.5e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_flat_adaptive_solver_dt_min.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path)

        adaptive_timestep = loaded.problem.study.to_ir()["dynamics"]["adaptive_timestep"]
        self.assertEqual(adaptive_timestep["atol"], 1e-6)
        self.assertEqual(adaptive_timestep["dt_initial"], 2e-15)
        self.assertEqual(adaptive_timestep["dt_min"], 1e-17)

    def test_staged_relax_dt_min_lowers_to_adaptive_timestep(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("staged_relax_dt_min")
        study.engine("fem")
        body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        body.mesh(maximum_element_size=5e-9, order=1).build()
        study.stages.add_relax(
            solver="rk45",
            max_error=1e-4,
            dt_min=1e-17,
            dt_max=1e-15,
            max_steps=5,
        )
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_staged_relax_dt_min.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path)

        dynamics = loaded.stages[0].problem.study.to_ir()["dynamics"]
        self.assertEqual(dynamics["integrator"], "rk45")
        self.assertEqual(dynamics["adaptive_timestep"]["atol"], 1e-4)
        self.assertEqual(dynamics["adaptive_timestep"]["dt_min"], 1e-17)
        self.assertEqual(dynamics["adaptive_timestep"]["dt_max"], 1e-15)

    def test_staged_relax_dt_max_lowers_to_adaptive_timestep(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("staged_relax_dt_max")
        study.engine("fem")
        body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        body.mesh(maximum_element_size=5e-9, order=1).build()
        study.stages.add_relax(
            solver="rk45",
            max_error=1e-6,
            dt_min=1e-17,
            dt_max=1e-15,
            max_steps=5,
        )
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_staged_relax_dt_max.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path)

        dynamics = loaded.stages[0].problem.study.to_ir()["dynamics"]
        self.assertEqual(dynamics["integrator"], "rk45")
        self.assertEqual(dynamics["adaptive_timestep"]["atol"], 1e-6)
        self.assertEqual(dynamics["adaptive_timestep"]["dt_min"], 1e-17)
        self.assertEqual(dynamics["adaptive_timestep"]["dt_max"], 1e-15)

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
            edge_transition_distance=11e-9,
            corner_maximum_element_size=3e-9,
            corner_extent=8e-9,
            corner_transition_distance=7e-9,
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
        self.assertEqual(mesh_entry["edge_transition_distance"], "1.1e-08")
        self.assertEqual(mesh_entry["corner_maximum_element_size"], "3e-09")
        self.assertEqual(mesh_entry["corner_extent"], "8e-09")
        self.assertEqual(mesh_entry["corner_transition_distance"], "7e-09")

        rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
        self.assertIn("edge_maximum_element_size=5e-09", rewritten)
        self.assertIn("edge_thickness=9e-09", rewritten)
        self.assertIn("edge_transition_distance=1.1e-08", rewritten)
        self.assertIn("corner_maximum_element_size=3e-09", rewritten)
        self.assertIn("corner_extent=8e-09", rewritten)
        self.assertIn("corner_transition_distance=7e-09", rewritten)

    def test_study_mesh_builder_exports_thin_film_method_metadata(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("thin_film_mesh_method")
        study.engine("fem")
        study.objects.mesh.defaults(maximum_element_size=80e-9)

        body = study.geometry(fm.Box(100e-9, 40e-9, 2e-9), name="body")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        body.mesh.thin_film(
            maximum_element_size=20e-9,
            minimum_element_size=2e-9,
            interface_maximum_element_size=16e-9,
            interface_thickness=10e-9,
            transition_distance=80e-9,
            edge_maximum_element_size=2e-9,
            edge_thickness=2e-9,
            edge_transition_distance=30e-9,
            corner_maximum_element_size=2e-9,
            corner_extent=2e-9,
            corner_transition_distance=20e-9,
            layers=1,
        )

        study.run(1e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_study_thin_film_mesh.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            with patch("fullmag.world.build_geometry_assets_for_request", return_value=None):
                loaded = fm.load_problem_from_script(path)

        mesh_entry = export_builder_draft(loaded)["geometries"][0]["mesh"]
        self.assertEqual(mesh_entry["mesh_strategy"], "thin_film_tetrahedral")
        self.assertEqual(mesh_entry["through_thickness_elements"], 1)
        self.assertEqual(mesh_entry["interface_maximum_element_size"], "1.6e-08")
        self.assertEqual(mesh_entry["edge_maximum_element_size"], "2e-09")
        self.assertEqual(mesh_entry["corner_transition_distance"], "2e-08")

        rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
        self.assertIn("body.mesh.thin_film(", rewritten)
        self.assertIn("layers=1", rewritten)
        self.assertIn("edge_transition_distance=3e-08", rewritten)
        self.assertIn("corner_transition_distance=2e-08", rewritten)

    def test_mixed_p1_publication_example_lowers_complete_mesh_entry_to_problem_ir(self) -> None:
        script = """
        import fullmag as fm

        fm.reset()
        study = fm.study("mixed-p1-layers")
        study.engine("fem")
        study.mode("strict")
        study.universe(mode="manual", size=(100e-9, 80e-9, 65e-9))
        film = study.geometry(
            fm.Box(size=(24e-9, 12e-9, 1e-9), name="magnet"),
            name="magnet",
        )
        film.Ms = 800e3
        film.Aex = 13e-12
        film.alpha = 0.1
        film.m = fm.texture.uniform(1, 0, 0)
        film.mesh.thin_film(
            maximum_element_size=3e-9,
            layers=3,
            topology="prismatic",
            exact_layers=True,
            transition="pyramid_to_tetrahedra",
            order=1,
        )
        study.relax(algorithm="projected_gradient_bb", max_steps=1)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "mixed_p1_publication_example.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            with patch("fullmag.world.build_geometry_assets_for_request", return_value=None):
                loaded = fm.load_problem_from_script(path)

        problem_ir = loaded.problem.to_ir(include_geometry_assets=False)
        mesh_workflow = problem_ir["problem_meta"]["runtime_metadata"]["mesh_workflow"]
        self.assertEqual(
            mesh_workflow["per_geometry"][0],
            {
                "geometry": "magnet",
                "mode": "custom",
                "hmax": 3e-9,
                "maximum_element_size": 3e-9,
                "order": 1,
                "mesh_strategy": "swept_prism",
                "through_thickness_elements": 3,
                "through_thickness_distribution": "fixed",
                "sweep_face_meshing": "triangular",
                "topology": "prismatic",
                "sweep_direction": "auto",
                "element_family": "prism",
                "transition_policy": "pyramid_to_tetrahedra",
                "exact_layer_count": True,
            },
        )

    def test_thin_film_airbox_boundary_transition_token_round_trips(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("thin_film_airbox_boundary")
        study.engine("fem")
        study.universe(
            mode="auto",
            size=(200e-9, 120e-9, 40e-9),
            center=(0.0, 0.0, 0.0),
        )
        study.universe.mesh(
            maximum_element_size=80e-9,
            minimum_element_size=5e-9,
            maximum_element_growth_rate=1.4,
            grading="geometric",
        )

        body = study.geometry(fm.Box(100e-9, 40e-9, 2e-9), name="body")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        body.mesh.thin_film(
            maximum_element_size=20e-9,
            minimum_element_size=2e-9,
            interface_maximum_element_size=8e-9,
            interface_thickness=4e-9,
            transition_distance="airbox_boundary",
            edge_maximum_element_size=5e-9,
            edge_thickness=5e-9,
            edge_transition_distance="airbox_boundary",
            corner_maximum_element_size=5e-9,
            corner_extent=5e-9,
            corner_transition_distance="airbox_boundary",
            layers=1,
        )
        study.build_domain_mesh()
        study.run(1e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_study_thin_film_airbox_boundary.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            with patch("fullmag.world.build_geometry_assets_for_request", return_value=None):
                loaded = fm.load_problem_from_script(path)

            with patch(
                "fullmag.model.problem.build_geometry_assets_for_request",
                return_value=None,
            ):
                ir = loaded.problem.to_ir(requested_backend=fm.BackendTarget.FEM)

        per_geometry = ir["problem_meta"]["runtime_metadata"]["mesh_workflow"]["per_geometry"][0]
        self.assertEqual(per_geometry["transition_distance"], "airbox_boundary")
        self.assertEqual(per_geometry["edge_transition_distance"], "airbox_boundary")
        self.assertEqual(per_geometry["corner_transition_distance"], "airbox_boundary")

        mesh_entry = export_builder_draft(loaded)["geometries"][0]["mesh"]
        self.assertEqual(mesh_entry["transition_distance"], "airbox_boundary")
        self.assertEqual(mesh_entry["edge_transition_distance"], "airbox_boundary")
        self.assertEqual(mesh_entry["corner_transition_distance"], "airbox_boundary")

        rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
        self.assertIn('transition_distance="airbox_boundary"', rewritten)
        self.assertIn('edge_transition_distance="airbox_boundary"', rewritten)
        self.assertIn('corner_transition_distance="airbox_boundary"', rewritten)

    def test_mesh_controls_round_trip_for_production_thin_film(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("mesh_roundtrip")
        study.engine("fem")
        study.universe(
            mode="auto",
            size=(200e-9, 120e-9, 40e-9),
            center=(0.0, 0.0, 0.0),
        )
        study.universe.mesh(
            maximum_element_size=80e-9,
            minimum_element_size=5e-9,
            maximum_element_growth_rate=1.4,
            grading="geometric",
        )

        body = study.geometry(
            fm.ArchWaveguide(
                length=100e-9,
                width=40e-9,
                height=2e-9,
                arch_height=0.0,
                name="arch",
            ),
            name="body",
        )
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        body.mesh.thin_film(
            maximum_element_size=20e-9,
            minimum_element_size=2e-9,
            curvature_factor=0.45,
            narrow_region_resolution=0.8,
            interface_maximum_element_size=8e-9,
            interface_thickness=4e-9,
            transition_distance=60e-9,
            edge_maximum_element_size=5e-9,
            edge_thickness=5e-9,
            edge_transition_distance=40e-9,
            corner_maximum_element_size=5e-9,
            corner_extent=5e-9,
            corner_transition_distance=30e-9,
            layers=1,
        )
        study.build_domain_mesh()
        study.run(1e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_study_production_thin_film_mesh.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            with patch("fullmag.world.build_geometry_assets_for_request", return_value=None):
                loaded = fm.load_problem_from_script(path)

            with patch(
                "fullmag.model.problem.build_geometry_assets_for_request",
                return_value=None,
            ):
                ir = loaded.problem.to_ir(requested_backend=fm.BackendTarget.FEM)

        workflow = ir["problem_meta"]["runtime_metadata"]["mesh_workflow"]
        study_universe = ir["problem_meta"]["runtime_metadata"]["study_universe"]
        self.assertEqual(study_universe["airbox_hmax"], 80e-9)
        self.assertEqual(study_universe["airbox_hmin"], 5e-9)
        self.assertEqual(study_universe["airbox_growth_rate"], 1.4)
        per_geometry = workflow["per_geometry"][0]
        self.assertEqual(per_geometry["mesh_strategy"], "thin_film_tetrahedral")
        self.assertEqual(per_geometry["through_thickness_elements"], 1)
        self.assertEqual(per_geometry["curvature_factor"], 0.45)
        self.assertEqual(per_geometry["narrow_region_resolution"], 0.8)
        self.assertEqual(per_geometry["edge_transition_distance"], 40e-9)
        self.assertEqual(per_geometry["corner_transition_distance"], 30e-9)

        mesh_entry = export_builder_draft(loaded)["geometries"][0]["mesh"]
        self.assertEqual(mesh_entry["mesh_strategy"], "thin_film_tetrahedral")
        self.assertEqual(mesh_entry["curvature_factor"], "0.45")
        self.assertEqual(mesh_entry["narrow_region_resolution"], "0.8")
        self.assertEqual(mesh_entry["edge_transition_distance"], "4e-08")
        self.assertEqual(mesh_entry["corner_transition_distance"], "3e-08")

        rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
        self.assertIn("body.mesh.thin_film(", rewritten)
        self.assertIn("curvature_factor=0.45", rewritten)
        self.assertIn("narrow_region_resolution=0.8", rewritten)
        self.assertIn("edge_transition_distance=4e-08", rewritten)
        self.assertIn("corner_transition_distance=3e-08", rewritten)
        self.assertIn("layers=1", rewritten)

    def test_edge_transition_distance_requires_edge_refinement(self) -> None:
        fm.reset()
        try:
            body = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="body")

            with self.assertRaisesRegex(
                ValueError,
                "edge_transition_distance requires edge_maximum_element_size and edge_thickness",
            ):
                body.mesh(edge_transition_distance=7e-9)
        finally:
            fm.reset()

    def test_box_edge_thickness_must_fit_in_in_plane_dimension(self) -> None:
        fm.reset()
        try:
            body = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="body")

            with self.assertRaisesRegex(
                ValueError,
                "edge_thickness must be smaller than half of the smaller in-plane dimension",
            ):
                body.mesh(
                    maximum_element_size=20e-9,
                    edge_maximum_element_size=5e-9,
                    edge_thickness=10e-9,
                )
        finally:
            fm.reset()

    def test_corner_transition_distance_requires_corner_refinement(self) -> None:
        fm.reset()
        try:
            body = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="body")

            with self.assertRaisesRegex(
                ValueError,
                "corner_transition_distance requires corner_maximum_element_size and corner_extent",
            ):
                body.mesh(corner_transition_distance=7e-9)
        finally:
            fm.reset()

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

    def test_boundary_layer_selectors_round_trip_through_script_builder(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("boundary_layer_selector_round_trip")
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
                target_surfaces=[
                    fm.mesh.nearest_surface_to_point(
                        point=(50e-9, 0.0, 2.5e-9),
                        geometry="body",
                    )
                ],
            ),
        )
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_study_object_mesh_boundary_layer_selectors.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            with patch("fullmag.world.build_geometry_assets_for_request", return_value=None):
                loaded = fm.load_problem_from_script(path)

        mesh_entry = export_builder_draft(loaded)["geometries"][0]["mesh"]
        expected_selector = {
            "kind": "nearest_surface_to_point",
            "geometry": "body",
            "point": [50e-9, 0.0, 2.5e-9],
            "count": 1,
        }
        self.assertEqual(mesh_entry["boundary_layer_target_surface_selectors"], [expected_selector])

        rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
        self.assertIn("boundary_layer_target_surface_selectors=", rewritten)
        self.assertIn('"nearest_surface_to_point"', rewritten)

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

    def test_flat_visualization_hint_sets_runtime_metadata(self) -> None:
        script = """
        import fullmag as fm

        fm.engine("fdm")
        fm.cell(5e-9, 5e-9, 5e-9)
        body = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        fm.visualization(active_quantity_id="h_demag")
        fm.run(4e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_flat_viz.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path)

        ir = loaded.stages[0].to_ir(
            requested_backend=fm.BackendTarget.FDM,
            execution_mode=fm.ExecutionMode.STRICT,
            execution_precision=fm.ExecutionPrecision.DOUBLE,
            script_source=loaded.script_source,
        )
        hint = ir["problem_meta"]["runtime_metadata"].get("visualization_hint")
        self.assertEqual(hint, {"active_quantity_id": "h_demag"})

    def test_study_visualization_hint_sets_runtime_metadata(self) -> None:
        script = """
        import fullmag as fm

        body = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        fm.study().engine("fdm").visualization(active_quantity_id="h_eff").relax()
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_study_viz.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path)

        ir = loaded.stages[0].to_ir(
            requested_backend=fm.BackendTarget.FDM,
            execution_mode=fm.ExecutionMode.STRICT,
            execution_precision=fm.ExecutionPrecision.DOUBLE,
            script_source=loaded.script_source,
        )
        hint = ir["problem_meta"]["runtime_metadata"].get("visualization_hint")
        self.assertEqual(hint, {"active_quantity_id": "h_eff"})

    def test_visualization_hint_round_trips_through_script_export(self) -> None:
        script = """
        import fullmag as fm

        fm.engine("fdm")
        fm.cell(5e-9, 5e-9, 5e-9)
        body = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        fm.visualization(active_quantity_id="exchange_field")
        fm.run(4e-12)
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_viz_roundtrip.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path)

        exported = rewrite_loaded_problem_script(loaded)["rendered_source"]
        self.assertIn('visualization(active_quantity_id="exchange_field")', exported)

    def test_airbox_visualization_hint_sets_runtime_metadata(self) -> None:
        script = """
        import fullmag as fm

        body = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        s = fm.study().engine("fdm")
        s.airbox.visualization(show=True, mode="vectors")
        s.relax()
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_airbox_viz.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path)

        ir = loaded.stages[0].to_ir(
            requested_backend=fm.BackendTarget.FDM,
            execution_mode=fm.ExecutionMode.STRICT,
            execution_precision=fm.ExecutionPrecision.DOUBLE,
            script_source=loaded.script_source,
        )
        hint = ir["problem_meta"]["runtime_metadata"].get("visualization_hint", {})
        self.assertEqual(hint.get("airbox"), {"show": True, "mode": "vectors"})

    def test_airbox_visualization_hint_sets_per_target_quantity(self) -> None:
        script = """
        import fullmag as fm

        body = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        s = fm.study().engine("fdm")
        s.airbox.visualization(active_quantity_id="h_eff")
        s.airbox.visualization(show=False, mode="vectors")
        s.relax()
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_airbox_viz_quantity.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path)

        ir = loaded.stages[0].to_ir(
            requested_backend=fm.BackendTarget.FDM,
            execution_mode=fm.ExecutionMode.STRICT,
            execution_precision=fm.ExecutionPrecision.DOUBLE,
            script_source=loaded.script_source,
        )
        hint = ir["problem_meta"]["runtime_metadata"].get("visualization_hint", {})
        self.assertEqual(
            hint.get("airbox"),
            {"show": False, "mode": "vectors", "active_quantity_id": "h_eff"},
        )

    def test_geometry_visualization_hint_sets_runtime_metadata(self) -> None:
        script = """
        import fullmag as fm

        waveguide = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="waveguide")
        waveguide.Ms = 800e3
        waveguide.Aex = 13e-12
        waveguide.alpha = 0.1
        waveguide.m = fm.texture.uniform(1, 0, 0)
        waveguide.visualization(show=True, mode="surface")
        fm.study().engine("fdm").relax()
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_geom_viz.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path)

        ir = loaded.stages[0].to_ir(
            requested_backend=fm.BackendTarget.FDM,
            execution_mode=fm.ExecutionMode.STRICT,
            execution_precision=fm.ExecutionPrecision.DOUBLE,
            script_source=loaded.script_source,
        )
        hint = ir["problem_meta"]["runtime_metadata"].get("visualization_hint", {})
        geom_hints = hint.get("geometry_hints", {})
        self.assertEqual(geom_hints.get("waveguide"), {"show": True, "mode": "surface"})

    def test_geometry_visualization_hint_sets_per_target_quantity(self) -> None:
        script = """
        import fullmag as fm

        waveguide = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="waveguide")
        waveguide.Ms = 800e3
        waveguide.Aex = 13e-12
        waveguide.alpha = 0.1
        waveguide.m = fm.texture.uniform(1, 0, 0)
        waveguide.visualization(show=True, mode="surface", active_quantity_id="m")
        s = fm.study().engine("fdm")
        s.airbox.visualization(show=True, mode="vectors", active_quantity_id="h_eff")
        s.relax()
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_geom_viz_quantity.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path)

        ir = loaded.stages[0].to_ir(
            requested_backend=fm.BackendTarget.FDM,
            execution_mode=fm.ExecutionMode.STRICT,
            execution_precision=fm.ExecutionPrecision.DOUBLE,
            script_source=loaded.script_source,
        )
        hint = ir["problem_meta"]["runtime_metadata"].get("visualization_hint", {})
        geom_hints = hint.get("geometry_hints", {})
        self.assertEqual(
            geom_hints.get("waveguide"),
            {"show": True, "mode": "surface", "active_quantity_id": "m"},
        )
        self.assertEqual(
            hint.get("airbox"),
            {"show": True, "mode": "vectors", "active_quantity_id": "h_eff"},
        )

    def test_visualization_hints_round_trip_through_script_export(self) -> None:
        script = """
        import fullmag as fm

        waveguide = fm.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="waveguide")
        waveguide.Ms = 800e3
        waveguide.Aex = 13e-12
        waveguide.alpha = 0.1
        waveguide.m = fm.texture.uniform(1, 0, 0)
        waveguide.visualization(show=True, mode="surface", active_quantity_id="m")
        s = fm.study().engine("fdm")
        s.airbox.visualization(show=True, mode="vectors", active_quantity_id="h_eff")
        s.relax()
        """

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "script_full_viz_roundtrip.py"
            path.write_text(textwrap.dedent(script), encoding="utf-8")
            loaded = fm.load_problem_from_script(path)

        exported = rewrite_loaded_problem_script(loaded)["rendered_source"]
        self.assertIn(
            'waveguide.visualization(show=True, mode="surface", active_quantity_id="m")',
            exported,
        )
        self.assertIn(
            'study.airbox.visualization(show=True, mode="vectors", active_quantity_id="h_eff")',
            exported,
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
        self.assertIsNone(payload["shared_geometry_assets"])
        self.assertIn("geometry_assets", payload["ir"])

    def test_run_config_geometry_assets_have_single_owner_without_stages(self) -> None:
        original_assets = {"fem_domain_mesh_asset": {"mesh": {"nodes": [[0.0, 0.0, 0.0]]}}}
        original_ir = {"geometry_assets": original_assets}

        exported_ir, shared_assets = runtime_helper._prepare_run_config_geometry_assets(
            original_ir,
            has_stages=False,
        )

        self.assertIs(exported_ir, original_ir)
        self.assertIs(exported_ir["geometry_assets"], original_assets)
        self.assertIsNone(shared_assets)
        exported_ir["geometry_assets"]["fem_domain_mesh_asset"]["mesh"]["nodes"].append(
            [1.0, 0.0, 0.0]
        )
        self.assertEqual(len(original_assets["fem_domain_mesh_asset"]["mesh"]["nodes"]), 2)

    def test_run_config_geometry_assets_are_isolated_for_stage_compaction(self) -> None:
        class NoDeepcopyAssets(dict[str, object]):
            def __deepcopy__(self, memo: dict[int, object]) -> object:
                raise AssertionError("geometry assets must be detached before deepcopy")

        original_assets = NoDeepcopyAssets(
            {"fem_domain_mesh_asset": {"mesh": {"nodes": [[0.0, 0.0, 0.0]]}}}
        )
        original_ir = {"geometry_assets": original_assets}

        exported_ir, shared_assets = runtime_helper._prepare_run_config_geometry_assets(
            original_ir,
            has_stages=True,
        )

        self.assertIsNot(exported_ir, original_ir)
        self.assertIsNone(exported_ir["geometry_assets"])
        self.assertIs(shared_assets, original_assets)
        shared_assets["fem_domain_mesh_asset"]["mesh"]["nodes"].append([1.0, 0.0, 0.0])
        self.assertEqual(len(original_assets["fem_domain_mesh_asset"]["mesh"]["nodes"]), 2)

    def test_compact_stage_ir_detaches_shared_assets_before_deepcopy(self) -> None:
        class NoDeepcopyAssets(dict[str, object]):
            def __deepcopy__(self, memo: dict[int, object]) -> object:
                raise AssertionError("geometry assets must be detached before deepcopy")

        shared_assets = NoDeepcopyAssets(
            {"fem_domain_mesh_asset": {"mesh": {"nodes": [[0.0, 0.0, 0.0]]}}}
        )
        stage_ir = {
            "geometry_assets": shared_assets,
            "problem_meta": {"name": "stage"},
        }

        compacted = runtime_helper._compact_stage_ir(
            stage_ir,
            shared_geometry_assets=shared_assets,
        )

        self.assertIs(stage_ir["geometry_assets"], shared_assets)
        self.assertIsNone(compacted["geometry_assets"])
        compacted["problem_meta"]["name"] = "changed"
        self.assertEqual(stage_ir["problem_meta"]["name"], "stage")

    def test_compact_stage_ir_compacts_semantically_identical_assets(self) -> None:
        shared_assets = {
            "fem_domain_mesh_asset": {
                "mesh": {"topology_fingerprint": "sha256:canonical-tet"}
            }
        }
        stage_assets = {
            "fem_domain_mesh_asset": {
                "mesh": {"topology_fingerprint": "sha256:canonical-tet"}
            }
        }
        stage_ir = {"geometry_assets": stage_assets}

        compacted = runtime_helper._compact_stage_ir(
            stage_ir,
            shared_geometry_assets=shared_assets,
        )

        self.assertIsNot(stage_assets, shared_assets)
        self.assertIs(stage_ir["geometry_assets"], stage_assets)
        self.assertIsNone(compacted["geometry_assets"])

    def test_compact_stage_ir_preserves_same_fingerprint_assets_with_different_markers(self) -> None:
        shared_assets = {
            "fem_domain_mesh_asset": {
                "mesh": {"topology_fingerprint": "sha256:shared-topology"},
                "region_markers": [{"geometry": "film", "marker": 1}],
                "object_region_markers": [],
                "build_report": {"degraded": False, "fallbacks_triggered": []},
            }
        }
        stage_assets = copy.deepcopy(shared_assets)
        stage_assets["fem_domain_mesh_asset"]["region_markers"] = [
            {"geometry": "film", "marker": 7}
        ]
        stage_ir = {"geometry_assets": stage_assets}

        compacted = runtime_helper._compact_stage_ir(
            stage_ir,
            shared_geometry_assets=shared_assets,
        )

        self.assertEqual(compacted["geometry_assets"], stage_assets)
        self.assertIsNot(compacted["geometry_assets"], stage_assets)
        self.assertEqual(
            compacted["geometry_assets"]["fem_domain_mesh_asset"]["region_markers"],
            [{"geometry": "film", "marker": 7}],
        )

    def test_helper_exports_sp4_overlay_without_real_geometry_assets(self) -> None:
        scenario = Path(
            "tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py"
        )

        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            exit_code = runtime_helper.main(
                [
                    "export-run-config",
                    "--script",
                    str(scenario),
                    "--runtime-device",
                    "cpu",
                    "--skip-geometry-assets",
                ]
            )

        self.assertEqual(exit_code, 0)
        payload = json.loads(stdout.getvalue())
        base_metadata = payload["ir"]["problem_meta"]["runtime_metadata"]
        self.assertEqual(base_metadata["runtime_selection"]["device"], "auto")
        self.assertEqual(
            base_metadata["model_builder"]["problem"]["runtime"]["device"],
            "auto",
        )
        self.assertEqual(
            base_metadata["runtime_device_override"],
            {"device": "cpu", "source": "managed_launcher"},
        )
        self.assertEqual(len(payload["stages"]), 2)
        stage_ir = payload["stages"][0]["ir"]
        self.assertEqual(stage_ir["study"]["kind"], "relaxation")
        stage_metadata = stage_ir["problem_meta"]["runtime_metadata"]
        self.assertEqual(stage_metadata["runtime_selection"]["device"], "auto")
        self.assertEqual(
            stage_metadata["model_builder"]["problem"]["runtime"]["device"],
            "auto",
        )
        self.assertEqual(
            stage_metadata["runtime_device_override"],
            {"device": "cpu", "source": "managed_launcher"},
        )
        self.assertIsNone(stage_ir["geometry_assets"])
        self.assertEqual(payload["stages"][1]["entrypoint_kind"], "flat_save_state")
        self.assertEqual(payload["stages"][1]["ir"]["study"]["kind"], "relaxation")
        self.assertIsNone(payload["stages"][1]["ir"]["geometry_assets"])

    @unittest.skipUnless(
        os.environ.get("FULLMAG_RUN_SLOW_REAL_ASSET_TESTS") == "1",
        "set FULLMAG_RUN_SLOW_REAL_ASSET_TESTS=1 for the explicit slow real-asset export",
    )
    def test_slow_helper_exports_sp4_real_assets_with_cpu_override(self) -> None:
        scenario = Path(
            "tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py"
        )

        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            exit_code = runtime_helper.main(
                [
                    "export-run-config",
                    "--script",
                    str(scenario),
                    "--runtime-device",
                    "cpu",
                ]
            )

        self.assertEqual(exit_code, 0)
        payload = json.loads(stdout.getvalue())
        base_metadata = payload["ir"]["problem_meta"]["runtime_metadata"]
        self.assertEqual(base_metadata["runtime_selection"]["device"], "auto")
        self.assertEqual(
            base_metadata["runtime_device_override"],
            {"device": "cpu", "source": "managed_launcher"},
        )
        stage_metadata = payload["stages"][0]["ir"]["problem_meta"]["runtime_metadata"]
        self.assertEqual(stage_metadata["runtime_selection"]["device"], "auto")
        self.assertEqual(
            stage_metadata["runtime_device_override"],
            {"device": "cpu", "source": "managed_launcher"},
        )

        domain_asset = payload["shared_geometry_assets"]["fem_domain_mesh_asset"]
        report = domain_asset["build_report"]
        certificate = report["mixed_layer_topology_certificate"]
        self.assertEqual(
            certificate["schema_version"], "mixed_layer_topology_certificate.v1"
        )
        self.assertEqual(certificate["certificate_status"], "accepted")
        self.assertEqual(
            certificate["topology_fingerprint"],
            domain_asset["mesh"]["mixed_layer_topology_certificate"]
            ["topology_fingerprint"],
        )
        self.assertEqual(report["fallbacks_triggered"], [])
        self.assertFalse(report["degraded"])
        self.assertEqual(certificate["fallbacks_triggered"], [])

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
            timestep=1e-15,
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

    def test_fem_fmr_free_demag_airbox_example_materializes_relax_then_eigenmodes(self) -> None:
        example_path = Path("examples/fem_fmr_free_demag_airbox_smoke.py")

        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            exit_code = runtime_helper.main(
                [
                    "export-run-config",
                    "--script",
                    str(example_path),
                    "--backend",
                    "fem",
                    "--mode",
                    "strict",
                    "--precision",
                    "double",
                    "--skip-geometry-assets",
                ]
            )

        self.assertEqual(exit_code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(len(payload["stages"]), 2)
        self.assertEqual(payload["stages"][0]["entrypoint_kind"], "flat_relax")
        self.assertEqual(payload["stages"][1]["entrypoint_kind"], "flat_eigenmodes")

        root_metadata = payload["ir"]["problem_meta"]["runtime_metadata"]
        self.assertEqual(
            root_metadata["mesh_workflow"]["domain_mesh_mode"],
            "generated_shared_domain_mesh",
        )
        self.assertEqual(root_metadata["mesh_workflow"]["build_target"], "domain")
        self.assertEqual(root_metadata["runtime_selection"]["backend"], "fem")
        self.assertEqual(root_metadata["runtime_selection"]["device"], "cpu")
        self.assertEqual(root_metadata["runtime_selection"]["execution_precision"], "double")
        self.assertIn(
            {"kind": "demag", "realization": "poisson_robin"},
            payload["ir"]["energy_terms"],
        )

        relax = payload["stages"][0]["ir"]["study"]
        self.assertEqual(relax["kind"], "relaxation")
        self.assertEqual(relax["algorithm"], "projected_gradient_bb")
        self.assertEqual(relax["stop"]["max_steps"], 120)

        eigen = payload["stages"][1]["ir"]["study"]
        self.assertEqual(eigen["kind"], "eigenmodes")
        self.assertEqual(eigen["count"], 8)
        self.assertTrue(eigen["operator"]["include_demag"])
        self.assertEqual(eigen["equilibrium"], {"kind": "relaxed_initial_state"})
        self.assertEqual(eigen["spin_wave_bc"], "free")
        self.assertEqual(eigen["sampling"]["outputs"][0]["kind"], "eigen_spectrum")
        self.assertEqual(eigen["sampling"]["outputs"][1]["kind"], "eigen_mode")
        self.assertEqual(eigen["sampling"]["outputs"][1]["indices"], list(range(8)))


if __name__ == "__main__":
    unittest.main()
