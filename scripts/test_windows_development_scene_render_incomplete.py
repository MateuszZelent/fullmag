#!/usr/bin/env python3
"""Interpreted regression checks for incomplete SceneDocument rendering."""

from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "packages" / "fullmag-py" / "src"))

from fullmag.runtime import helper  # noqa: E402
from fullmag.runtime.scene_document import build_scene_document_from_builder  # noqa: E402


def scene_document(*, interaction_enabled: bool) -> dict[str, object]:
    builder: dict[str, object] = {
        "revision": 1,
        "backend": "fdm",
        "requested_mode": "strict",
        "exchange_enabled": interaction_enabled,
        "demag_enabled": False,
        "demag_realization": "auto",
        "solver": {
            "integrator": "rk45",
            "fixed_timestep": "1e-13",
            "relax_algorithm": "llg_overdamped",
            "torque_tolerance": "1e-4",
            "max_relax_steps": "100",
        },
        "geometries": [
            {
                "object_id": "film",
                "name": "Thin Film",
                "geometry_kind": "Box",
                "geometry_params": {"size": [120e-9, 40e-9, 8e-9]},
                "material": {"Ms": 800e3, "Aex": 13e-12, "alpha": 0.02},
                "magnetization": {
                    "kind": "preset_texture",
                    "preset_kind": "uniform",
                    "preset_params": {"direction": [1.0, 0.0, 0.0]},
                    "preset_version": 1,
                },
                "physics_stack": [
                    {"kind": "exchange", "enabled": interaction_enabled}
                ],
            }
        ],
        "stages": [
            {
                "stage_id": "relax",
                "kind": "relax",
                "algorithm": "llg_overdamped",
                "max_steps": 100,
                "torque_tolerance": 1e-4,
            }
        ],
        "fdm": {"default_cell": [4e-9, 4e-9, 4e-9]},
    }
    return build_scene_document_from_builder(builder)


def run_helper(arguments: list[str]) -> tuple[int, dict[str, object]]:
    stdout = io.StringIO()
    with contextlib.redirect_stdout(stdout):
        status = helper.main(arguments)
    return status, json.loads(stdout.getvalue())


class SceneRenderIncompleteChecks(unittest.TestCase):
    def write_scene(self, directory: Path, *, interaction_enabled: bool) -> Path:
        scene_path = directory / "scene.json"
        scene_path.write_text(
            json.dumps(scene_document(interaction_enabled=interaction_enabled)),
            encoding="utf-8",
        )
        return scene_path

    def render_arguments(
        self, scene_path: Path, output_path: Path, *, allow_incomplete: bool
    ) -> list[str]:
        arguments = [
            "render-scene-document",
            "--scene-json",
            str(scene_path),
            "--output",
            str(output_path),
        ]
        if allow_incomplete:
            arguments.append("--allow-incomplete")
        return arguments

    def test_incomplete_opt_in_reports_nonrenderable_and_preserves_output(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            scene_path = self.write_scene(directory, interaction_enabled=False)
            output_path = directory / "scene.py"
            original_bytes = b"existing managed script\n"
            output_path.write_bytes(original_bytes)

            status, payload = run_helper(
                self.render_arguments(
                    scene_path, output_path, allow_incomplete=True
                )
            )

            self.assertEqual(status, 0)
            self.assertEqual(
                payload,
                {
                    "script_path": str(output_path.resolve()),
                    "source_kind": "scene_document",
                    "entrypoint_kind": "flat_workspace",
                    "written": False,
                    "bytes_written": 0,
                },
            )
            self.assertEqual(output_path.read_bytes(), original_bytes)

    def test_strict_render_still_raises_value_error(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            scene_path = self.write_scene(directory, interaction_enabled=False)
            output_path = directory / "scene.py"

            with self.assertRaisesRegex(ValueError, "interaction or material anisotropy"):
                run_helper(
                    self.render_arguments(
                        scene_path, output_path, allow_incomplete=False
                    )
                )

            self.assertFalse(output_path.exists())

    def test_opt_in_does_not_swallow_other_value_errors(self) -> None:
        error = ValueError("unexpected render failure")

        def fail_render(_scene: object) -> str:
            raise error

        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            scene_path = self.write_scene(directory, interaction_enabled=False)
            output_path = directory / "scene.py"

            with patch.object(helper, "render_scene_document_as_script", fail_render):
                with self.assertRaises(ValueError) as raised:
                    run_helper(
                        self.render_arguments(
                            scene_path, output_path, allow_incomplete=True
                        )
                    )

            self.assertIs(raised.exception, error)
            self.assertFalse(output_path.exists())

    def test_runnable_interaction_still_writes_canonical_source(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            scene_path = self.write_scene(directory, interaction_enabled=True)
            output_path = directory / "scene.py"

            status, payload = run_helper(
                self.render_arguments(
                    scene_path, output_path, allow_incomplete=True
                )
            )

            source = output_path.read_text(encoding="utf-8")
            self.assertEqual(status, 0)
            self.assertEqual(payload["script_path"], str(output_path.resolve()))
            self.assertEqual(payload["source_kind"], "scene_document")
            self.assertEqual(payload["entrypoint_kind"], "flat_workspace")
            self.assertIs(payload["written"], True)
            self.assertEqual(payload["bytes_written"], len(source.encode("utf-8")))
            self.assertTrue(source.startswith('"""Canonical Fullmag script'))


if __name__ == "__main__":
    unittest.main(verbosity=2)
