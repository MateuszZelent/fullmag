from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import fullmag as fm
import fullmag.world as world
from fullmag.runtime.scene_document import build_scene_document_from_builder, build_builder_from_scene_document
from fullmag.runtime.script_builder import (
    export_builder_draft, render_scene_document_as_script,
    _export_geometry_kind_params, _render_geometry_expr_from_override,
)


class GeometryAssetIdentityTests(unittest.TestCase):
    def setUp(self):
        fm.reset()
        self.guard = patch("subprocess.Popen", side_effect=AssertionError("no solver permitted"))
        self.guard.start()
        self.addCleanup(self.guard.stop)
        self.addCleanup(fm.reset)

    def load(self, source, root, name):
        path = root / name
        path.write_text(source, encoding="utf-8")
        return fm.load_problem_from_script(path, lightweight_assets=True)

    def test_geometry_key_survives_display_rename(self):
        source = """import fullmag as fm
study = fm.study("identity")
study.engine("fdm")
study.cell(5e-9, 5e-9, 5e-9)
film = study.geometry(fm.Box(10e-9, 10e-9, 5e-9), name="Film", object_id="immutable-film", geometry_name="persisted_geom")
film.Ms = 800e3
film.Aex = 13e-12
study.stages.add_run(until=1e-12)
"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            before = self.load(source, root, "before.py")
            scene = build_scene_document_from_builder(export_builder_draft(before))
            self.assertEqual(scene["objects"][0]["geometry"]["geometry_name"], "persisted_geom")
            scene["objects"][0]["name"] = "Renamed film"
            builder = build_builder_from_scene_document(scene)
            self.assertEqual(builder["geometries"][0]["geometry_name"], "persisted_geom")
            after = self.load(render_scene_document_as_script(scene), root, "after.py")
            self.assertEqual([g.to_ir() for g in before.problem._collect_geometries()],
                             [g.to_ir() for g in after.problem._collect_geometries()])
            self.assertEqual(after.problem.magnets[0].object_id, "immutable-film")
            self.assertEqual(after.problem.magnets[0].name, "Renamed film")

    def test_legacy_geometry_names_remain_unchanged(self):
        film = fm.geometry(fm.Box(1e-8, 1e-8, 5e-9), name="film")
        self.assertEqual(film._resolved_geometry().geometry_name, "film_geom")
        aux = fm.geometry_object(fm.Box(1e-8, 1e-8, 5e-9), name="wire")
        self.assertEqual(aux.geometry_name, "wire")

    def test_explicit_auxiliary_key_does_not_change_implicit_object_id(self):
        study = fm.study("implicit-identity")
        study.engine("fem")
        study.objects.mesh.defaults(maximum_element_size=5e-9)
        study.conductor(fm.Box(10e-9, 10e-9, 5e-9), name="Display", geometry_name="stable-key")
        self.assertEqual(world._build_problem().auxiliary_geometry_object_ids, {"stable-key": "Display"})

    def test_auxiliary_label_is_separate_in_both_physics_producers(self):
        study = fm.study("auxiliary-label")
        study.engine("fem")
        study.objects.mesh.defaults(maximum_element_size=5e-9)
        fm.antenna_object(fm.Box(1e-8, 1e-8, 5e-9), name="Gold wire",
                          object_id="immutable-wire", geometry_name="wire_geom")
        problem = world._build_problem()
        ir = problem.to_ir(include_geometry_assets=False)
        for objects in (ir["physics_objects"], ir["physics_graph"]["objects"]):
            self.assertEqual(objects[0]["name"], "Gold wire")
            self.assertEqual(objects[0]["geometry_id"], "wire_geom")
            self.assertEqual(objects[0]["object_id"], "immutable-wire")

    def test_nested_translate_preserves_names_and_both_offsets(self):
        shape = fm.Translate(fm.Translate(fm.Box(1, 2, 3, name="inner"),
                                         (1, 2, 3), name="middle"),
                             (4, 5, 6), name="outer")
        kind, params = _export_geometry_kind_params(shape)
        expr = _render_geometry_expr_from_override(kind, params, name="display", source_root=Path("."))
        restored = eval(expr, {"fm": fm})
        self.assertEqual(restored.to_ir(), shape.to_ir())

    def test_named_csg_children_survive_export(self):
        shape = fm.Difference(fm.Box(3, 3, 3, name="solid"),
                              fm.Cylinder(radius=1, height=3, name="hole"), name="cut")
        kind, params = _export_geometry_kind_params(shape)
        restored = eval(_render_geometry_expr_from_override(kind, params, name="display",
                                                           source_root=Path(".")), {"fm": fm})
        self.assertEqual(restored.to_ir(), shape.to_ir())

    def test_global_geometry_key_collisions_are_rejected(self):
        for pair in (("magnet", "magnet"), ("aux", "aux"), ("magnet", "aux")):
            with self.subTest(pair=pair):
                fm.reset()
                with self.assertRaisesRegex(ValueError, "geometry"):
                    for index, role in enumerate(pair):
                        register = fm.geometry if role == "magnet" else fm.geometry_object
                        register(fm.Box(1, 1, 1), name="object" + str(index),
                                 object_id="id" + str(index), geometry_name="shared")


    def test_auxiliary_scene_rename_preserves_geometry_and_mesh_recipe(self):
        source = """import fullmag as fm
study = fm.study("auxiliary-identity")
study.engine("fem")
study.objects.mesh.defaults(maximum_element_size=20e-9)
wire = study.conductor(fm.Box(100e-9, 20e-9, 10e-9), name="Gold wire",
                       object_id="immutable-wire", geometry_name="wire_geom")
study.objects.mesh.by_id("immutable-wire")(maximum_element_size=10e-9)
"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            before = self.load(source, root, "wire.py")
            scene = build_scene_document_from_builder(export_builder_draft(before))
            scene["objects"][0]["name"] = "Renamed wire"
            after = self.load(render_scene_document_as_script(scene), root, "wire_after.py")
            self.assertEqual([g.to_ir() for g in before.problem.auxiliary_geometries],
                             [g.to_ir() for g in after.problem.auxiliary_geometries])
            self.assertEqual(before.problem.runtime_metadata["mesh_workflow"]["per_geometry"],
                             after.problem.runtime_metadata["mesh_workflow"]["per_geometry"])
            self.assertEqual(after.problem.auxiliary_geometry_names, {"wire_geom": "Renamed wire"})

    def test_explicit_magnetic_mesh_recipe_uses_geometry_key(self):
        study = fm.study("magnetic-recipe")
        study.engine("fem")
        study.objects.mesh.defaults(maximum_element_size=20e-9)
        film = study.geometry(fm.Box(100e-9, 20e-9, 10e-9), name="Film",
                              object_id="immutable-film", geometry_name="film_key")
        film.Ms, film.Aex = 800e3, 13e-12
        film.mesh(maximum_element_size=10e-9)
        problem = world._build_problem()
        recipe = problem.runtime_metadata["mesh_workflow"]["per_geometry"][0]
        self.assertEqual(recipe["geometry"], "film_key")
        from fullmag.runtime.script_builder import _export_geometry_entry
        entry = _export_geometry_entry(problem.magnets[0], problem, source_root=Path("."))
        self.assertEqual(entry["mesh"]["hmax"], "1e-08")

    def test_class_based_problem_rejects_shared_geometry_key(self):
        from dataclasses import replace
        film = fm.geometry(fm.Box(1e-8, 1e-8, 5e-9), name="film")
        film.Ms, film.Aex = 800e3, 13e-12
        problem = world._build_problem()
        with self.assertRaisesRegex(ValueError, "geometry"):
            replace(problem, magnets=[problem.magnets[0],
                    replace(problem.magnets[0], name="other", object_id="other-id")])

    def test_geometry_keys_reject_whitespace_and_empty_values(self):
        for value in ("", " key", "key ", 5):
            with self.subTest(value=value):
                with self.assertRaises((ValueError, TypeError)):
                    fm.geometry(fm.Box(1, 1, 1), geometry_name=value)


if __name__ == "__main__":
    unittest.main()
