"""Physical material inputs must survive both canonical Python export paths."""

from pathlib import Path
import tempfile
import unittest

import fullmag as fm
from fullmag.runtime.scene_document import build_scene_document_from_builder
from fullmag.runtime.script_builder import (
    export_builder_draft,
    render_scene_document_as_script,
    rewrite_loaded_problem_script,
)


class RegionalMaterialPrecisionTests(unittest.TestCase):
    def test_material_fields_and_interface_parameters_preserve_f64_values(self):
        expressions = {
            "constant": "fm.fields.constant(874632.5657107424)",
            "linear": ("fm.fields.linear(base=874632.5657107424, "
                       "gradient=(1.2345678901234567e11, -2.3456789012345678e11, 0.0))"),
            "radial": ("fm.fields.radial(center=(1.2345678901234568e-9, 0.0, 0.0), "
                       "radius=2.3456789012345678e-9, inside=874632.5657107424, "
                       "outside=745678.9012345678)"),
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for kind, expression in expressions.items():
                coupling = (
                    'mode="harmonic_mean", scale=0.3456789012345678'
                    if kind == "linear" else
                    'mode="explicit", inter_exchange=4.123456789012345e-12'
                )
                script = f'''import fullmag as fm
study = fm.study("regional-precision")
study.engine("fdm").device("cpu").mode("strict")
study.cell(2e-9, 2e-9, 2e-9)
body = study.geometry(fm.Box(size=(100e-9, 20e-9, 2e-9)), name="body")
body.Ms = 812345.6789012345
body.Aex = 1.3141592653589793e-11
body.alpha = 0.02345678901234567
body.Ku1 = 12345.678901234567
body.anisU = (0.0, 0.0, 1.0)
left = body.add_region("left", fm.Box(size=(50e-9, 20e-9, 2e-9)).translate((-25e-9, 0.0, 0.0)))
right = body.add_region("right", fm.Box(size=(50e-9, 20e-9, 2e-9)).translate((25e-9, 0.0, 0.0)))
right.material_transition(kind="metric", width=1.234567890123456e-9, scope="inside")
right.set_material_field("Ms", {expression})
right.material.Aex = 1.284590475785592e-11
right.material.alpha = 0.01802996588023435
study.couplings.exchange(left, right, {coupling})
study.run(1e-14)
'''
                source = root / f"source_{kind}.py"
                source.write_text(script, encoding="utf-8")
                loaded = fm.load_problem_from_script(source, lightweight_assets=True)
                original = loaded.problem.to_ir(include_geometry_assets=False)
                scene = build_scene_document_from_builder(export_builder_draft(loaded))
                exports = {
                    "problem": rewrite_loaded_problem_script(loaded)["rendered_source"],
                    "scene": render_scene_document_as_script(scene),
                }
                for path, rendered in exports.items():
                    with self.subTest(kind=kind, path=path):
                        target = root / f"exported_{kind}_{path}.py"
                        target.write_text(rendered, encoding="utf-8")
                        reloaded = fm.load_problem_from_script(target, lightweight_assets=True)
                        actual = reloaded.problem.to_ir(include_geometry_assets=False)
                        self.assertEqual(actual["materials"], original["materials"])
                        self.assertEqual(
                            [r["material_overrides"] for r in actual["object_regions"]],
                            [r["material_overrides"] for r in original["object_regions"]],
                        )
                        self.assertEqual(
                            [r.get("material_transition") for r in actual["object_regions"]],
                            [r.get("material_transition") for r in original["object_regions"]],
                        )
                        self.assertEqual(
                            [c["parameters"] for c in actual["couplings"]],
                            [c["parameters"] for c in original["couplings"]],
                        )


if __name__ == "__main__":
    unittest.main()
