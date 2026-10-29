from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import patch

import fullmag as fm
from fullmag.model._antenna_terminal import antenna_terminal_marker
from fullmag.meshing._gmsh_waveguides import antenna_terminal_marker as meshing_marker
from fullmag.runtime.scene_document import _decode_external_lead_preparation
from fullmag.runtime.script_builder import _render_external_lead_preparation_payload


def _extension(**overrides):
    parameters = dict(
        id="inlet", observation_id="signal_in", object_id="antenna",
        conductor_part_id="signal", selector="local_u_min",
        length_m=1e-6, outward_direction_xyz=(-1.0, 0.0, 0.0),
        conductivity_spm=5.8e7,
    )
    parameters.update(overrides)
    return fm.TerminalLeadExtension.from_antenna_terminal(**parameters)


class AntennaTerminalAuthoringTests(unittest.TestCase):
    def test_existing_marker_bytes_and_meshing_owner_are_preserved(self):
        self.assertIs(meshing_marker, antenna_terminal_marker)
        self.assertEqual(antenna_terminal_marker("antenna", "signal", "local_u_min"), 117_762_299)
        extension = _extension()
        self.assertEqual(extension.boundary_markers, (117_762_299,))
        self.assertEqual(extension.layers, 2)
        self.assertEqual(extension.to_ir(), fm.TerminalLeadExtension(
            id="inlet", observation_id="signal_in", object_id="antenna",
            boundary_markers=(117_762_299,), length_m=1e-6,
            outward_direction_xyz=(-1.0, 0.0, 0.0), conductivity_spm=5.8e7,
        ).to_ir())

    def test_semantic_identity_matches_canonical_meshing_markers(self):
        for part in ("signal", "return_left", "return_right", "powrot_żółty"):
            for selector in ("local_u_min", "local_u_max", " LOCAL_U_MAX "):
                with self.subTest(part=part, selector=selector):
                    extension = _extension(object_id="immutable antenna", conductor_part_id=part, selector=selector)
                    self.assertEqual(extension.boundary_markers, (meshing_marker("immutable antenna", part, selector),))
                    self.assertEqual(extension.object_id, "immutable antenna")
        self.assertNotEqual(_extension(object_id="antenna ").boundary_markers, _extension().boundary_markers)

    def test_semantic_strings_are_rejected_before_hashing(self):
        for field in ("id", "observation_id", "object_id", "conductor_part_id", "selector"):
            for invalid in (None, 4, "", "   ", "invalid\x00id", "a" * 4097, "ż" * 2049):
                with self.subTest(field=field, invalid=repr(invalid)[:40]):
                    with patch("fullmag.model._antenna_terminal.antenna_terminal_marker") as marker:
                        with self.assertRaisesRegex(ValueError, field):
                            _extension(**{field: invalid})
                        marker.assert_not_called()
        for selector in ("x_min", "local_u_middle"):
            with self.assertRaisesRegex(ValueError, "local_u_min or local_u_max"):
                _extension(selector=selector)

    def test_existing_numeric_validation_and_explicit_direction_are_preserved(self):
        for invalid in (
            {"length_m": 0}, {"conductivity_spm": float("nan")},
            {"layers": True}, {"layers": 1},
            {"outward_direction_xyz": (2.0, 0.0, 0.0)},
        ):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                _extension(**invalid)
        self.assertEqual(_extension(outward_direction_xyz=(0.0, 0.0, 1.0)).outward_direction_xyz, (0.0, 0.0, 1.0))
        with self.assertRaises(TypeError):
            fm.TerminalLeadExtension.from_antenna_terminal("inlet")

    def test_unknown_part_is_rejected_by_actual_mesh_marker_guard(self):
        from fullmag.meshing._antenna_external_lead_preparation import _cap

        extension = _extension(conductor_part_id="missing_part")
        # This guard runs before geometry access; no geometric fallback is allowed.
        actual_mesh = SimpleNamespace(boundary_markers=[117_762_299])
        with self.assertRaisesRegex(ValueError, "does not exist in the actual mesh"):
            _cap(actual_mesh, extension, {}, {})

    def test_marker_form_scene_decode_and_python_export_roundtrip(self):
        source = fm.ExternalLeadPreparation(
            revision="terminal_factory_v1",
            extensions=(
                _extension(),
                _extension(id="outlet", observation_id="signal_out", selector="local_u_max", outward_direction_xyz=(1.0, 0.0, 0.0), layers=3),
            ),
            drives=(fm.CurrentSourceDrive("drive", "port", {"inlet": 1e-3, "outlet": -1e-3}),),
        )
        payload = source.to_ir()
        self.assertEqual(_decode_external_lead_preparation(payload).to_ir(), payload)
        rendered = _render_external_lead_preparation_payload(payload)
        self.assertIn("boundary_markers=", rendered)
        self.assertNotIn("from_antenna_terminal", rendered)
        self.assertEqual(eval(rendered, {"fm": fm}).to_ir(), payload)
        for extension in payload["extensions"]:
            self.assertNotIn("selector", extension)
            self.assertNotIn("conductor_part_id", extension)


if __name__ == "__main__":
    unittest.main()
