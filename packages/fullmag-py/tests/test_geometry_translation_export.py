"""Interpreted exact translation export checks; no solver or filesystem writes."""
from pathlib import Path
import math
import unittest

import fullmag as fm
from fullmag.runtime.script_builder import (
    _render_geometry_expr,
    _render_geometry_expr_from_override,
)


class GeometryTranslationExportTests(unittest.TestCase):
    offset = (1.2345678901234567e-9, -2.3456789012345678e-9, -6.000000000000001e-8)

    def assert_roundtrip(self, expression):
        geometry = eval(expression, {"__builtins__": {}, "fm": fm})
        self.assertEqual(tuple(value.hex() for value in geometry.offset),
                         tuple(value.hex() for value in self.offset))

    def test_loaded_geometry_translation_is_lossless(self):
        geometry = fm.Box(10e-9, 20e-9, 30e-9).translate(self.offset)
        self.assert_roundtrip(_render_geometry_expr(
            geometry, magnet_name="source", source_root=Path.cwd()))

    def test_scene_override_translation_is_lossless(self):
        for key in ("translation", "translate"):
            with self.subTest(key=key):
                self.assert_roundtrip(_render_geometry_expr_from_override(
                    "Box", {"size": [10e-9, 20e-9, 30e-9], key: list(self.offset)},
                    name="source", source_root=Path.cwd()))


class AntennaLayoutExportTests(unittest.TestCase):
    def layouts(self):
        angle = 0.12345678901234567
        c, s = math.cos(angle), math.sin(angle)
        common = dict(
            name="precise_antenna",
            length_m=1.2345678901234567e-6,
            thickness_m=1.2345678901234567e-8,
            conductivity_s_per_m=5.812345678901234e7,
            transform=fm.RigidTransform(
                rotation_matrix=((c, -s, 0.0), (s, c, 0.0), (0.0, 0.0, 1.0)),
                translation_m=GeometryTranslationExportTests.offset),
        )
        profile = ((0.0, 1.2345678901234567e-7),
                   (0.43210987654321, 5.67890123456789e-8),
                   (1.0, 2.3456789012345678e-7))
        return (
            fm.MicrostripAntennaLayout(
                **common,
                stations=tuple(fm.MicrostripWidthStation(s, w) for s, w in profile),
                return_width_m=2.3456789012345678e-7,
                return_offset_m=3.4567890123456789e-8),
            fm.CPWAntennaLayout(
                **common,
                stations=tuple(fm.CPWWidthStation(
                    s, w, left_gap_m=3.4567890123456789e-8,
                    right_gap_m=4.567890123456789e-8,
                    left_ground_width_m=2.3456789012345678e-7,
                    right_ground_width_m=3.4567890123456789e-7)
                    for s, w in profile)),
        )

    def assert_layout_roundtrip(self, geometry, expression):
        restored = eval(expression, {"__builtins__": {}, "fm": fm})
        self.assertEqual(restored.to_ir(), geometry.to_ir())
        self.assertEqual(restored._sections(), geometry._sections())

    def test_loaded_antenna_parameters_are_lossless(self):
        for geometry in self.layouts():
            with self.subTest(kind=type(geometry).__name__):
                self.assert_layout_roundtrip(geometry, _render_geometry_expr(
                    geometry, magnet_name="source", source_root=Path.cwd()))

    def test_scene_override_antenna_parameters_are_lossless(self):
        for geometry in self.layouts():
            with self.subTest(kind=type(geometry).__name__):
                params = {key: value for key, value in geometry.to_ir().items()
                          if key not in {"kind", "name"}}
                self.assert_layout_roundtrip(geometry, _render_geometry_expr_from_override(
                    type(geometry).__name__, params, name=geometry.geometry_name,
                    source_root=Path.cwd()))


if __name__ == "__main__":
    unittest.main(verbosity=2)
