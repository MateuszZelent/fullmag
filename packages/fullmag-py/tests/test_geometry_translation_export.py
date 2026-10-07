"""Interpreted exact translation export checks; no solver or filesystem writes."""
from pathlib import Path
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
