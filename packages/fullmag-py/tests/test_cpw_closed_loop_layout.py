"""Closed GSG authoring contracts, independent of meshing and transport."""
import unittest

import fullmag as fm
from fullmag.runtime.script_builder import _render_shape_expression


def layout_options():
    return dict(
        name="gsg", length_m=20e-6, thickness_m=90e-9,
        conductivity_s_per_m=3.5e7,
        stations=[fm.CPWWidthStation(s, 200e-9, gap_m=250e-9,
                                   ground_width_m=200e-9) for s in (0.0, 1.0)],
        closed_loop=True,
        inlet_connection_length_m=2e-6, inlet_crossbar_length_m=300e-9,
        inlet_connection_part_id="feed", inlet_connection_conductivity_s_per_m=3.5e7,
        outlet_connection_length_m=3e-6, outlet_crossbar_length_m=400e-9,
        outlet_connection_part_id="closure", outlet_connection_conductivity_s_per_m=2e7,
    )


class ClosedGsgLayoutTests(unittest.TestCase):
    def test_round_trip_preserves_connections_without_inventing_port_branches(self):
        layout = fm.CPWAntennaLayout(**layout_options())
        ir = layout.to_ir()
        self.assertEqual(fm.CPWAntennaLayout.from_ir(ir), layout)
        self.assertEqual(layout.conductor_part_ids, ("signal", "ground_left", "ground_right"))
        self.assertEqual(len(ir["terminal_faces"]), 3)
        self.assertEqual(ir["loop"]["outlet_connection_conductivity_s_per_m"], 2e7)
        shape = {"geometry_kind": "CPWAntennaLayout", "name": "gsg",
                 "geometry_params": {k: v for k, v in ir.items() if k not in {"name", "kind"}}}
        self.assertEqual(eval(_render_shape_expression(shape), {"fm": fm}), layout)

    def test_bounds_include_both_connections(self):
        lower, upper = fm.CPWAntennaLayout(**layout_options()).world_bounds()
        self.assertAlmostEqual(lower[0], -2e-6, delta=1e-18)
        self.assertAlmostEqual(upper[0], 23e-6, delta=1e-18)
        self.assertAlmostEqual(lower[1], -550e-9, delta=1e-18)
        self.assertAlmostEqual(upper[1], 550e-9, delta=1e-18)

    def test_solid_segments_include_connections_and_match_world_bounds(self):
        for transform in (fm.RigidTransform(), fm.RigidTransform(
                rotation_matrix=((0., 0., 1.), (1., 0., 0.), (0., 1., 0.)),
                translation_m=(1e-6, -2e-6, 3e-6))):
            layout = fm.CPWAntennaLayout(**{**layout_options(), "transform": transform})
            segments = layout.solid_segments()
            vertices = [vertex for segment in segments for section in segment.values()
                        for vertex in section["vertices"]]
            bounds = (tuple(min(v[i] for v in vertices) for i in range(3)),
                      tuple(max(v[i] for v in vertices) for i in range(3)))
            self.assertEqual(bounds, layout.world_bounds())
            owners = {part for segment in segments for section in segment.values()
                      for part in section["conductors"]}
            self.assertEqual(owners, {"signal", "ground_left", "ground_right", "feed", "closure"})
            self.assertEqual(len(segments), len(layout.stations) - 1 + 8)

    def test_open_cpw_solid_segments_keep_only_authored_station_spans(self):
        options = {key: value for key, value in layout_options().items()
                   if key != "closed_loop" and not key.startswith(("inlet_", "outlet_"))}
        layout = fm.CPWAntennaLayout(**options)
        self.assertEqual(len(layout.solid_segments()), len(layout.stations) - 1)
        self.assertEqual(layout.connection_solids(), {})

    def test_every_connection_parameter_is_explicit(self):
        options = layout_options()
        for name in [k for k in options if k.startswith(("inlet_", "outlet_"))]:
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "explicit"):
                fm.CPWAntennaLayout(**{k: v for k, v in options.items() if k != name})

    def test_neck_must_have_positive_length(self):
        for length in (0.0, 2e-6, 3e-6, float("nan")):
            with self.subTest(length=length), self.assertRaises(ValueError):
                fm.CPWAntennaLayout(**{**layout_options(), "inlet_crossbar_length_m": length})

    def test_connection_parts_are_distinct_from_every_branch(self):
        for part in ("signal", "ground_left", "ground_right", "closure"):
            with self.subTest(part=part), self.assertRaisesRegex(ValueError, "distinct"):
                fm.CPWAntennaLayout(**{**layout_options(), "inlet_connection_part_id": part})

    def test_open_cpw_cannot_silently_discard_connection_parameters(self):
        with self.assertRaises(ValueError):
            fm.CPWAntennaLayout(**{**layout_options(), "closed_loop": False})


if __name__ == "__main__":
    unittest.main()
