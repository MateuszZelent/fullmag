from __future__ import annotations

import copy
import unittest
from typing import Any

from windows.development_scene_assets import (
    SceneAssetError,
    collect_scene_assets,
    _rebase_declared_scene_assets,
)


def eigenmode_scene() -> dict[str, Any]:
    return {
        "version": "scene.v2",
        "objects": [],
        "materials": [],
        "magnetization_assets": [],
        "study": {
            "stages": [
                {
                    "kind": "eigenmodes",
                    "payload": {
                        "eigen_equilibrium_source": "artifact",
                        "eigen_equilibrium_artifact": "C:/study/equilibrium.ovf",
                        "eigen_solver_rtol": 2.5e-8,
                        "eigen_solver_max_outer_iterations": 145,
                        "eigen_solver_max_linear_iterations": 245,
                    },
                }
            ]
        },
        "outputs": {"items": []},
    }


def verified(assets: list[dict[str, str]]) -> list[dict[str, object]]:
    return [
        {
            "asset_id": asset["asset_id"],
            "sha256": "a" * 64,
            "size_bytes": 10,
            "storage_path": f"C:/storage/capsule/assets/{index}.ovf",
        }
        for index, asset in enumerate(assets)
    ]


class DevelopmentModalSceneAssetsTests(unittest.TestCase):
    def test_legacy_tolerance_alias_preserves_exporter_precedence(self) -> None:
        for canonical, alias in ((None, "2.5e-8"), ("", "2.5e-8"), (1e-8, "ignored legacy value")):
            with self.subTest(canonical=canonical, alias=alias):
                scene = eigenmode_scene()
                payload = scene["study"]["stages"][0]["payload"]
                payload["eigen_solver_rtol"] = canonical
                payload["eigen_solver_residual_tolerance"] = alias
                original = copy.deepcopy(scene)
                references = collect_scene_assets(scene)
                self.assertEqual(len(references), 1)
                self.assertEqual(scene, original)

    def test_invalid_active_tolerance_alias_is_rejected(self) -> None:
        scene = eigenmode_scene()
        payload = scene["study"]["stages"][0]["payload"]
        payload.pop("eigen_solver_rtol", None)
        payload["eigen_solver_residual_tolerance"] = "not a tolerance"
        with self.assertRaisesRegex(SceneAssetError, "finite positive number"):
            collect_scene_assets(scene)

    def test_collects_and_rebases_eigenmode_artifact_without_changing_solver_scalars(self) -> None:
        scene = eigenmode_scene()
        original = copy.deepcopy(scene)

        assets = collect_scene_assets(scene)
        restored = _rebase_declared_scene_assets(scene, verified(assets))

        self.assertEqual(
            assets,
            [
                {
                    "asset_id": "/study/stages/0/payload/eigen_equilibrium_artifact",
                    "source_path": "C:/study/equilibrium.ovf",
                }
            ],
        )
        restored_payload = restored["study"]["stages"][0]["payload"]
        original_payload = original["study"]["stages"][0]["payload"]
        self.assertEqual(restored_payload["eigen_equilibrium_artifact"], "C:/storage/capsule/assets/0.ovf")
        for field in (
            "eigen_solver_rtol",
            "eigen_solver_max_outer_iterations",
            "eigen_solver_max_linear_iterations",
        ):
            self.assertEqual(restored_payload[field], original_payload[field])
        self.assertEqual(scene, original)

    def test_rejects_unknown_source_path_in_eigenmodes_payload(self) -> None:
        scene = eigenmode_scene()
        scene["study"]["stages"][0]["payload"]["source_path"] = "C:/study/unowned.ovf"

        with self.assertRaisesRegex(SceneAssetError, "Unsupported eigenmodes payload fields.*source_path"):
            collect_scene_assets(scene)

    def test_validates_eigen_solver_scalars_like_the_scene_document_exporter(self) -> None:
        invalid_cases = (
            ("eigen_solver_rtol", True, "finite positive number"),
            ("eigen_solver_rtol", 0.0, "finite positive number"),
            ("eigen_solver_rtol", "inf", "finite positive number"),
            ("eigen_solver_max_outer_iterations", 10.0, "positive integer"),
            ("eigen_solver_max_linear_iterations", 0, "positive integer"),
            ("eigen_solver_max_outer_iterations", 1 << 31, "native signed iteration limit"),
        )
        for field, value, message in invalid_cases:
            with self.subTest(field=field, value=value):
                scene = eigenmode_scene()
                scene["study"]["stages"][0]["payload"][field] = value
                with self.assertRaisesRegex(SceneAssetError, message):
                    collect_scene_assets(scene)

    def test_optional_eigen_solver_scalars_allow_exported_nulls_and_empty_inputs(self) -> None:
        scene = eigenmode_scene()
        payload = scene["study"]["stages"][0]["payload"]
        payload["eigen_solver_rtol"] = None
        payload["eigen_solver_max_outer_iterations"] = None
        payload["eigen_solver_max_linear_iterations"] = ""

        self.assertEqual(len(collect_scene_assets(scene)), 1)

    def test_solver_overrides_are_only_active_for_eigenmodes(self) -> None:
        scene = eigenmode_scene()
        scene["study"]["stages"][0] = {
            "kind": "frequency_response",
            "payload": {
                "eigen_solver_rtol": None,
                "eigen_solver_max_outer_iterations": None,
                "eigen_solver_max_linear_iterations": None,
            },
        }
        self.assertEqual(collect_scene_assets(scene), [])

        scene["study"]["stages"][0]["payload"]["eigen_solver_rtol"] = 2.5e-8
        with self.assertRaisesRegex(SceneAssetError, "only supported for eigenmodes"):
            collect_scene_assets(scene)


if __name__ == "__main__":
    unittest.main()
