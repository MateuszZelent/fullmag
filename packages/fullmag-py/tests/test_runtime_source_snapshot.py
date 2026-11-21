from __future__ import annotations

from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

import fullmag as fm
from fullmag.runtime.helper import (
    MAX_SOURCE_SNAPSHOT_BYTES,
    _read_source_snapshot,
    _run_cli,
    main,
)
from fullmag.runtime.loader import load_problem_from_script
from fullmag.runtime.script_builder import export_builder_draft


SCRIPT_TEMPLATE = '''from pathlib import Path
import fullmag as fm

origin = (Path(__file__).parent / "origin.txt").read_text(encoding="utf-8").strip()
study = fm.study("SNAPSHOT_NAME_" + origin)
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
probe = study.geometry(fm.Box(100e-9, 40e-9, 5e-9), name="probe")
probe.Ms = 800e3
probe.Aex = 13e-12
probe.alpha = 0.02
probe.m = fm.texture.uniform(1, 0, 0)
study.stages.add_run(1e-12, stage_id="run")
'''


class RuntimeSourceSnapshotTests(unittest.TestCase):
    def tearDown(self) -> None:
        fm.reset()

    def test_snapshot_reader_rejects_oversize_and_nonregular_inputs(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            oversized = root / "oversized.py"
            oversized.write_bytes(b"x" * (MAX_SOURCE_SNAPSHOT_BYTES + 1))
            with self.assertRaisesRegex(ValueError, "bounded regular file"):
                _read_source_snapshot(str(oversized))
            if hasattr(os, "mkfifo"):
                fifo = root / "source.fifo"
                os.mkfifo(fifo)
                with self.assertRaisesRegex(ValueError, "bounded regular file"):
                    _read_source_snapshot(str(fifo))

    def test_helper_exports_use_captured_bytes_and_preserve_logical_origin(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "workspace.py"
            snapshot = root / "captured.py"
            origin = "logical-origin"
            source_text = SCRIPT_TEMPLATE.replace("SNAPSHOT_NAME", "source")
            captured_text = SCRIPT_TEMPLATE.replace("SNAPSHOT_NAME", "captured").replace("\n", "\r\n")
            source.write_text(source_text, encoding="utf-8")
            (root / "origin.txt").write_text(origin, encoding="utf-8")
            snapshot.write_bytes(captured_text.encode("utf-8"))
            self.assertEqual(_read_source_snapshot(str(snapshot)), captured_text.encode("utf-8"))

            def export(command: str) -> dict[str, object]:
                output = StringIO()
                arguments = [
                    command,
                    "--script",
                    str(source),
                    "--source-snapshot",
                    str(snapshot),
                ]
                if command == "export-run-config":
                    arguments.append("--skip-geometry-assets")
                with redirect_stdout(output):
                    self.assertEqual(main(arguments), 0)
                return json.loads(output.getvalue())

            scene = export("export-scene-document")
            config = export("export-run-config")
            loaded = load_problem_from_script(
                source,
                lightweight_assets=True,
                source_bytes=snapshot.read_bytes(),
            )

        self.assertEqual(scene["scene"]["name"], "captured_logical-origin")
        self.assertEqual(config["ir"]["problem_meta"]["name"], "captured_logical-origin")
        self.assertEqual(loaded.source_path, source.resolve())
        self.assertEqual(loaded.script_source, captured_text)

    def test_scene_export_reads_same_size_rewrite_within_pyc_timestamp_resolution(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "preview.py"
            template = '''import fullmag as fm
fm.engine("fdm")
fm.device("cpu")
fm.cell(5e-9, 5e-9, 10e-9)
fm.solver(fix_dt=1e-13)
body = fm.geometry(fm.Box(40e-9, 20e-9, 10e-9), name="body")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.05
body.m = fm.texture.uniform(0, 0, 1)
core = body.add_region("core", fm.Box(10e-9, 20e-9, 10e-9), region_id="core")
core.texture = fm.texture.uniform({direction})
fm.run(1e-10)
'''
            first_text = template.format(direction="0, 0, 1")
            second_text = template.format(direction="0, 1, 0")
            self.assertEqual(len(first_text), len(second_text))
            cache_timestamp = 1_700_000_000

            environment = os.environ.copy()
            environment.pop("PYTHONDONTWRITEBYTECODE", None)
            environment["PYTHONPYCACHEPREFIX"] = str(root / "pycache")
            package_source = str(Path(__file__).resolve().parents[1] / "src")
            environment["PYTHONPATH"] = os.pathsep.join(
                part for part in (package_source, environment.get("PYTHONPATH", "")) if part
            )

            def export() -> dict[str, object]:
                result = subprocess.run(
                    [
                        sys.executable,
                        "-m",
                        "fullmag.runtime.helper",
                        "export-scene-document",
                        "--script",
                        str(source),
                    ],
                    check=True,
                    capture_output=True,
                    text=True,
                    env=environment,
                )
                return json.loads(result.stdout)

            source.write_text(first_text, encoding="utf-8")
            os.utime(source, (cache_timestamp, cache_timestamp))
            first_scene = export()
            first_direction = first_scene["objects"][0]["regions"][0]["texture_override"][
                "initial_magnetization"
            ]["preset_params"]["direction"]
            self.assertEqual(first_direction, [0.0, 0.0, 1.0])

            # Materialize the first version's timestamp-based bytecode cache
            # even when the test runner itself was launched with -B.
            subprocess.run(
                [
                    sys.executable,
                    "-c",
                    "import py_compile,sys; py_compile.compile(sys.argv[1], doraise=True, "
                    "invalidation_mode=py_compile.PycInvalidationMode.TIMESTAMP)",
                    str(source),
                ],
                check=True,
                env=environment,
            )
            source.write_text(second_text, encoding="utf-8")
            os.utime(source, (cache_timestamp, cache_timestamp))
            self.assertEqual(source.stat().st_size, len(first_text.encode("utf-8")))
            self.assertEqual(int(source.stat().st_mtime), cache_timestamp)

            second_scene = export()
            second_direction = second_scene["objects"][0]["regions"][0]["texture_override"][
                "initial_magnetization"
            ]["preset_params"]["direction"]
            self.assertEqual(second_direction, [0.0, 1.0, 0.0])
            loaded = load_problem_from_script(source, lightweight_assets=True)
            self.assertEqual(loaded.script_source, second_text)
            loaded_draft = export_builder_draft(loaded)
            loaded_direction = loaded_draft["geometries"][0]["object_regions"][0][
                "texture_override"
            ]["initial_magnetization"]["preset_params"]["direction"]
            self.assertEqual(loaded_direction, [0.0, 1.0, 0.0])

    def test_scene_export_reports_a_raising_script_as_a_typed_rejection(self) -> None:
        with TemporaryDirectory() as temporary:
            source = Path(temporary) / "broken.py"
            source.write_text(
                'print("user output", end="")\n'
                'raise ValueError("explicit timestep policy is required")\n',
                encoding="utf-8",
            )
            output = StringIO()
            with redirect_stdout(output), redirect_stderr(StringIO()):
                status = _run_cli([
                    "export-scene-document",
                    "--script",
                    str(source),
                    "--source-snapshot",
                    str(source),
                ])
        self.assertEqual(status, 2)
        self.assertEqual(json.loads(output.getvalue().splitlines()[-1]), {
            "schema": "fullmag.script-load-rejection.v1",
            "code": "script_load_failed",
            "error_type": "ValueError",
            "message": "explicit timestep policy is required",
            "script_line": 2,
        })

    def test_scene_export_does_not_reclassify_an_unreadable_snapshot(self) -> None:
        with TemporaryDirectory() as temporary:
            source = Path(temporary) / "workspace.py"
            source.write_text("raise ValueError('not reached')\n", encoding="utf-8")
            with self.assertRaises(FileNotFoundError):
                _run_cli([
                    "export-scene-document",
                    "--script",
                    str(source),
                    "--source-snapshot",
                    str(Path(temporary) / "missing.py"),
                ])

    def test_scene_export_rejects_a_pinned_mesh_outside_the_script_directory(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            script_dir = root / "scripts"
            script_dir.mkdir()
            (script_dir / "origin.txt").write_text("origin", encoding="utf-8")
            source = script_dir / "workspace.py"
            reference = {
                "source": str(root / "outside.fullmag-mesh"),
                "sha256": "a" * 64,
                "build_requested": False,
            }
            source.write_text(
                SCRIPT_TEMPLATE.replace('study.engine("fdm")', 'study.engine("fem")')
                + f"fm.runtime_metadata('fem_domain_mesh', {reference!r})\n",
                encoding="utf-8",
            )
            output = StringIO()
            with redirect_stdout(output), redirect_stderr(StringIO()):
                status = _run_cli(["export-scene-document", "--script", str(source)])
        self.assertEqual(status, 2)
        rejection = json.loads(output.getvalue().splitlines()[-1])
        self.assertEqual(rejection["schema"], "fullmag.script-load-rejection.v1")
        self.assertEqual(rejection["error_type"], "PinnedFemMeshSourceOutsideRoot")
        self.assertIn("source script's directory", rejection["message"])


if __name__ == "__main__":
    unittest.main()
