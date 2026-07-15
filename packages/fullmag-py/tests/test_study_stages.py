from __future__ import annotations

import textwrap
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import fullmag as fm


def _load(script_body: str):
    with TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "stages.py"
        path.write_text(textwrap.dedent(script_body), encoding="utf-8")
        return fm.load_problem_from_script(path, lightweight_assets=True)


_PREAMBLE = """
import fullmag as fm
study = fm.study("stable-stage-ids")
study.engine("fem")
body = study.geometry(fm.Box(10e-9, 10e-9, 5e-9), name="film")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.01
body.m = fm.texture.uniform(1, 0, 0)
"""


class StudyStageIdTests(unittest.TestCase):
    def test_run_relax_and_minimize_preserve_explicit_stage_ids(self) -> None:
        loaded = _load(
            _PREAMBLE
            + """
study.stages.add_relax(stage_id="relax", max_steps=2)
study.stages.add_minimize(stage_id="equilibrate", method="bb", max_steps=2)
study.stages.add_run(stage_id="excite", until=4e-12, output_every=1e-12)
"""
        )
        self.assertEqual(
            [stage.stage_id for stage in loaded.stages],
            ["relax", "equilibrate", "excite"],
        )
        self.assertEqual(loaded.stages[2].output_every_seconds, 1e-12)
        excite_ir = loaded.stages[2].to_ir(
            requested_backend=None,
            execution_mode=None,
            execution_precision=None,
            script_source="",
            include_geometry_assets=False,
            study_pipeline=loaded.study_pipeline_document(),
            stage_start_time_s=2e-12,
        )
        self.assertEqual(
            excite_ir["problem_meta"]["runtime_metadata"]["stage_start_time_s"],
            2e-12,
        )
        self.assertEqual(
            excite_ir["problem_meta"]["runtime_metadata"]["active_stage_id"],
            "excite",
        )

    def test_omitted_stage_ids_are_deterministic(self) -> None:
        loaded = _load(
            _PREAMBLE
            + """
study.stages.add_relax(max_steps=2)
study.stages.add_run(4e-12)
"""
        )
        self.assertEqual(
            [stage.stage_id for stage in loaded.stages],
            ["relax-1", "run-1"],
        )

    def test_duplicate_stage_id_is_rejected_at_authoring_time(self) -> None:
        with self.assertRaisesRegex(ValueError, "duplicate stage_id"):
            _load(
                _PREAMBLE
                + """
study.stages.add_relax(stage_id="same", max_steps=2)
study.stages.add_run(stage_id="same", until=4e-12)
"""
            )


if __name__ == "__main__":
    unittest.main()
