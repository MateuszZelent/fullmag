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
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)
            rebuilt = build_scene_document_from_builder(export_builder_draft(loaded))
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
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)
            rebuilt = build_scene_document_from_builder(export_builder_draft(loaded))
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

    def test_active_dmi_can_keep_a_null_catalog_coefficient(self):
        scene = material_scene()
        scene["objects"][0]["physics_stack"].append({
            "kind": "interfacial_dmi", "enabled": True, "params": {"dind": 0.0},
        })
        canonical = render_scene_document_as_script(scene)
        self.assertRegex(canonical, r"\.Dind\s*=\s*0")
        edited, count = re.subn(r"(\.Dind\s*=\s*)[^\n]+", r"\g<1>0.003", canonical, count=1)
        self.assertEqual(count, 1)
        with tempfile.TemporaryDirectory(prefix="fullmag-material-active-dmi-") as temporary:
            path = Path(temporary) / "active.py"
            for text, coefficient in ((canonical, None), (edited, 0.003)):
                with self.subTest(coefficient=coefficient):
                    path.write_text(text, encoding="utf-8")
                    loaded = fm.load_problem_from_script(path, lightweight_assets=True)
                    rebuilt = build_scene_document_from_builder(export_builder_draft(loaded))
                    self.assertEqual(rebuilt["materials"][0]["properties"]["Dind"], coefficient)
                    interaction = next(entry for entry in rebuilt["objects"][0]["physics_stack"]
                                       if entry["kind"] == "interfacial_dmi")
                    self.assertTrue(interaction["enabled"])

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


def test_published_version_assignment_preserves_dormant_dmi_and_exports_offline(tmp_path):
    published = copy.deepcopy(PUBLISHED)
    source = tmp_path / "catalog.py"
    source.write_text(
        "import fullmag as fm\n"
        "disc = fm.geometry(fm.Box(20e-9, 10e-9, 5e-9), name='disc')\n"
        "disc.Ku1 = 200.0\n"
        "disc.anisU = (0.0, 0.0, 1.0)\n"
        "disc.material = fm.materials.yig.kuswik\n"
        "assert disc.Dind == -0.002\n"
        "disc.Ms = 975000.0\n",
        encoding="utf-8",
    )
    loaded = fm.load_problem_from_script(source, lightweight_assets=True, material_catalog=[published])
    published["source"]["properties"]["Dind"] = -0.003
    assert not any(isinstance(term, fm.InterfacialDMI) for term in loaded.problem.energy)
    assert loaded.problem.magnets[0].material.Dind is None
    assert loaded.problem.magnets[0].material.Ku1 == 200.0
    assert loaded.problem.magnets[0].material.anisU == (0, 0, 1)
    first = build_scene_document_from_builder(export_builder_draft(loaded))
    material = first["materials"][0]
    assert material["name"] == "Measured YIG alias"
    assert material["source"] == PUBLISHED["source"]
    assert material["properties"]["Ms"] == 975000.0
    assert material["properties"]["Dind"] == -0.002
    assert next(term for term in first["objects"][0]["physics_stack"]
                if term["kind"] == "interfacial_dmi")["enabled"] is False

    for script in (render_scene_document_as_script(first), render_loaded_problem_as_script(loaded)):
        assert "fm.materials.yig.kuswik" not in script
        canonical = tmp_path / "offline.py"
        canonical.write_text(script, encoding="utf-8")
        replayed = fm.load_problem_from_script(canonical, lightweight_assets=True)
        replay_scene = build_scene_document_from_builder(export_builder_draft(replayed))
        assert replay_scene["materials"] == first["materials"]
        assert replay_scene["objects"][0]["physics_stack"] == first["objects"][0]["physics_stack"]


def test_material_version_keeps_dormant_dmi_beside_explicit_zero(tmp_path):
    for parameter, kind, coefficient in (
        ("Dind", "interfacial_dmi", -0.002),
        ("Dbulk", "bulk_dmi", 0.003),
    ):
        _assert_material_version_keeps_dormant_dmi(tmp_path, parameter, kind, coefficient)


def _assert_material_version_keeps_dormant_dmi(tmp_path, parameter, kind, coefficient):
    published = copy.deepcopy(PUBLISHED)
    published["source"]["properties"][parameter] = coefficient
    path = tmp_path / "mixed.py"
    path.write_text(
        "import fullmag as fm\n"
        "a = fm.geometry(fm.Box(20e-9, 10e-9, 5e-9), name='a', object_id='first')\n"
        "a.Ms = 800000\n"
        "a.Aex = 1.3e-11\n"
        f"a.{parameter} = 0\n"
        "b = fm.geometry(fm.Box(20e-9, 10e-9, 5e-9), name='b', object_id='second')\n"
        "b.material = fm.materials.yig.kuswik\n",
        encoding="utf-8",
    )
    loaded = fm.load_problem_from_script(path, lightweight_assets=True, material_catalog=[published])
    scene = build_scene_document_from_builder(export_builder_draft(loaded))
    first, second = scene["objects"]
    materials = {material["id"]: material for material in scene["materials"]}
    for obj, enabled in ((first, True), (second, False)):
        term = next(term for term in obj["physics_stack"] if term["kind"] == kind)
        assert term["enabled"] is enabled
    assert materials[second["material_ref"]]["properties"][parameter] == coefficient

    offline = tmp_path / "offline-mixed.py"
    canonical_source = render_loaded_problem_as_script(loaded)
    for script in (render_scene_document_as_script(scene), canonical_source):
        offline.write_text(script, encoding="utf-8")
        replayed = fm.load_problem_from_script(offline, lightweight_assets=True)
        rebuilt = build_scene_document_from_builder(export_builder_draft(replayed))
        assert rebuilt["materials"] == scene["materials"]
        assert [obj["physics_stack"] for obj in rebuilt["objects"]] == [
            obj["physics_stack"] for obj in scene["objects"]
        ]

    # Explicit authored zero remains authoritative even with dormant metadata.
    edited, count = re.subn(r"(b\.Ms\s*=[^\n]+\n)", rf"\g<1>b.{parameter} = 0\n", canonical_source)
    assert count == 1
    offline.write_text(edited, encoding="utf-8")
    edited_scene = build_scene_document_from_builder(export_builder_draft(
        fm.load_problem_from_script(offline, lightweight_assets=True)
    ))
    second = edited_scene["objects"][1]
    term = next(term for term in second["physics_stack"] if term["kind"] == kind)
    assert term["enabled"]
    edited_material = next(material for material in edited_scene["materials"] if material["id"] == second["material_ref"])
    assert edited_material["properties"][parameter] == 0
    assert edited_material["source"] == published["source"]


def test_published_version_assignment_keeps_explicit_dmi_activation(tmp_path):
    source = tmp_path / "active.py"
    source.write_text(
        "import fullmag as fm\n"
        "a = fm.geometry(fm.Box(20e-9, 10e-9, 5e-9), name='a')\n"
        "a.Dind = 0.001\n"
        "a.Dbulk = 0.001\n"
        "a.material = fm.materials.yig.kuswik\n",
        encoding="utf-8",
    )
    loaded = fm.load_problem_from_script(source, lightweight_assets=True, material_catalog=[PUBLISHED])
    assert next(term for term in loaded.problem.energy if isinstance(term, fm.InterfacialDMI)).D == -0.002
    assert next(term for term in loaded.problem.energy if isinstance(term, fm.BulkDMI)).D == 0
    scene = build_scene_document_from_builder(export_builder_draft(loaded))
    assert scene["materials"][0]["properties"]["Dbulk"] is None
    assert next(term for term in scene["objects"][0]["physics_stack"] if term["kind"] == "bulk_dmi")["enabled"]
    offline = tmp_path / "offline-active.py"
    offline.write_text(render_scene_document_as_script(scene), encoding="utf-8")
    replayed = fm.load_problem_from_script(offline, lightweight_assets=True)
    rebuilt = build_scene_document_from_builder(export_builder_draft(replayed))
    assert rebuilt["materials"] == scene["materials"]
    assert rebuilt["objects"][0]["physics_stack"] == scene["objects"][0]["physics_stack"]


def test_unavailable_catalog_blocks_lookup_only_and_canonical_export_replays(tmp_path):
    import pytest

    script = tmp_path / "catalog.py"
    declarations = (
        "import fullmag as fm\n"
        "disc = fm.geometry(fm.Box(20e-9, 10e-9, 5e-9), name='disc')\n"
    )
    script.write_text(declarations + "disc.Ms = 140000\n" + "disc.Aex = 3.5e-12\n", encoding="utf-8")
    assert fm.load_problem_from_script(
        script, lightweight_assets=True, material_catalog_unavailable=True,
    ).problem.magnets[0].material.Ms == 140000

    script.write_text(declarations + "disc.material = fm.materials.yig.kuswik\n", encoding="utf-8")
    with pytest.raises(LookupError, match=r"catalog is unavailable.*yig\.kuswik"):
        fm.load_problem_from_script(
            script, lightweight_assets=True, material_catalog_unavailable=True,
        )
    loaded = fm.load_problem_from_script(script, lightweight_assets=True, material_catalog=[PUBLISHED])
    scene = build_scene_document_from_builder(export_builder_draft(loaded))
    script.write_text(render_scene_document_as_script(scene), encoding="utf-8")
    offline = fm.load_problem_from_script(
        script, lightweight_assets=True, material_catalog_unavailable=True,
    )
    rebuilt = build_scene_document_from_builder(export_builder_draft(offline))
    assert rebuilt["materials"] == scene["materials"]


def test_missing_published_version_reports_full_key_and_binding_does_not_leak(tmp_path):
    import pytest

    source = tmp_path / "lookup.py"
    source.write_text("import fullmag as fm\nfm.materials.yig.kuswik\n", encoding="utf-8")
    with pytest.raises(LookupError, match=r"yig\.kuswik"):
        fm.load_problem_from_script(source, lightweight_assets=True)
    with pytest.raises(LookupError, match=r"unknown_family\.unknown_version"):
        fm.materials.unknown_family.unknown_version
    with pytest.raises(ValueError, match=r"duplicate.*yig\.kuswik"):
        fm.load_problem_from_script(source, lightweight_assets=True, material_catalog=[PUBLISHED, PUBLISHED])
    with pytest.raises(LookupError, match=r"yig\.kuswik"):
        fm.materials.yig.kuswik


def test_published_material_source_validates_keys_and_coefficients(tmp_path):
    import pytest

    source = tmp_path / "validate.py"
    source.write_text("import fullmag as fm\nfm.materials.yig.kuswik\n", encoding="utf-8")
    for path, value, message in (
        (("version", "family"), "class", "non-keyword ASCII"),
        (("version", "version"), "Bad-key", "non-keyword ASCII"),
        (("version", "copied_from_family"), "yig", "must differ"),
        (("properties", "Ms"), None, "requires Ms and Aex"),
        (("properties", "Aex"), 0, "Aex must be positive"),
        (("catalog_id",), "custom:yig", "catalog_id and version disagree"),
    ):
        invalid = copy.deepcopy(PUBLISHED)
        field = invalid["source"] if len(path) == 1 else invalid["source"][path[0]]
        field[path[-1]] = value
        with pytest.raises(ValueError, match=message):
            fm.load_problem_from_script(source, lightweight_assets=True, material_catalog=[invalid])


def test_client_material_catalog_binding_exposes_one_snapshot_and_restores_context(tmp_path):
    import pytest
    from fullmag.client import Client
    from live_api_fake import FakeFullmagApi

    source = tmp_path / "standalone.py"
    source.write_text(
        "import fullmag as fm\n"
        "disc = fm.geometry(fm.Box(20e-9, 10e-9, 5e-9))\n"
        "disc.material = fm.materials.yig.kuswik\n",
        encoding="utf-8",
    )
    endpoint = "/v2/workspace/material-library"
    with FakeFullmagApi() as fake:
        fake.route("GET", endpoint, {"entries": [], "revision": 7, "versions": [PUBLISHED]})
        with Client(fake.url) as client, client.bind_material_catalog():
            assert fm.materials.yig.kuswik.archived
            loaded = fm.load_problem_from_script(source, lightweight_assets=True)
            assert loaded.problem.magnets[0].material.Ms == PROPERTIES["Ms"]
            with pytest.raises(AttributeError):
                fm.materials.yig.kuswik.archived = False
            with pytest.raises(LookupError, match=r"yig\.kuswik"):
                fm.load_problem_from_script(source, lightweight_assets=True, material_catalog=[])
            assert fm.materials.yig.kuswik.archived
        assert len(fake.find("GET", endpoint)) == 1
    with pytest.raises(LookupError, match=r"yig\.kuswik"):
        fm.materials.yig.kuswik


PUBLISHED = {
    "source": {
        "catalog_id": "custom:published:yig:kuswik",
        "catalog_revision": 3,
        "name": "Published YIG",
        "kind": "modified",
        "properties": {**PROPERTIES, "Dind": -0.002},
        "references": REFERENCES,
        "version": {
            "family": "yig",
            "version": "kuswik",
            "source_project": "Prior project",
            "copied_from_family": "permalloy",
        },
    },
    "original": SOURCE,
    "display_name": "Measured YIG alias",
    "archived": True,
    "revision": 7,
}


if __name__ == "__main__":
    unittest.main()
