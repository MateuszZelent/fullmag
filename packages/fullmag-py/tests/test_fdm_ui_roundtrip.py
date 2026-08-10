from __future__ import annotations

import textwrap
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from fullmag import load_problem_from_script
from fullmag.runtime.scene_document import (
    build_builder_from_scene_document,
    build_scene_document_from_builder,
    builder_overrides_from_scene_document,
)
from fullmag.runtime.script_builder import export_builder_draft, rewrite_loaded_problem_script


class FdmUiRoundTripTests(unittest.TestCase):
    def test_scene_fdm_policy_exports_to_public_python_and_problem_ir(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.py"
            source.write_text(
                textwrap.dedent(
                    """
                    import fullmag as fm

                    fm.engine("fdm")
                    fm.fdm(
                        default_cell=(2e-9, 2e-9, 1e-9),
                        per_magnet={
                            "free": fm.FDMGrid(cell=(1e-9, 1e-9, 1e-9)),
                        },
                        demag=fm.FDMDemag(
                            strategy="single_grid",
                            mode="three_d",
                            common_cells=(64, 32, 4),
                            explain=True,
                        ),
                        boundary_correction="full",
                        boundary_phi_floor=0.1,
                        boundary_delta_min=0.2e-9,
                    )
                    free = fm.geometry(fm.Box(size=(20e-9, 20e-9, 2e-9), name="free"), name="free")
                    free.Ms = 800e3
                    free.Aex = 13e-12
                    free.m = fm.texture.uniform(1.0, 0.0, 0.0)
                    fm.run(1e-12)
                    """
                ).strip()
                + "\n",
                encoding="utf-8",
            )
            loaded = load_problem_from_script(source, lightweight_assets=True)
            scene = build_scene_document_from_builder(export_builder_draft(loaded))
            scene["study"]["fdm"]["demag"].update(
                {
                    "strategy": "multilayer_convolution",
                    "mode": "two_d_stack",
                    "common_cells": None,
                    "common_cells_xy": [64, 32],
                    "explain": False,
                }
            )

            rebuilt = build_builder_from_scene_document(scene)
            overrides = builder_overrides_from_scene_document(scene)
            rendered = rewrite_loaded_problem_script(loaded, overrides=overrides)[
                "rendered_source"
            ]
            assert isinstance(rendered, str)
            self.assertIn(
                'fm.fdm(default_cell=(2e-09, 2e-09, 1e-09), per_magnet={"free": fm.FDMGrid',
                rendered,
            )
            self.assertIn(
                'demag=fm.FDMDemag(strategy="multilayer_convolution", mode="two_d_stack", explain=False',
                rendered,
            )
            self.assertNotIn('fm.demag(realization="multilayer_convolution")', rendered)

            rewritten = root / "rewritten.py"
            rewritten.write_text(rendered, encoding="utf-8")
            round_tripped = load_problem_from_script(rewritten, lightweight_assets=True)

        fdm = round_tripped.problem.discretization.fdm
        self.assertIsNotNone(fdm)
        self.assertEqual(fdm.demag.strategy, "multilayer_convolution")
        self.assertEqual(fdm.demag.mode, "two_d_stack")
        self.assertEqual(fdm.demag.common_cells_xy, (64, 32))
        self.assertFalse(fdm.demag.explain)
        self.assertEqual(fdm.boundary_correction, "full")
        self.assertEqual(fdm.boundary_phi_floor, 0.1)
        self.assertEqual(fdm.boundary_delta_min, 0.2e-9)
        self.assertEqual(
            round_tripped.problem.to_ir()["backend_policy"]["discretization_hints"]["fdm"]["demag"],
            {
                "strategy": "multilayer_convolution",
                "mode": "two_d_stack",
                "common_cells_xy": [64, 32],
            },
        )
        self.assertEqual(rebuilt["fdm"]["demag"]["common_cells_xy"], [64, 32])


if __name__ == "__main__":
    unittest.main()
