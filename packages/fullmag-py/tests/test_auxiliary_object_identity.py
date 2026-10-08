"""Interpreted public auxiliary identity regression; no solver or native test build."""
from dataclasses import replace
import copy
import faulthandler
import os
from pathlib import Path
import tempfile
import unittest

import fullmag as fm
from fullmag import world
from fullmag.model.physics_scope import build_physics_graph
from fullmag.runtime.loader import load_problem_from_script
from fullmag.runtime.scene_document import build_scene_document_from_builder
from fullmag.runtime.script_builder import (
    _stage_signature,
    export_builder_draft,
    render_loaded_problem_as_script,
    render_scene_document_as_script,
)


class AuxiliaryObjectIdentityTests(unittest.TestCase):
    def setUp(self):
        world.begin_script_capture()
        world.set_script_capture_lightweight_assets(True)
        self.addCleanup(world.finish_script_capture)
        self.study = fm.study("auxiliary-identity")
        self.study.engine("fdm")
        self.study.device("cpu", precision="double")
        self.study.objects.mesh.defaults(cell_size=(10e-9, 10e-9, 10e-9))
        self.study.disable_demag()
        self.magnet = self.study.geometry(fm.Box(100e-9, 20e-9, 10e-9), name="film", object_id="magnetic-id")
        self.magnet.Ms = 800e3
        self.magnet.Aex = 13e-12
        self.magnet.alpha = 0.01
        self.magnet.m = fm.texture.uniform(1, 0, 0)

    def problem(self):
        result = world.capture_workspace_problem()
        self.assertIsNotNone(result)
        return result

    def shape(self):
        return fm.Box(20e-9, 40e-9, 5e-9)

    def constructors(self):
        return (fm.geometry_object, fm.antenna_object, self.study.geometry_object,
                self.study.conductor, self.study.antenna_object)

    def test_legacy_without_explicit_id_keeps_name_identity(self):
        self.study.antenna_object(self.shape(), name="legacy")
        objects = self.problem().to_ir(include_geometry_assets=False)["physics_objects"]
        self.assertEqual(objects[0]["object_id"], "legacy")
        self.assertEqual(objects[0]["name"], "legacy")
        self.assertEqual(objects[0]["geometry_id"], "legacy")

    def test_all_public_wrappers_preserve_explicit_identity_and_geometry_name(self):
        for index, constructor in enumerate(self.constructors()):
            shape = constructor(self.shape(), name=f"display-{index}", object_id=f"immutable-{index}")
            self.assertEqual(shape.geometry_name, f"display-{index}")
        problem = self.problem()
        self.assertEqual(dict(problem.auxiliary_geometry_object_ids), {f"display-{index}": f"immutable-{index}" for index in range(5)})
        self.assertEqual([geometry.geometry_name for geometry in problem.auxiliary_geometries], [f"display-{index}" for index in range(5)])

    def test_empty_explicit_id_rejected_without_registering_geometry(self):
        before = self.problem()
        for constructor in self.constructors():
            for value in ("", "   "):
                with self.subTest(constructor=constructor.__name__, value=value):
                    with self.assertRaises(ValueError):
                        constructor(self.shape(), name="must-not-register", object_id=value)
                    after = self.problem()
                    self.assertEqual(after.auxiliary_geometries, before.auxiliary_geometries)
                    self.assertEqual(dict(after.auxiliary_geometry_object_ids), dict(before.auxiliary_geometry_object_ids))

    def test_duplicate_auxiliary_id_is_rejected_atomically(self):
        self.study.antenna_object(self.shape(), name="first", object_id="shared-id")
        before = self.problem()
        with self.assertRaises(ValueError):
            self.study.conductor(self.shape(), name="second", object_id="shared-id")
        after = self.problem()
        self.assertEqual(after.auxiliary_geometries, before.auxiliary_geometries)
        self.assertEqual(dict(after.auxiliary_geometry_object_ids), dict(before.auxiliary_geometry_object_ids))

    def test_duplicate_geometry_name_with_distinct_ids_is_rejected_atomically(self):
        self.study.antenna_object(self.shape(), name="source", object_id="first-id")
        before = self.problem()
        with self.assertRaises(ValueError):
            self.study.conductor(self.shape(), name="source", object_id="second-id")
        after = self.problem()
        self.assertEqual(after.auxiliary_geometries, before.auxiliary_geometries)
        self.assertEqual(dict(after.auxiliary_geometry_object_ids), dict(before.auxiliary_geometry_object_ids))

    def test_presentation_roles_and_identity_do_not_activate_physics(self):
        self.study.antenna_object(self.shape(), name="source", object_id="source-id")
        self.study.conductor(self.shape(), name="lead", object_id="lead-id")
        problem = self.problem()
        for collection in ("current_modules", "antenna_port_modes", "antenna_field_solve_stages",
                           "antenna_target_projections", "solved_antenna_drives", "antenna_spectrum_requests"):
            self.assertEqual(tuple(getattr(problem, collection)), (), collection)
        graph = build_physics_graph(problem).to_ir()
        self.assertFalse(any(module["kind"] in {"current_transport", "oersted_field", "solved_antenna_drive"} for module in graph["modules"]))

    def test_magnet_first_identity_collision_is_rejected_atomically(self):
        before = self.problem()
        with self.assertRaises(ValueError):
            self.study.antenna_object(self.shape(), name="source", object_id="magnetic-id")
        after = self.problem()
        self.assertEqual(after.magnets, before.magnets)
        self.assertEqual(after.auxiliary_geometries, before.auxiliary_geometries)

    def test_auxiliary_first_identity_collision_is_rejected_atomically(self):
        self.study.antenna_object(self.shape(), name="source", object_id="shared-id")
        before = self.problem()
        with self.assertRaises(ValueError):
            self.study.geometry(self.shape(), name="must-not-register", object_id="shared-id")
        after = self.problem()
        self.assertEqual(after.magnets, before.magnets)
        self.assertEqual(after.auxiliary_geometries, before.auxiliary_geometries)
        self.assertEqual(dict(after.auxiliary_geometry_object_ids), dict(before.auxiliary_geometry_object_ids))

    def test_problem_mapping_rejects_unknown_empty_and_colliding_ids(self):
        self.study.antenna_object(self.shape(), name="source")
        self.study.conductor(self.shape(), name="lead")
        problem = self.problem()
        for mapping in ({"unknown": "id"}, {"source": ""}, {"source": "   "},
                        {"source": "magnetic-id"}, {"source": "same", "lead": "same"}):
            with self.subTest(mapping=mapping), self.assertRaises(ValueError):
                replace(problem, auxiliary_geometry_object_ids=mapping)

    def test_ir_and_physics_graph_keep_identity_display_and_geometry_separate(self):
        self.study.antenna_object(self.shape(), name="Readable antenna", object_id="antenna-id")
        problem = self.problem()
        ir = problem.to_ir(include_geometry_assets=False)
        graph = build_physics_graph(problem).to_ir()
        for objects in (ir["physics_objects"], graph["objects"]):
            obj = next(entry for entry in objects if entry["type"] == "antenna")
            self.assertEqual((obj["object_id"], obj["name"], obj["geometry_id"]),
                             ("antenna-id", "Readable antenna", "Readable antenna"))
        self.assertIn("Readable antenna", [entry["name"] for entry in ir["geometry"]["entries"]])

    def test_bootstrap_final_export_and_stage_signature_preserve_identity(self):
        temp_root = Path(os.environ["FULLMAG_TEST_TEMP_ROOT"]).resolve(strict=True)
        with tempfile.TemporaryDirectory(dir=temp_root) as directory:
            root = Path(directory)
            path = root / "authoring.py"
            path.write_text(
                "import fullmag as fm\n"
                "study = fm.study('auxiliary-render')\n"
                "study.engine('fdm')\n"
                "study.device('cpu', precision='double')\n"
                "study.objects.mesh.defaults(cell_size=(10e-9,10e-9,10e-9))\n"
                "study.disable_demag()\n"
                "film=study.geometry(fm.Box(100e-9,20e-9,10e-9),name='film',object_id='film-id')\n"
                "film.Ms=800e3\nfilm.Aex=13e-12\nfilm.alpha=0.01\n"
                "study.antenna_object(fm.Box(20e-9,40e-9,5e-9).translate((0,0,-6.000000000000001e-8)),name='Readable antenna',object_id='antenna-id')\n"
                "study.conductor(fm.Box(10e-9,20e-9,5e-9),name='Readable lead',object_id='lead-id')\n"
                "study.stages.add_run(stage_id='run-id',until=1e-12)\n", encoding="utf-8")
            loaded = load_problem_from_script(path, lightweight_assets=True)
            expected = {"Readable antenna": "antenna-id", "Readable lead": "lead-id"}
            self.assertFalse(loaded.auto_execute_stages)
            self.assertEqual(dict(loaded.problem.auxiliary_geometry_object_ids), expected)
            scene = build_scene_document_from_builder(export_builder_draft(loaded))
            antenna = next(obj for obj in scene["objects"] if obj["id"] == "antenna-id")
            self.assertEqual(antenna["name"], "Readable antenna")
            self.assertEqual(antenna["transform"]["translation"], [0, 0, -6.000000000000001e-8])
            previous_tempdir = tempfile.tempdir
            tempfile.tempdir = str(temp_root)
            try:
                sources = (render_scene_document_as_script(scene), render_loaded_problem_as_script(loaded))
            finally:
                tempfile.tempdir = previous_tempdir
            for index, rendered in enumerate(sources):
                exported = root / f"export-{index}.py"
                exported.write_text(rendered, encoding="utf-8")
                captured = load_problem_from_script(exported, lightweight_assets=True)
                self.assertFalse(captured.auto_execute_stages)
                self.assertEqual(dict(captured.problem.auxiliary_geometry_object_ids), expected)
                self.assertEqual([stage.stage_id for stage in captured.stages], ["run-id"])
                reimported = build_scene_document_from_builder(export_builder_draft(captured))
                result = next(obj for obj in reimported["objects"] if obj["id"] == "antenna-id")
                self.assertEqual(result["name"], antenna["name"])
                self.assertEqual(result["transform"]["translation"], antenna["transform"]["translation"])
            changed = replace(loaded.problem, auxiliary_geometry_object_ids={**expected, "Readable antenna": "different-id"})
            self.assertNotEqual(_stage_signature(loaded.problem), _stage_signature(changed))
            renamed = copy.deepcopy(scene)
            renamed_antenna = next(obj for obj in renamed["objects"] if obj["id"] == "antenna-id")
            renamed_antenna["name"] = "Renamed antenna"
            tempfile.tempdir = str(temp_root)
            try:
                renamed_source = render_scene_document_as_script(renamed)
            finally:
                tempfile.tempdir = previous_tempdir
            renamed_path = root / "renamed.py"
            renamed_path.write_text(renamed_source, encoding="utf-8")
            renamed_loaded = load_problem_from_script(renamed_path, lightweight_assets=True)
            self.assertFalse(renamed_loaded.auto_execute_stages)
            renamed_scene = build_scene_document_from_builder(export_builder_draft(renamed_loaded))
            preserved = next(obj for obj in renamed_scene["objects"] if obj["id"] == "antenna-id")
            self.assertEqual(preserved["name"], "Renamed antenna")
            self.assertEqual(preserved["transform"]["translation"], antenna["transform"]["translation"])
            self.assertEqual(dict(renamed_loaded.problem.auxiliary_geometry_object_ids), {"Renamed antenna": "antenna-id", "Readable lead": "lead-id"})


if __name__ == "__main__":
    faulthandler.dump_traceback_later(45, exit=True)
    unittest.main(verbosity=2)
