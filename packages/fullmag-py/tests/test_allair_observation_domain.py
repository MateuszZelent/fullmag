"""All-air field carriers and magnetic-domain gates; no native solve."""
from dataclasses import replace
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import numpy as np
import fullmag as fm
from fullmag.runtime.loader import LoadedProblem, load_problem_from_script
from fullmag.runtime.script_builder import render_loaded_problem_as_script
from fullmag.meshing.persistence import save_mesh_artifact
from test_antenna_coincident_cut import full_loop_mesh
from test_antenna_surface_policy import authored_problem


class AllAirObservationDomainTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="allair-domain-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        mesh = full_loop_mesh()[0]
        self.mesh = replace(mesh, element_markers=np.zeros(mesh.n_elements, dtype=np.int32))
        self.path = self.root / "observation.fullmag-mesh"
        save_mesh_artifact(self.path, mesh=self.mesh, mesh_name="observation", authoring_document={}, region_markers=[], boundary_map={"outer": 1})
        self.workflow = {"domain_mesh_source": str(self.path), "domain_region_markers": []}

    def observation_problem(self, study=None):
        original = authored_problem()
        return replace(original, current_modules=[], antenna_port_modes=[], antenna_field_solve_stages=[],
            study=study or fm.FieldOnly(), runtime_metadata={"mesh_workflow": self.workflow, "script_api_surface": "study"})

    def test_static_nonmagnetic_allair_carrier_is_materialized_without_cache(self):
        for study in (fm.FieldOnly(), fm.AntennaFieldSolve()):
            with self.subTest(study=type(study).__name__), patch("fullmag.model.problem._fem_mesh_cache_dir", side_effect=AssertionError("unexpected mesher/cache")):
                ir = self.observation_problem(study).to_ir(source_root=self.root)
            asset = ir["geometry_assets"]["fem_domain_mesh_asset"]
            self.assertEqual(asset["region_markers"], [])
            self.assertEqual(asset["object_region_markers"], [])
            self.assertEqual(asset["mesh"]["element_markers"], [0] * self.mesh.n_elements)
            self.assertEqual(asset["mesh"]["nodes"], self.mesh.nodes.tolist())

    def test_empty_mapping_cannot_mask_magnetic_cells_or_deferred_input(self):
        mesh = replace(self.mesh, element_markers=np.ones(self.mesh.n_elements, dtype=np.int32))
        path = self.root / "magnetic.fullmag-mesh"
        save_mesh_artifact(path, mesh=mesh, mesh_name="magnetic", authoring_document={}, region_markers=[{"geometry_name": "loop", "marker": 1}], boundary_map={"outer": 1})
        problem = self.observation_problem()
        for source in (str(path), str(self.root / "deferred.json")):
            with self.subTest(source=source), self.assertRaises(ValueError):
                replace(problem, runtime_metadata={"mesh_workflow": {"domain_mesh_source": source, "domain_region_markers": []}}).to_ir(source_root=self.root)
        with self.assertRaisesRegex(ValueError, "object-region"):
            replace(problem, runtime_metadata={"mesh_workflow": {**self.workflow, "domain_object_region_markers": [{"geometry_name": "loop:part", "marker": 1}]}})
        with self.assertRaisesRegex(ValueError, "nonmagnetic"):
            replace(problem, study=fm.AntennaFieldSolve(), energy=[fm.Demag()])

    def test_final_physical_intent_refuses_empty_maps_independent_of_call_order(self):
        head = 'import fullmag as fm\nstudy = fm.study("magnetic")\nstudy.engine("fem")\n'
        magnet = 'body = study.geometry(fm.Box(20e-9,20e-9,10e-9), name="body")\nbody.Ms = 800e3\nbody.Aex = 13e-12\nbody.alpha = 0.1\nbody.m = fm.texture.uniform(1,0,0)\n'
        domain = 'study.domain_mesh("observation.fullmag-mesh", region_markers=[])\n'
        for order in (domain + magnet, magnet + domain):
            for stage in ('study.run(1e-12)\n', 'study.stages.add_run(id="run", until=1e-12)\n', ''):
                path = self.root / "invalid.py"
                path.write_text(head + order + stage)
                with self.subTest(order=order[:20], stage=stage), self.assertRaisesRegex(ValueError, "nonmagnetic FieldOnly/AntennaFieldSolve"):
                    load_problem_from_script(path, lightweight_assets=True)
        problem = self.observation_problem()
        problem.runtime_metadata["mesh_workflow"]["domain_region_markers"] = None
        with self.assertRaisesRegex(ValueError, "domain_region_markers list"):
            problem.to_ir(source_root=self.root, include_geometry_assets=False)

    def test_nonempty_magnetic_maps_and_strict_magnetic_helpers_are_preserved(self):
        head = 'import fullmag as fm\nstudy = fm.study("magnetic")\nstudy.engine("fem")\n'
        magnet = 'body = study.geometry(fm.Box(20e-9,20e-9,10e-9), name="body")\nbody.Ms = 800e3\nbody.Aex = 13e-12\nbody.alpha = 0.1\nbody.m = fm.texture.uniform(1,0,0)\n'
        domain = 'study.domain_mesh("magnetic.fullmag-mesh", region_markers={"body":1})\n'
        path = self.root / "magnetic.py"
        path.write_text(head + domain + magnet + 'study.run(1e-12)\n')
        loaded = load_problem_from_script(path, lightweight_assets=True)
        self.assertEqual(loaded.problem.runtime_metadata["mesh_workflow"]["domain_region_markers"], [{"geometry_name": "body", "marker": 1}])
        for statement in ('study.frozen_magnetic_submesh("observation.fullmag-mesh", region_markers=[])',
                          'study.domain_mesh("observation.fullmag-mesh", region_markers=[], object_region_markers=[])'):
            path.write_text(head + statement + '\n')
            with self.subTest(statement=statement), self.assertRaisesRegex(ValueError, "must not be empty"):
                load_problem_from_script(path, lightweight_assets=True)

    def test_roundtrip_keeps_explicit_empty_domain_map(self):
        problem = self.observation_problem()
        loaded = LoadedProblem(problem=problem, source_path=self.root / "author.py", script_source="", entrypoint_kind="flat_workspace")
        script = render_loaded_problem_as_script(loaded)
        self.assertIn("region_markers=[]", script)
        path = self.root / "roundtrip.py"
        path.write_text(script)
        imported = load_problem_from_script(path, lightweight_assets=True)
        workflow = imported.problem.runtime_metadata["mesh_workflow"]
        self.assertEqual(workflow["domain_region_markers"], [])
        self.assertEqual(Path(workflow["domain_mesh_source"]).name, self.path.name)


if __name__ == "__main__":
    unittest.main()
