from __future__ import annotations

import math
import unittest

import fullmag as fm


class PlanarMonitorContractTests(unittest.TestCase):
    def tearDown(self) -> None:
        fm.reset()

    def test_axis_preset_serializes_normalized_frame_and_quantity_free_monitor(self) -> None:
        monitor = fm.PlanarMonitor(
            name="midplane",
            target=fm.MonitorTarget.object("film"),
            frame=fm.PlanarFrame.xy(
                position=5e-9,
                extent=fm.PlanarExtent.target_bounds(padding=2e-9),
            ),
            operator=fm.SlabAverage(thickness=4e-9),
            monitor_id="midplane",
        )

        payload = monitor.to_ir()

        self.assertEqual(
            payload,
            {
                "id": "midplane",
                "name": "midplane",
                "target": {"kind": "object", "object_id": "film"},
                "frame": {
                    "origin_m": [0.0, 0.0, 5e-9],
                    "u_axis": [1.0, 0.0, 0.0],
                    "v_axis": [0.0, 1.0, 0.0],
                    "normal": [0.0, 0.0, 1.0],
                    "preset": "xy",
                    "normalization_version": "planar_frame_v1",
                    "extent": {
                        "kind": "target_bounds",
                        "padding_m": 2e-9,
                    },
                },
                "operator": {
                    "kind": "slab_average",
                    "thickness_m": 4e-9,
                },
            },
        )
        for forbidden in (
            "quantity",
            "component",
            "colormap",
            "display_unit",
            "resolution",
            "quality",
        ):
            self.assertNotIn(forbidden, payload)

    def test_arbitrary_frame_is_deterministically_orthonormalized(self) -> None:
        frame = fm.PlanarFrame(
            origin=(1e-9, -2e-9, 3e-9),
            normal=(1.0, 1.0, 1.0),
            u_axis=(1.0, -1.0, 0.0),
            extent=fm.PlanarExtent.explicit(
                u=(-80e-9, 80e-9),
                v=(-40e-9, 40e-9),
            ),
        )

        payload = frame.to_ir()
        normal = payload["normal"]
        u_axis = payload["u_axis"]
        v_axis = payload["v_axis"]
        self.assertAlmostEqual(sum(value * value for value in normal), 1.0)
        self.assertAlmostEqual(sum(value * value for value in u_axis), 1.0)
        self.assertAlmostEqual(sum(value * value for value in v_axis), 1.0)
        self.assertAlmostEqual(sum(a * b for a, b in zip(normal, u_axis)), 0.0)
        self.assertAlmostEqual(sum(a * b for a, b in zip(normal, v_axis)), 0.0)
        self.assertAlmostEqual(sum(a * b for a, b in zip(u_axis, v_axis)), 0.0)
        self.assertIsNone(payload["preset"])

    def test_invalid_frame_and_operator_values_fail_before_lowering(self) -> None:
        with self.assertRaisesRegex(ValueError, "not be collinear"):
            fm.PlanarFrame(
                origin=(0.0, 0.0, 0.0),
                normal=(0.0, 0.0, 1.0),
                u_axis=(0.0, 0.0, 2.0),
                extent=fm.PlanarExtent.target_bounds(),
            )
        for thickness in (0.0, -1e-9, math.inf, math.nan):
            with self.subTest(thickness=thickness):
                with self.assertRaisesRegex(ValueError, "finite and > 0"):
                    fm.SlabAverage(thickness=thickness)
        with self.assertRaisesRegex(ValueError, "u_min_m < u_max_m"):
            fm.PlanarExtent.explicit(u=(1.0, 0.0), v=(-1.0, 1.0))

    def test_study_registry_rejects_duplicate_monitor_names(self) -> None:
        study = fm.study("monitor-registry")
        first = study.monitors.add_planar(
            name="midplane",
            target=fm.MonitorTarget.magnetic_domain(),
            frame=fm.PlanarFrame.xy(
                position=0.0,
                extent=fm.PlanarExtent.magnetic_domain(),
            ),
            operator=fm.PlaneSample(),
        )
        self.assertEqual(study.monitors.items(), (first,))

        with self.assertRaisesRegex(ValueError, "duplicate planar monitor name"):
            study.monitors.add_planar(
                name="midplane",
                target=fm.MonitorTarget.domain(),
                frame=fm.PlanarFrame.yz(
                    position=0.0,
                    extent=fm.PlanarExtent.universe(),
                ),
                operator=fm.DepthProjection(reduction="mean_occupied"),
            )

    def test_problem_lowering_includes_planar_monitors(self) -> None:
        material = fm.Material(
            name="Py",
            Ms=800e3,
            A=13e-12,
            alpha=0.01,
        )
        geometry = fm.Box(40e-9, 20e-9, 5e-9, name="film")
        magnet = fm.Ferromagnet(
            name="film",
            geometry=geometry,
            material=material,
            m0=fm.init.UniformMagnetization((1.0, 0.0, 0.0)),
        )
        monitor = fm.PlanarMonitor(
            name="surface",
            monitor_id="surface",
            target=fm.MonitorTarget.region("film", "core"),
            frame=fm.PlanarFrame.xz(
                position=0.0,
                extent=fm.PlanarExtent.explicit(
                    u=(-20e-9, 20e-9),
                    v=(-2.5e-9, 2.5e-9),
                ),
            ),
            operator=fm.SurfaceProjection(
                boundary=fm.SurfaceBoundary.object_boundary(),
                visibility_policy="frontmost",
            ),
        )
        problem = fm.Problem(
            name="planar",
            magnets=[magnet],
            energy=[fm.Exchange()],
            study=fm.TimeEvolution(dynamics=fm.LLG(), outputs=[]),
            monitors=[monitor],
        )

        ir = problem.to_ir(include_geometry_assets=False)

        self.assertEqual(ir["planar_monitors"], [monitor.to_ir()])


if __name__ == "__main__":
    unittest.main()
