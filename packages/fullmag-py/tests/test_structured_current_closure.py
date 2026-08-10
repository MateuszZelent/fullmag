from __future__ import annotations

import math
import unittest

import fullmag as fm
from fullmag.runtime import script_builder
from fullmag.runtime.scene_document import (
    build_builder_from_scene_document,
    build_scene_document_from_builder,
)


def _closed_geometry() -> fm.StructuredCurrentClosure:
    return fm.StructuredCurrentClosure(
        closure_id="loop-1",
        source_cuts=[
            fm.StructuredCurrentSourceCut(
                source_cut_id="cut-1",
                circuit_id="drive-loop-1",
                region=fm.RegionRef("loop", "source-arm"),
                plane=fm.StructuredCutPlane(
                    axis="x",
                    offset_m=2.0e-9,
                    normal="positive_axis",
                ),
                drive=fm.ImpressedPotentialJump(
                    drive_id="source-1",
                    potential_jump_V=0.05,
                ),
            )
        ],
    )


class StructuredCurrentClosureTests(unittest.TestCase):
    def test_closed_geometry_lowers_to_canonical_ir(self) -> None:
        closure = _closed_geometry()

        self.assertEqual(
            closure.to_ir(),
            {
                "schema_version": "structured_current_closure.v1",
                "closure_id": "loop-1",
                "kind": "closed_geometry",
                "source_cuts": [
                    {
                        "source_cut_id": "cut-1",
                        "circuit_id": "drive-loop-1",
                        "region": {"object_id": "loop", "region_id": "source-arm"},
                        "plane": {
                            "axis": "x",
                            "offset_m": 2.0e-9,
                            "normal": "positive_axis",
                        },
                        "drive": {
                            "schema_version": "impressed_potential_jump.v1",
                            "kind": "impressed_potential_jump",
                            "drive_id": "source-1",
                            "potential_jump_V": 0.05,
                        },
                    }
                ],
            },
        )

    def test_current_transport_carries_structured_closure_separately_from_fem_view(self) -> None:
        region = fm.RegionRef("loop", "conductor")
        transport = fm.CurrentTransport(
            name="drive-loop",
            model="ohmic_poisson",
            coupling="one_way",
            domain=[region],
            materials=[
                fm.ChargeTransportMaterialAssignment(
                    region,
                    fm.ChargeTransportMaterial(5.8e7),
                )
            ],
            boundaries=[
                fm.ChargeInsulating(
                    "outer",
                    [fm.SurfaceRef("loop", "outer", (1.0, 0.0, 0.0))],
                )
            ],
            gauge=fm.ChargePotentialGauge("zero_mean"),
            solver=fm.ChargeSolverPolicy(
                operator_version="fv_charge_harmonic_source_cut_v1"
            ),
            structured_current_closure=_closed_geometry(),
        )

        self.assertEqual(
            transport.to_ir()["structured_current_closure"],
            _closed_geometry().to_ir(),
        )
        self.assertNotIn("conservative_current_view", transport.to_ir())

    def test_rejects_duplicate_source_cut_circuit_and_drive_ids(self) -> None:
        first = _closed_geometry().source_cuts[0]
        duplicate_circuit = fm.StructuredCurrentSourceCut(
            source_cut_id="cut-2",
            circuit_id=first.circuit_id,
            region=first.region,
            plane=fm.StructuredCutPlane("y", 1.0e-9),
            drive=fm.ImpressedPotentialJump("source-2", 0.02),
        )
        duplicate_drive = fm.StructuredCurrentSourceCut(
            source_cut_id="cut-3",
            circuit_id="drive-loop-3",
            region=first.region,
            plane=fm.StructuredCutPlane("z", 1.0e-9),
            drive=first.drive,
        )

        with self.assertRaisesRegex(ValueError, "circuit_id"):
            fm.StructuredCurrentClosure(
                closure_id="loop",
                source_cuts=[first, duplicate_circuit],
            )
        with self.assertRaisesRegex(ValueError, "drive_id"):
            fm.StructuredCurrentClosure(
                closure_id="loop",
                source_cuts=[first, duplicate_drive],
            )

    def test_rejects_invalid_plane_and_zero_or_nonfinite_jump(self) -> None:
        for axis in ("r", "", "X"):
            with self.subTest(axis=axis), self.assertRaises(ValueError):
                fm.StructuredCutPlane(axis, 0.0)
        for normal in ("outward", "", "Positive_axis"):
            with self.subTest(normal=normal), self.assertRaises(ValueError):
                fm.StructuredCutPlane("x", 0.0, normal)
        for offset in (math.inf, -math.inf, math.nan):
            with self.subTest(offset=offset), self.assertRaises(ValueError):
                fm.StructuredCutPlane("x", offset)
        for jump in (0.0, math.inf, -math.inf, math.nan):
            with self.subTest(jump=jump), self.assertRaises(ValueError):
                fm.ImpressedPotentialJump("drive", jump)
        with self.assertRaisesRegex(TypeError, "region"):
            fm.StructuredCurrentSourceCut(  # type: ignore[arg-type]
                "cut", "circuit", object(), fm.StructuredCutPlane("x", 0.0),
                fm.ImpressedPotentialJump("drive", 0.1),
            )

    def test_rejects_fem_and_structured_closure_on_same_transport(self) -> None:
        region = fm.RegionRef("loop", "conductor")
        with self.assertRaisesRegex(ValueError, "mutually exclusive"):
            fm.CurrentTransport(
                name="drive-loop",
                model="ohmic_poisson",
                domain=[region],
                materials=[
                    fm.ChargeTransportMaterialAssignment(
                        region,
                        fm.ChargeTransportMaterial(5.8e7),
                    )
                ],
                boundaries=[
                    fm.ChargeInsulating(
                        "outer",
                        [fm.SurfaceRef("loop", "outer", (1.0, 0.0, 0.0))],
                    )
                ],
                gauge=fm.ChargePotentialGauge("zero_mean"),
                solver=fm.ChargeSolverPolicy(),
                conservative_current_view=object(),
                structured_current_closure=_closed_geometry(),
            )

    def test_scene_and_canonical_script_round_trip_only_authored_descriptor(self) -> None:
        region = fm.RegionRef("loop", "conductor")
        transport = fm.CurrentTransport(
            name="drive-loop",
            model="ohmic_poisson",
            domain=[region],
            materials=[
                fm.ChargeTransportMaterialAssignment(
                    region,
                    fm.ChargeTransportMaterial(5.8e7),
                )
            ],
            boundaries=[
                fm.ChargeInsulating(
                    "outer",
                    [fm.SurfaceRef("loop", "outer", (1.0, 0.0, 0.0))],
                )
            ],
            gauge=fm.ChargePotentialGauge("zero_mean"),
            solver=fm.ChargeSolverPolicy(
                operator_version="fv_charge_harmonic_source_cut_v1"
            ),
            structured_current_closure=_closed_geometry(),
        )
        payload = transport.to_ir()
        scene = build_scene_document_from_builder(
            {"revision": 1, "current_modules": [payload]}
        )

        rebuilt = build_builder_from_scene_document(scene)
        canonical = rebuilt["current_modules"][0]
        self.assertEqual(canonical["structured_current_closure"], _closed_geometry().to_ir())
        self.assertNotIn("face_index", str(canonical))
        rendered = script_builder._render_current_transport_payload(  # type: ignore[attr-defined]
            canonical,
            surface="fm",
        )
        self.assertIn("structured_current_closure=fm.StructuredCurrentClosure(", rendered)
        self.assertIn("fm.StructuredCurrentSourceCut(", rendered)
        self.assertIn('region=fm.RegionRef("loop", region_id="source-arm")', rendered)
        self.assertIn('fm.StructuredCutPlane(axis="x", offset_m=2e-09', rendered)
        self.assertIn('fm.ImpressedPotentialJump(drive_id="source-1"', rendered)
        compile(rendered, "<structured-current-closure>", "eval")


if __name__ == "__main__":
    unittest.main()
