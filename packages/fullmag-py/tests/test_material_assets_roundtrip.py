"""Self-contained material identity and source metadata in canonical scripts."""
import copy
import re
import tempfile
import unittest
from pathlib import Path

import fullmag as fm
from fullmag.runtime.scene_document import (
    build_builder_from_scene_document,
    build_scene_document_from_builder,
    builder_overrides_from_scene_document,
)
from fullmag.runtime.script_builder import (
    export_builder_draft,
    render_loaded_problem_as_script,
    render_scene_document_as_script,
)


PROPERTIES = {"Ms": 800000.0, "Aex": 1.3e-11, "alpha": 0.01, "Dind": None, "Dbulk": None}
REFERENCES = [
    {"label": "Sample", "citation": "Measured film A", "url": None},
    {"label": "Method", "url": "https://example.org/method", "citation": None},
]
SOURCE = {
    "catalog_id": "builtin:permalloy", "catalog_revision": 1,
    "name": "Permalloy Ni80Fe20", "kind": "builtin",
    "properties": copy.deepcopy(PROPERTIES), "references": copy.deepcopy(REFERENCES),
}


def material_scene(*, shared=False):
    geometries = []
    for index in range(2 if shared else 1):
        geometries.append({
            "object_id": f"body-{index}", "name": f"body {index}",
            "geometry_kind": "box", "geometry_params": {"size": [100e-9, 20e-9, 5e-9]},
            "material": copy.deepcopy(PROPERTIES),
            "magnetization": {"kind": "uniform", "value": [1, 0, 0]},
        })
    scene = build_scene_document_from_builder({
        "revision": 1, "backend": "fem", "requested_device": "cpu",
        "geometries": geometries,
    })
    scene["materials"] = [{
        "id": "mat:measured", "name": "Measured sample", "properties": copy.deepcopy(PROPERTIES),
        "references": copy.deepcopy(REFERENCES), "source": copy.deepcopy(SOURCE),
    }]
    for obj in scene["objects"]:
        obj["material_ref"] = "mat:measured"
    return scene


class TestMaterialAssetsRoundtrip(unittest.TestCase):
    def test_scene_builder_roundtrip_preserves_identity_references_source_and_sharing(self):
        scene = material_scene(shared=True)
        builder = build_builder_from_scene_document(scene)
        self.assertEqual(builder["material_assets"]["version"], "fullmag.material-assets.v1")
        self.assertEqual(builder_overrides_from_scene_document(scene)["material_assets"], builder["material_assets"])
        rebuilt = build_scene_document_from_builder(builder)
        self.assertEqual(rebuilt["materials"], scene["materials"])
        self.assertEqual([obj["material_ref"] for obj in rebuilt["objects"]], ["mat:measured"] * 2)

    def test_dormant_catalog_dmi_remains_disabled_after_script_roundtrip(self):
        scene = material_scene()
        scene["materials"][0]["properties"].update(Dind=-0.001, Dbulk=0.002)
        scene["objects"][0]["physics_stack"].extend([
            {"kind": "interfacial_dmi", "enabled": False, "params": {"dind": -0.001}},
            {"kind": "bulk_dmi", "enabled": False, "params": {"dbulk": 0.002}},
        ])
        canonical = render_scene_document_as_script(scene)
        with tempfile.TemporaryDirectory(prefix="fullmag-material-dmi-") as temporary:
            path = Path(temporary) / "dmi.py"
            path.write_text(canonical, encoding="utf-8")
            rebuilt = build_scene_document_from_builder(export_builder_draft(str(path)))
        entries = {entry["kind"]: entry for entry in rebuilt["objects"][0]["physics_stack"]}
        self.assertFalse(entries["interfacial_dmi"]["enabled"])
        self.assertFalse(entries["bulk_dmi"]["enabled"])
        self.assertEqual(rebuilt["materials"][0]["properties"], scene["materials"][0]["properties"])

    def test_unassigned_material_survives_roundtrip(self):
        scene = material_scene()
        unassigned = copy.deepcopy(scene["materials"][0])
        unassigned.update(id="mat:unassigned", name="Unused sample")
        scene["materials"].append(unassigned)
        rebuilt = build_scene_document_from_builder(build_builder_from_scene_document(scene))
        self.assertEqual(rebuilt["materials"], scene["materials"])

    def test_legacy_effective_references_roundtrip_without_catalog_limits(self):
        scene = material_scene()
        material = scene["materials"][0]
        material.pop("source")
        refs = [{"label": "Historical reference " + str(index)} for index in range(65)]
        refs.append({"label": "Long label " * 70, "url": "https:///path"})
        material["references"] = refs
        material["id"] = " legacy-material "
        material["name"] = " Legacy material "
        scene["objects"][0]["material_ref"] = material["id"]
        canonical = render_scene_document_as_script(scene)
        with tempfile.TemporaryDirectory(prefix="fullmag-material-old-") as temporary:
            path = Path(temporary) / "legacy.py"
            path.write_text(canonical, encoding="utf-8")
            rebuilt = build_scene_document_from_builder(export_builder_draft(str(path)))
        self.assertEqual(rebuilt["materials"][0], material)
        self.assertEqual(rebuilt["objects"][0]["material_ref"], material["id"])

    def test_effective_parameters_always_override_stale_metadata(self):
        builder = build_builder_from_scene_document(material_scene())
        builder["geometries"][0]["material"]["Ms"] = 900000.0
        rebuilt = build_scene_document_from_builder(builder)
        material = rebuilt["materials"][0]
        self.assertEqual(material["id"], "mat:measured")
        self.assertEqual(material["properties"]["Ms"], 900000.0)
        self.assertEqual(material["source"]["properties"]["Ms"], 800000.0)
        self.assertEqual(material["references"], REFERENCES)

    def test_individual_change_splits_shared_material_without_overwriting_other_object(self):
        builder = build_builder_from_scene_document(material_scene(shared=True))
        builder["geometries"][1]["material"]["Ms"] = 900000.0
        self.assertEqual(builder["geometries"][0]["material"]["Ms"], 800000.0)
        rebuilt = build_scene_document_from_builder(builder)
        materials = {mat["id"]: mat for mat in rebuilt["materials"]}
        first, second = rebuilt["objects"]
        self.assertEqual(first["material_ref"], "mat:measured")
        self.assertNotEqual(second["material_ref"], first["material_ref"])
        self.assertEqual(materials[first["material_ref"]]["properties"]["Ms"], 800000.0)
        self.assertEqual(materials[second["material_ref"]]["properties"]["Ms"], 900000.0)
        self.assertEqual(materials[second["material_ref"]]["source"], SOURCE)
        again = build_scene_document_from_builder(builder)
        self.assertEqual(again["materials"], rebuilt["materials"])

    def test_shared_material_edited_equally_keeps_identity(self):
        builder = build_builder_from_scene_document(material_scene(shared=True))
        for geom in builder["geometries"]:
            geom["material"]["alpha"] = 0.02
        rebuilt = build_scene_document_from_builder(builder)
        self.assertEqual(len(rebuilt["materials"]), 1)
        self.assertEqual(rebuilt["materials"][0]["id"], "mat:measured")
        self.assertEqual(rebuilt["materials"][0]["properties"]["alpha"], 0.02)

    def test_rename_does_not_change_material_identity(self):
        builder = build_builder_from_scene_document(material_scene())
        builder["geometries"][0]["name"] = "Renamed body"
        rebuilt = build_scene_document_from_builder(builder)
        self.assertEqual(rebuilt["objects"][0]["material_ref"], "mat:measured")
        self.assertEqual(rebuilt["materials"][0]["name"], "Measured sample")

    def test_rust_builder_without_object_id_uses_explicit_identity_map(self):
        builder = build_builder_from_scene_document(material_scene())
        self.assertEqual(builder["material_assets"]["object_ids"], {"body 0": "body-0"})
        builder["geometries"][0].pop("object_id")
        rebuilt = build_scene_document_from_builder(builder)
        self.assertEqual(rebuilt["objects"][0]["id"], "body-0")
        self.assertEqual(rebuilt["objects"][0]["material_ref"], "mat:measured")

    def test_removed_and_new_objects_do_not_infer_a_catalog_source(self):
        builder = build_builder_from_scene_document(material_scene())
        fresh = copy.deepcopy(builder["geometries"][0])
        fresh.update(object_id="body-new", name="new body")
        builder["geometries"] = [fresh]
        rebuilt = build_scene_document_from_builder(builder)
        materials = {mat["id"]: mat for mat in rebuilt["materials"]}
        self.assertIn("mat:measured", materials)
        new = materials[rebuilt["objects"][0]["material_ref"]]
        self.assertIsNone(new.get("source"))
        self.assertEqual(new.get("references", []), [])

    def test_replacement_geometry_without_object_id_does_not_inherit_material_source(self):
        scene = material_scene()
        canonical = render_scene_document_as_script(scene)
        edited, count = re.subn(
            r"(?m)^(\w+ = (?:study|fm)\.geometry)\([^\n]+\)$",
            r"\1(fm.Box(200e-9, 20e-9, 5e-9), name='body 0')",
            canonical,
            count=1,
        )
        self.assertEqual(count, 1)
        self.assertIn("fm.runtime_metadata('material_assets'", edited)
        with tempfile.TemporaryDirectory(prefix="fullmag-material-replacement-") as temporary:
            path = Path(temporary) / "replacement.py"
            path.write_text(edited, encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)
            builder = export_builder_draft(loaded)
            rebuilt = build_scene_document_from_builder(builder)
        self.assertEqual(builder["geometries"][0]["object_id"], "body 0")
        replacement = rebuilt["objects"][0]
        self.assertEqual(replacement["id"], "body 0")
        self.assertEqual(replacement["name"], "body 0")
        materials = {material["id"]: material for material in rebuilt["materials"]}
        self.assertNotEqual(replacement["material_ref"], "mat:measured")
        self.assertIsNone(materials[replacement["material_ref"]].get("source"))
        self.assertEqual(materials[replacement["material_ref"]].get("references", []), [])
        self.assertEqual(materials["mat:measured"], scene["materials"][0])
        self.assertNotIn("mat:measured", [obj["material_ref"] for obj in rebuilt["objects"]])

    def test_replacement_without_object_id_keeps_default_identity_without_old_source(self):
        scene = material_scene()
        scene["objects"][0]["id"] = scene["objects"][0]["name"]
        canonical = render_scene_document_as_script(scene)
        edited, count = re.subn(
            r"(?m)^(\w+ = (?:study|fm)\.geometry)\([^\n]+\)$",
            r"\1(fm.Box(200e-9, 20e-9, 5e-9), name='body 0')",
            canonical,
            count=1,
        )
        self.assertEqual(count, 1)
        with tempfile.TemporaryDirectory(prefix="fullmag-material-default-identity-") as temporary:
            path = Path(temporary) / "replacement.py"
            path.write_text(edited, encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)
            original_metadata = copy.deepcopy(loaded.problem.runtime_metadata["material_assets"])
            builder = export_builder_draft(loaded)
            rebuilt = build_scene_document_from_builder(builder)
            self.assertEqual(loaded.problem.runtime_metadata["material_assets"], original_metadata)
        replacement = rebuilt["objects"][0]
        self.assertEqual(builder["geometries"][0]["object_id"], "body 0")
        self.assertEqual(replacement["id"], "body 0")
        self.assertEqual(replacement["name"], "body 0")
        materials = {material["id"]: material for material in rebuilt["materials"]}
        self.assertNotEqual(replacement["material_ref"], "mat:measured")
        self.assertIsNone(materials[replacement["material_ref"]].get("source"))
        self.assertEqual(materials[replacement["material_ref"]].get("references", []), [])
        self.assertEqual(materials["mat:measured"], scene["materials"][0])
        self.assertNotIn("mat:measured", [obj["material_ref"] for obj in rebuilt["objects"]])

    def test_legacy_material_does_not_gain_source_from_name_or_equal_values(self):
        builder = build_builder_from_scene_document(material_scene())
        builder.pop("material_assets", None)
        rebuilt = build_scene_document_from_builder(builder)
        self.assertIsNone(rebuilt["materials"][0].get("source"))

    def test_malformed_metadata_is_rejected(self):
        builder = build_builder_from_scene_document(material_scene())
        malformed = [
            [],
            {"version": "unsupported", "materials": [], "assignments": {}},
            {"version": "fullmag.material-assets.v1", "materials": [], "assignments": {"body-0": "missing"}},
        ]
        duplicate = copy.deepcopy(builder["material_assets"])
        duplicate["materials"].append(copy.deepcopy(duplicate["materials"][0]))
        malformed.append(duplicate)
        invalid_source = copy.deepcopy(builder["material_assets"])
        invalid_source["materials"][0]["source"]["properties"]["Ms"] = float("inf")
        malformed.append(invalid_source)
        for metadata in malformed:
            with self.subTest(metadata=metadata):
                broken = copy.deepcopy(builder)
                broken["material_assets"] = metadata
                with self.assertRaisesRegex(ValueError, "material_assets"):
                    build_scene_document_from_builder(broken)

    def test_source_validation_matches_the_catalog_contract(self):
        mutations = [
            ("nonpositive Ms", lambda source: source["properties"].update(Ms=0)),
            ("mismatched identity", lambda source: source.update(catalog_id="custom:wrong")),
            ("invalid identity", lambda source: source.update(catalog_id="builtin:invalid id")),
            ("long identity", lambda source: source.update(catalog_id="builtin:" + "a" * 160)),
            ("long name", lambda source: source.update(name="a" * 241)),
            ("too many references", lambda source: source.update(references=[{}] * 65)),
            ("hostless URL", lambda source: source.update(references=[{"url": "https:///path"}])),
            ("URL whitespace", lambda source: source.update(references=[{"url": "https://exam ple.org"}])),
        ]
        for label, mutate in mutations:
            with self.subTest(invalid=label):
                scene = material_scene()
                mutate(scene["materials"][0]["source"])
                with self.assertRaisesRegex(ValueError, "material_assets"):
                    build_builder_from_scene_document(scene)

    def test_canonical_script_roundtrip_preserves_material_and_independent_source(self):
        scene = material_scene()
        scene["materials"][0]["properties"]["Ms"] = 900000.0
        canonical = render_scene_document_as_script(scene)
        self.assertIn("fm.runtime_metadata('material_assets'", canonical)
        with tempfile.TemporaryDirectory(prefix="fullmag-material-assets-") as temporary:
            path = Path(temporary) / "materials.py"
            path.write_text(canonical, encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)
            rebuilt = build_scene_document_from_builder(export_builder_draft(loaded))
            self.assertEqual(rebuilt["materials"], scene["materials"])
            self.assertEqual(rebuilt["objects"][0]["material_ref"], "mat:measured")
            rewritten = render_loaded_problem_as_script(loaded)
            self.assertIn("fm.runtime_metadata('material_assets'", rewritten)

    def test_inactive_zero_dmi_survives_without_activating_an_interaction(self):
        scene = material_scene()
        scene["materials"][0]["properties"].update(Dind=0.0, Dbulk=0.0)
        canonical = render_scene_document_as_script(scene)
        self.assertNotRegex(canonical, r"\.D(?:ind|bulk)\s*=")
        with tempfile.TemporaryDirectory(prefix="fullmag-material-zero-") as temporary:
            path = Path(temporary) / "zero.py"
            path.write_text(canonical, encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)
            rebuilt = build_scene_document_from_builder(export_builder_draft(loaded))
        self.assertEqual(rebuilt["materials"][0]["properties"]["Dind"], 0.0)
        self.assertEqual(rebuilt["materials"][0]["properties"]["Dbulk"], 0.0)
        kinds = {term["kind"] for term in rebuilt["objects"][0]["physics_stack"]}
        self.assertNotIn("interfacial_dmi", kinds)
        self.assertNotIn("bulk_dmi", kinds)

    def test_signed_active_dmi_roundtrips(self):
        for key in ("Dind", "Dbulk"):
            with self.subTest(coefficient=key):
                scene = material_scene()
                scene["materials"][0]["properties"][key] = -0.001
                canonical = render_scene_document_as_script(scene)
                with tempfile.TemporaryDirectory(prefix="fullmag-material-dmi-") as temporary:
                    path = Path(temporary) / "signed.py"
                    path.write_text(canonical, encoding="utf-8")
                    loaded = fm.load_problem_from_script(path, lightweight_assets=True)
                    rebuilt = build_scene_document_from_builder(export_builder_draft(loaded))
                self.assertEqual(rebuilt["materials"][0]["properties"][key], -0.001)
                self.assertIsNone(rebuilt["materials"][0]["source"]["properties"][key])

    def test_removed_nonzero_dmi_is_not_restored_from_metadata(self):
        scene = material_scene()
        scene["materials"][0]["properties"]["Dind"] = -0.001
        canonical = render_scene_document_as_script(scene)
        edited, count = re.subn(r"[^\n]*\.Dind\s*=\s*[^\n]+\n", "", canonical, count=1)
        self.assertEqual(count, 1)
        with tempfile.TemporaryDirectory(prefix="fullmag-material-remove-dmi-") as temporary:
            path = Path(temporary) / "removed.py"
            path.write_text(edited, encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)
            rebuilt = build_scene_document_from_builder(export_builder_draft(loaded))
        self.assertIsNone(rebuilt["materials"][0]["properties"]["Dind"])

    def test_manual_script_parameter_change_wins_over_material_metadata(self):
        canonical = render_scene_document_as_script(material_scene())
        edited, count = re.subn(r"(\.Ms\s*=\s*)[^\n]+", r"\g<1>975000.0", canonical, count=1)
        self.assertEqual(count, 1)
        with tempfile.TemporaryDirectory(prefix="fullmag-material-edit-") as temporary:
            path = Path(temporary) / "edited.py"
            path.write_text(edited, encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)
            rebuilt = build_scene_document_from_builder(export_builder_draft(loaded))
        material = rebuilt["materials"][0]
        self.assertEqual(material["properties"]["Ms"], 975000.0)
        self.assertEqual(material["source"]["properties"]["Ms"], 800000.0)
        self.assertEqual(material["references"], REFERENCES)


if __name__ == "__main__":
    unittest.main()
