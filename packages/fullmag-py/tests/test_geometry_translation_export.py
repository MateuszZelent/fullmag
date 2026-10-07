"""Interpreted exact translation export checks; no solver or filesystem writes."""
from pathlib import Path
import math
from itertools import permutations
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

    def custom_layouts(self):
        for geometry in self.layouts():
            ir = geometry.to_ir()
            ids = ("return", "signal") if isinstance(geometry, fm.MicrostripAntennaLayout) else (
                "rf_signal", "left ground", "right_ground")
            for conductor, part_id in zip(ir["conductors"], ids):
                conductor["id"] = part_id
            yield type(geometry).from_ir(ir)

    def test_loaded_custom_conductor_ids_are_preserved(self):
        for geometry in self.custom_layouts():
            with self.subTest(kind=type(geometry).__name__):
                self.assert_layout_roundtrip(geometry, _render_geometry_expr(
                    geometry, magnet_name="source", source_root=Path.cwd()))

    def test_ir_conductor_identity_is_independent_of_list_order(self):
        for geometry in self.custom_layouts():
            for conductors in permutations(geometry.to_ir()["conductors"]):
                with self.subTest(kind=type(geometry).__name__, conductors=conductors):
                    ir = geometry.to_ir()
                    ir["conductors"] = list(conductors)
                    restored = type(geometry).from_ir(ir)
                    self.assertEqual(restored.to_ir(), geometry.to_ir())
                    self.assertEqual(restored._sections(), geometry._sections())

    def test_kindless_legacy_conductor_order_remains_supported(self):
        for geometry in self.custom_layouts():
            with self.subTest(kind=type(geometry).__name__):
                ir = geometry.to_ir()
                ir["conductors"] = [{"id": part["id"]} for part in ir["conductors"]]
                self.assertEqual(type(geometry).from_ir(ir).to_ir(), geometry.to_ir())

    def test_invalid_typed_conductors_do_not_fall_back_to_positional_ids(self):
        for geometry in self.custom_layouts():
            for mutation in ("duplicate", "unknown", "missing", "mixed"):
                with self.subTest(kind=type(geometry).__name__, mutation=mutation):
                    ir = geometry.to_ir()
                    if mutation == "duplicate":
                        ir["conductors"][1]["kind"] = "signal"
                    elif mutation == "unknown":
                        ir["conductors"][1]["kind"] = "other"
                    elif mutation == "missing":
                        ir["conductors"].pop()
                    else:
                        ir["conductors"][1].pop("kind")
                    with self.assertRaisesRegex(ValueError, "expected kind"):
                        type(geometry).from_ir(ir)

    def test_override_conductor_ids_follow_kind_not_list_order(self):
        for geometry in self.custom_layouts():
            with self.subTest(kind=type(geometry).__name__):
                params = geometry.to_ir()
                params["conductors"] = list(reversed(params["conductors"]))
                self.assert_layout_roundtrip(geometry, _render_geometry_expr_from_override(
                    type(geometry).__name__, params, name=geometry.geometry_name,
                    source_root=Path.cwd()))

    def test_explicit_scene_part_ids_remain_supported(self):
        for geometry in self.custom_layouts():
            with self.subTest(kind=type(geometry).__name__):
                params = geometry.to_ir()
                keys = {"signal": "signal_part_id", "return": "return_part_id",
                        "ground_left": "left_ground_part_id",
                        "ground_right": "right_ground_part_id"}
                for conductor in params.pop("conductors"):
                    params[keys[conductor["kind"]]] = conductor["id"]
                self.assert_layout_roundtrip(geometry, _render_geometry_expr_from_override(
                    type(geometry).__name__, params, name=geometry.geometry_name,
                    source_root=Path.cwd()))

    def test_explicit_scene_ids_take_precedence_over_canonical_fallback(self):
        for geometry in self.custom_layouts():
            with self.subTest(kind=type(geometry).__name__):
                params = geometry.to_ir()
                keys = {"signal": "signal_part_id", "return": "return_part_id",
                        "ground_left": "left_ground_part_id",
                        "ground_right": "right_ground_part_id"}
                for conductor in params["conductors"]:
                    params[keys[conductor["kind"]]] = conductor["id"]
                    conductor["id"] = conductor["kind"]
                self.assert_layout_roundtrip(geometry, _render_geometry_expr_from_override(
                    type(geometry).__name__, params, name=geometry.geometry_name,
                    source_root=Path.cwd()))


if __name__ == "__main__":
    unittest.main(verbosity=2)
