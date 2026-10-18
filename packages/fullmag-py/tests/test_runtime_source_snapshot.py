from __future__ import annotations

from contextlib import redirect_stdout
from io import StringIO
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import fullmag as fm
from fullmag.runtime.helper import MAX_SOURCE_SNAPSHOT_BYTES, _read_source_snapshot, main
from fullmag.runtime.loader import load_problem_from_script


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


if __name__ == "__main__":
    unittest.main()
