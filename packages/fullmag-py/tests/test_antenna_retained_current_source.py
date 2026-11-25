# Authoring shape only: no authentication or solver execution.
from dataclasses import FrozenInstanceError, replace
import unittest
import fullmag as fm
from test_antenna_surface_policy import surface_stage
from fullmag.runtime.script_builder import _render_antenna_field_solve_definition_expr


def source_payload():
    return dict(project_id="project-source", run_id="run-source", task_id="task-source",
                attempt_id="attempt-source", ownership_epoch="1",
                artifact_id="artifact-source", object_ref="a" * 64)


class RetainedCurrentSourceTests(unittest.TestCase):
    def test_exact_frozen_locator_and_round_trip(self):
        payload = source_payload()
        source = fm.AntennaRetainedCurrentSource(**payload)
        self.assertEqual(source.to_ir(), dict(kind="published_inspection", **payload))
        self.assertEqual(fm.AntennaRetainedCurrentSource(**source.to_ir()), source)
        with self.assertRaises(FrozenInstanceError):
            source.object_ref = "b" * 64
        payload["run_id"] = "other"
        self.assertEqual(source.run_id, "run-source")

    def test_epoch_u64_boundaries(self):
        for value in ("1", "18446744073709551615"):
            with self.subTest(value=value):
                source = fm.AntennaRetainedCurrentSource(**{**source_payload(), "ownership_epoch": value})
                self.assertEqual(source.ownership_epoch, value)

    def test_epoch_is_lossless_ascii_positive_string(self):
        for value in (0, 1, True, None, "", "0", "01", "+1", "-1", "1.0", "1e2", " 1", "1 ",
                      "\u0661", "18446744073709551616", "9" * 500):
            with self.subTest(value=value), self.assertRaises(ValueError):
                fm.AntennaRetainedCurrentSource(**{**source_payload(), "ownership_epoch": value})

    def test_cas_hash_and_unknown_kind_or_key_rejected(self):
        for value in (None, 42, "a" * 63, "a" * 65, "A" * 64, "g" * 64, "sha256:" + "a" * 64):
            with self.subTest(value=value), self.assertRaises(ValueError):
                fm.AntennaRetainedCurrentSource(**{**source_payload(), "object_ref": value})
        with self.assertRaises(ValueError):
            fm.AntennaRetainedCurrentSource(**source_payload(), kind="stage_output")
        with self.assertRaises(TypeError):
            fm.AntennaRetainedCurrentSource(**source_payload(), accepted_source_digest="a" * 64)

    def test_identifier_shape_without_identity_rewrite(self):
        for name in ("project_id", "run_id", "task_id", "attempt_id", "artifact_id"):
            for value in ("", " ", "x ", " x", "x\ny", "x\x00y", "x\x7fy", None, 1):
                with self.subTest(name=name, value=value), self.assertRaises((ValueError, TypeError)):
                    fm.AntennaRetainedCurrentSource(**{**source_payload(), name: value})

    def test_c1_control_identifiers_match_the_ir_control_domain(self):
        for name in ("project_id", "run_id", "task_id", "attempt_id", "artifact_id"):
            for control in (chr(128), chr(159)):
                with self.subTest(name=name, control=ord(control)), self.assertRaises(ValueError):
                    fm.AntennaRetainedCurrentSource(**{**source_payload(), name: "x" + control + "y"})

    def test_stage_preserves_typed_source_and_legacy_omission(self):
        original = surface_stage()
        source = fm.AntennaRetainedCurrentSource(**source_payload())
        stage = replace(original, retained_current_source=source)
        self.assertNotIn("retained_current_source", original.to_ir())
        self.assertNotIn("conservative_current_view_ref", stage.to_ir())
        self.assertEqual(stage.to_ir()["retained_current_source"], source.to_ir())
        self.assertEqual(stage.surface_field_policy.to_ir(), original.surface_field_policy.to_ir())

    def test_ambiguous_source_or_wrong_operator_is_rejected(self):
        original = surface_stage()
        source = fm.AntennaRetainedCurrentSource(**source_payload())
        with self.assertRaises(TypeError):
            replace(original, retained_current_source=source.to_ir())
        with self.assertRaises(ValueError):
            replace(original, retained_current_source=source, conservative_current_view_ref="legacy-view")
        with self.assertRaises(ValueError):
            replace(original, retained_current_source=source,
                    oersted_realization="direct_tetra_quadrature", surface_field_policy=None)

    def test_retained_dtq_requires_input_asset_and_preserves_explicit_selection(self):
        from pathlib import Path
        import tempfile
        import hashlib
        with tempfile.TemporaryDirectory(prefix="retained-dtq-") as directory:
            root = Path(directory)
            path = root / "source.json"
            path.write_bytes(b"{}")
            asset = fm.AntennaSourcePreparationAsset(path, hashlib.sha256(b"{}").hexdigest())
            source = fm.AntennaRetainedCurrentSource(**source_payload())
            stage = replace(surface_stage(), retained_current_source=source,
                            retained_source_preparation=asset, oersted_realization="direct_tetra_quadrature",
                            surface_field_policy=None)
            wire = stage.to_ir(source_root=root)
            self.assertEqual(wire["oersted_realization"], "direct_tetra_quadrature")
            self.assertNotIn("surface_field_policy", wire)
            self.assertEqual(wire["retained_current_source"], source.to_ir())
            self.assertEqual(wire["retained_source_preparation"], asset.to_ir(source_root=root))
            # Authoring shape only; this deliberately is not a validated source asset.
            for realization in ("direct_tetra_quadrature", "hcurl_h1_vector_potential"):
                with self.subTest(realization=realization), self.assertRaises(ValueError):
                    replace(surface_stage(), retained_current_source=source,
                            oersted_realization=realization, surface_field_policy=None)

    def test_script_definition_round_trip(self):
        stage = replace(surface_stage(), retained_current_source=fm.AntennaRetainedCurrentSource(**source_payload()))
        script = _render_antenna_field_solve_definition_expr(stage.to_ir())
        self.assertIn("fm.AntennaRetainedCurrentSource(", script)
        self.assertEqual(eval(script, {"fm": fm}).to_ir(), stage.to_ir())


if __name__ == "__main__":
    unittest.main()
