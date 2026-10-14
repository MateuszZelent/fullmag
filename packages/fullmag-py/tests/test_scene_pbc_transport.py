"""Strict SceneDocument transport for the existing PBC contract."""

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import fullmag as fm
from fullmag.model.problem import FdmPbc
from fullmag.runtime.scene_document import (
    build_builder_from_scene_document,
    build_scene_document_from_builder,
    builder_overrides_from_scene_document,
)
from fullmag.runtime.scene_document_ir import scene_document_to_problem_ir
from fullmag.runtime.script_builder import (
    export_builder_draft,
    render_loaded_problem_as_script,
)


PBC_XY = {"axes": ["periodic", "periodic", "open"], "demag": "open"}
PBC_XYZ_IMAGES = {
    "axes": ["periodic", "periodic", "periodic"],
    "demag": "truncated_images",
    "image_counts": [2, 1, 0],
}
PBC_AIRBOX = {
    "axes": ["periodic", "periodic", "open"],
    "demag": "periodic_airbox_k0",
}


def _empty_scene(pbc_marker: object = ...) -> dict[str, object]:
    study: dict[str, object] = {}
    if pbc_marker is not ...:
        study["pbc"] = pbc_marker
    return {"version": "scene.v2", "objects": [], "study": study}


class ScenePbcTransportTests(unittest.TestCase):
    def test_empty_scene_preserves_authored_pbc_without_becoming_executable(self):
        builder = {"geometries": [], "pbc": PBC_XY}
        scene = build_scene_document_from_builder(builder)

        self.assertEqual(scene["study"]["pbc"], PBC_XY)
        rebuilt = build_builder_from_scene_document(scene)
        self.assertEqual(rebuilt["pbc"], PBC_XY)
        with self.assertRaisesRegex(
            ValueError, "SceneDocument export requires at least one geometry object"
        ):
            scene_document_to_problem_ir(
                scene,
                requested_backend="fem",
                requested_device="cpu",
                requested_precision="double",
                requested_mode="strict",
            )

    def test_missing_pbc_is_absent_while_explicit_null_is_a_clear(self):
        missing = _empty_scene()
        missing_builder = build_builder_from_scene_document(missing)
        self.assertNotIn("pbc", missing_builder)
        self.assertNotIn("pbc", builder_overrides_from_scene_document(missing))

        explicit_null = _empty_scene(None)
        null_builder = build_builder_from_scene_document(explicit_null)
        self.assertIn("pbc", null_builder)
        self.assertIsNone(null_builder["pbc"])
        overrides = builder_overrides_from_scene_document(explicit_null)
        self.assertIn("pbc", overrides)
        self.assertIsNone(overrides["pbc"])

        emitted = build_scene_document_from_builder({"geometries": [], "pbc": None})
        self.assertIn("pbc", emitted["study"])
        self.assertIsNone(emitted["study"]["pbc"])

    def test_valid_periodicity_and_image_policies_round_trip(self):
        for payload in (PBC_XY, PBC_XYZ_IMAGES, PBC_AIRBOX):
            with self.subTest(payload=payload):
                scene = _empty_scene(payload)
                decoded = build_builder_from_scene_document(scene)
                self.assertEqual(decoded["pbc"], payload)
                self.assertEqual(
                    build_scene_document_from_builder(decoded)["study"]["pbc"],
                    payload,
                )

    def test_malformed_pbc_is_rejected_before_coercion_or_loss(self):
        invalid = [
            True,
            [],
            {"axes": [True, False, False], "demag": "open"},
            {"axes": ["periodic", "open"], "demag": "open"},
            {"axes": ["periodic", "open", "open"]},
            {"axes": ["periodic", "open", "open"], "demag": "OPEN"},
            {"axes": ["periodic", "open", "open"], "demag": "open", "future": 1},
            {
                "axes": ["periodic", "periodic", "periodic"],
                "demag": "open",
                "image_counts": [1, 0, 0],
            },
            {
                "axes": ["periodic", "periodic", "periodic"],
                "demag": "truncated_images",
                "image_counts": [True, 0, 0],
            },
            {
                "axes": ["periodic", "periodic", "periodic"],
                "demag": "truncated_images",
                "image_counts": [1, -1, 0],
            },
            {
                "axes": ["periodic", "periodic", "periodic"],
                "demag": "truncated_images",
                "image_counts": [1, 1 << 32, 0],
            },
            {
                "axes": ["periodic", "open", "open"],
                "demag": "periodic_airbox_k0",
            },
        ]
        for payload in invalid:
            with self.subTest(payload=payload), self.assertRaises((TypeError, ValueError)):
                build_builder_from_scene_document(_empty_scene(payload))

    def test_scene_problem_ir_lowers_authored_pbc(self):
        with TemporaryDirectory() as temporary:
            source = Path(temporary) / "pbc_ir.py"
            source.write_text(
                """import fullmag as fm
study = fm.study('scene-pbc-ir')
study.engine('fem')
film = study.geometry(fm.Box(40e-9, 40e-9, 10e-9), name='film')
film.Ms = 800000
film.Aex = 13e-12
film.m = fm.texture.uniform(1, 0, 0)
study.pbc(x=True, y=True)
study.storage(
    output_dir="authored-results.zarr",
    temp_dir="authored-tmp",
    cleanup="never",
    existing_output="error",
)
""",
                encoding="utf-8",
            )
            loaded = fm.load_problem_from_script(source, lightweight_assets=True)
            scene = build_scene_document_from_builder(export_builder_draft(loaded))
            storage = fm.OutputStorage(
                output_dir="authored-results.zarr",
                temp_dir="authored-tmp",
                cleanup="never",
                existing_output="error",
            )
            self.assertEqual(scene["study"]["output_storage"], storage.to_ir())
            ir = scene_document_to_problem_ir(
                scene,
                requested_backend="fem",
                requested_device="cpu",
                requested_precision="double",
                requested_mode="strict",
                source_root=temporary,
            )

        self.assertEqual(ir["pbc"], PBC_XY)
        runtime_metadata = ir["problem_meta"]["runtime_metadata"]
        self.assertEqual(runtime_metadata["output_storage"], storage.to_ir())
        self.assertEqual(
            Path(runtime_metadata["output_storage_source_dir"]), Path(temporary).resolve()
        )
        self.assertNotIn("output_storage_source_stem", runtime_metadata)

    def test_script_overrides_clear_or_preserve_full_pbc_policy(self):
        with TemporaryDirectory() as temporary:
            source = Path(temporary) / "pbc_source.py"
            source.write_text(
                """import fullmag as fm
study = fm.study('scene-pbc-script')
study.engine('fem')
film = study.geometry(fm.Box(40e-9, 40e-9, 10e-9), name='film')
film.Ms = 800000
film.Aex = 13e-12
film.m = fm.texture.uniform(1, 0, 0)
study.pbc(x=True, y=True)
""",
                encoding="utf-8",
            )
            loaded = fm.load_problem_from_script(source, lightweight_assets=True)

            cleared = render_loaded_problem_as_script(loaded, overrides={"pbc": None})
            source.write_text(cleared, encoding="utf-8")
            cleared_loaded = fm.load_problem_from_script(source, lightweight_assets=True)
            self.assertIsNone(cleared_loaded.problem.pbc)

            authored = dict(PBC_XYZ_IMAGES)
            rendered = render_loaded_problem_as_script(
                loaded, overrides={"pbc": authored}
            )
            source.write_text(rendered, encoding="utf-8")
            rendered_loaded = fm.load_problem_from_script(source, lightweight_assets=True)
            self.assertEqual(
                rendered_loaded.problem.pbc,
                FdmPbc((True, True, True), "truncated_images", (2, 1, 0)),
            )


if __name__ == "__main__":
    unittest.main()
