from __future__ import annotations

import copy
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

import fullmag as fm
import fullmag.world as world
from fullmag.runtime.scene_document import build_scene_document_from_builder, build_builder_from_scene_document, builder_overrides_from_scene_document
from fullmag.runtime.script_builder import export_builder_draft, render_scene_document_as_script

SOURCE = """import fullmag as fm
study = fm.study("domain-source")
study.engine("fem")
study.objects.mesh.defaults(maximum_element_size=20e-9)
film = study.geometry(fm.Box(100e-9, 20e-9, 10e-9), name="Film",
                      object_id="immutable-film", geometry_name="film_geom")
film.Ms = 800e3
film.Aex = 13e-12
film.add_region("Core", fm.Box(20e-9, 20e-9, 10e-9), region_id="core-id",
                realization_policy="conformal")
study.domain_mesh("retained.fullmag-mesh", region_markers={"film_geom": 1},
                  object_region_markers={"Core": 2})
study.stages.add_run(until=1e-12)
"""


class ExplicitDomainRoundtripTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        fm.reset()
        self.addCleanup(fm.reset)
        self.guard = patch("subprocess.Popen", side_effect=AssertionError("no solver permitted"))
        self.guard.start()
        self.addCleanup(self.guard.stop)

    def load(self, text=SOURCE, name="source.py"):
        path = self.root / name
        path.write_text(text, encoding="utf-8")
        return fm.load_problem_from_script(path, lightweight_assets=True)

    def test_legacy_capture_exports_source_maps_and_static_owners(self):
        loaded = self.load()
        builder = export_builder_draft(loaded)
        source = builder["shared_domain_mesh_source"]
        self.assertEqual(source["kind"], "explicit")
        self.assertEqual(source["source"], "retained.fullmag-mesh")
        self.assertEqual(source["object_region_markers"], [{"geometry_name": "Core", "marker": 2}])
        self.assertEqual(source["marker_owners"], [
            {"table": "region_markers", "geometry_name": "film_geom", "marker": 1,
             "target": {"object_id": "immutable-film"}},
            {"table": "object_region_markers", "geometry_name": "Core", "marker": 2,
             "target": {"object_id": "immutable-film", "region_id": "core-id"}},
        ])

    def test_scene_rename_preserves_source_and_full_mesh_workflow(self):
        before = self.load()
        scene = build_scene_document_from_builder(export_builder_draft(before))
        source = copy.deepcopy(scene["study"]["shared_domain_mesh_source"])
        scene["objects"][0]["name"] = "Renamed film"
        builder = build_builder_from_scene_document(scene)
        self.assertEqual(builder["shared_domain_mesh_source"], source)
        after = self.load(render_scene_document_as_script(scene), "after.py")
        self.assertEqual(before.problem.runtime_metadata["mesh_workflow"],
                         after.problem.runtime_metadata["mesh_workflow"])

    def test_missing_owner_is_rejected_before_materialization(self):
        loaded = self.load()
        problem = loaded.problem
        other = replace(problem.magnets[0], object_id="replacement-id")
        with self.assertRaisesRegex(ValueError, "owner"):
            replace(problem, magnets=[other]).to_ir(include_geometry_assets=False)

    def test_region_alias_drift_is_rejected_without_remapping(self):
        problem = self.load().problem
        magnet = problem.magnets[0]
        region = replace(magnet.object_regions[0], name="Renamed core", _context_guard=None)
        with self.assertRaisesRegex(ValueError, "owner"):
            replace(problem, magnets=[replace(magnet, object_regions=[region])]).to_ir(include_geometry_assets=False)

    def test_disabled_exact_region_id_wins_over_active_alias(self):
        problem = self.load(SOURCE.replace('{"Core": 2}', '{"core-id": 2}')).problem
        magnet = problem.magnets[0]
        disabled = replace(magnet.object_regions[0], enabled=False, _context_guard=None)
        alias = replace(disabled, region_id="other-id", name="core-id", enabled=True)
        with self.assertRaisesRegex(ValueError, "owner"):
            replace(problem, magnets=[replace(magnet, object_regions=[disabled, alias],
                    allocated_region_ids=("core-id", "other-id"))]).to_ir(include_geometry_assets=False)

    def test_generated_reset_and_absent_declaration_are_distinct(self):
        loaded = self.load()
        scene = build_scene_document_from_builder(export_builder_draft(loaded))
        del scene["study"]["shared_domain_mesh_source"]
        self.assertNotIn("shared_domain_mesh_source", builder_overrides_from_scene_document(scene))
        scene["study"]["shared_domain_mesh_source"] = {"kind": "generated"}
        overrides = builder_overrides_from_scene_document(scene)
        self.assertEqual(overrides["shared_domain_mesh_source"], {"kind": "generated"})
        rendered = render_scene_document_as_script(scene)
        self.assertNotIn("study.domain_mesh(", rendered)

    def test_new_declaration_rejects_null_and_incomplete_owners(self):
        from fullmag.runtime.domain_mesh_source import normalize_shared_domain_mesh_source
        with self.assertRaises(ValueError):
            normalize_shared_domain_mesh_source(None)
        for value in [
            {"kind": "generated", "source": "unexpected"},
            {"kind": "explicit", "source": "x", "region_markers": []},
            {"kind": "explicit", "source": "x", "region_markers": [{"geometry_name": "x", "marker": True}], "marker_owners": []},
            {"kind": "explicit", "source": "x", "region_markers": [{"geometry_name": "x", "marker": 1}], "marker_owners": []},
        ]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                normalize_shared_domain_mesh_source(value)

    def test_all_air_source_has_empty_maps_and_owners(self):
        text = """import fullmag as fm
study = fm.study("air")
study.engine("fem")
study.objects.mesh.defaults(maximum_element_size=20e-9)
study.antenna_object(fm.Box(100e-9, 20e-9, 10e-9), name="wire")
study.domain_mesh("air.fullmag-mesh", region_markers=[])
"""
        source = export_builder_draft(self.load(text))["shared_domain_mesh_source"]
        self.assertEqual(source["region_markers"], [])
        self.assertEqual(source["marker_owners"], [])

    def test_legacy_owner_capture_is_not_repeated_for_later_stages(self):
        text = SOURCE + """
film.regions["core-id"].name = "Former core"
film.add_region("Core", fm.Box(10e-9, 10e-9, 10e-9).translate((30e-9, 0, 0)),
                region_id="replacement-id", realization_policy="conformal")
study.stages.add_run(until=2e-12)
"""
        with self.assertRaisesRegex(ValueError, "owner"):
            self.load(text)

    def test_mesh_defaults_export_preserves_requested_presence(self):
        loaded = self.load()
        absent = export_builder_draft(loaded)["mesh"]
        fields = ("algorithm_2d", "algorithm_3d", "compute_quality", "per_element_quality")
        self.assertTrue(all(key not in absent for key in fields))
        text = SOURCE.replace(
            "maximum_element_size=20e-9)",
            "maximum_element_size=20e-9, algorithm_2d=6, algorithm_3d=1, compute_quality=False, per_element_quality=True)",
        )
        loaded = self.load(text, "explicit_defaults.py")
        explicit = export_builder_draft(loaded)["mesh"]
        self.assertEqual({key: explicit[key] for key in fields},
                         {"algorithm_2d": 6, "algorithm_3d": 1,
                          "compute_quality": False, "per_element_quality": True})

    def test_shared_marker_owner_fixture(self):
        import json
        from fullmag.runtime.domain_mesh_source import validate_scene_domain_marker_owners
        root = Path(__file__).resolve().parents[3]
        fixture = root / "crates/fullmag-authoring/tests/fixtures/domain_marker_owner_cases.json"
        for case in json.loads(fixture.read_text())["cases"]:
            with self.subTest(case=case["id"]):
                if case["valid"]:
                    validate_scene_domain_marker_owners(case["source"], case["objects"])
                else:
                    with self.assertRaises(ValueError):
                        validate_scene_domain_marker_owners(case["source"], case["objects"])

    def test_rejected_domain_mesh_preserves_previous_source_and_frozen_owners(self):
        exec(SOURCE, {})
        before = copy.deepcopy(world._build_problem().runtime_metadata["mesh_workflow"])
        state_fields = ("_domain_mesh_source", "_domain_region_markers",
                        "_domain_object_region_markers", "_domain_marker_owners")
        frozen = copy.deepcopy([getattr(world._state, field) for field in state_fields])
        for kwargs in (
            {"region_markers": {"film_geom": 9}, "object_region_markers": {"Core": 9}},
            {"region_markers": {"film_geom": 9}, "marker_owners": []},
            {"region_markers": {"film_geom": 9}, "object_region_markers": [],
             "marker_owners": [{"table": "region_markers", "geometry_name": "film_geom",
                                "marker": True, "target": fm.RegionRef("immutable-film")}]},
        ):
            with self.subTest(kwargs=kwargs):
                with self.assertRaises(ValueError):
                    fm.domain_mesh("rejected.fullmag-mesh", **kwargs)
                self.assertEqual([getattr(world._state, field) for field in state_fields], frozen)
                after = world._build_problem().runtime_metadata["mesh_workflow"]
                self.assertEqual(after, before)

    def test_scene_roundtrip_preserves_absent_and_empty_object_marker_table(self):
        loaded = self.load()
        for explicit_empty in (False, True):
            with self.subTest(explicit_empty=explicit_empty):
                scene = build_scene_document_from_builder(export_builder_draft(loaded))
                declaration = scene["study"]["shared_domain_mesh_source"]
                declaration.pop("object_region_markers")
                declaration["marker_owners"] = declaration["marker_owners"][:1]
                if explicit_empty:
                    declaration["object_region_markers"] = []
                after = self.load(render_scene_document_as_script(scene), "empty-map.py")
                restored = build_scene_document_from_builder(export_builder_draft(after))
                self.assertEqual(restored["study"]["shared_domain_mesh_source"], declaration)

    def test_source_declaration_does_not_grant_fdm_execution(self):
        scene = build_scene_document_from_builder(export_builder_draft(self.load()))
        scene["study"]["requested_backend"] = "fdm"
        scene["study"]["backend"] = "fdm"
        with self.assertRaisesRegex(ValueError, "FEM"):
            build_builder_from_scene_document(scene)


if __name__ == "__main__":
    unittest.main()
