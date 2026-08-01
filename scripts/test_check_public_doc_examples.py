from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))

from check_public_doc_examples import check_public_examples


class PublicDocumentationExampleContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.page = self.root / "example.md"

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def write(self, code: str) -> None:
        self.page.write_text(f"```python\n{code}\n```\n", encoding="utf-8")

    def test_stage_first_simulation_passes(self) -> None:
        self.write(
            "import fullmag as fm\n"
            "study = fm.study('demo')\n"
            "body = study.geometry(fm.Box(1, 1, 1))\n"
            "study.stages.add_run(stage_id='run', until=1e-12)"
        )
        self.assertEqual([], check_public_examples(self.root))

    def test_problem_snapshot_is_forbidden_even_when_labelled(self) -> None:
        self.write("import fullmag as fm\nproblem = fm.Problem(name='demo')")
        errors = check_public_examples(self.root)
        self.assertTrue(any("must not contain fm.Problem" in error for error in errors))

    def test_object_fragment_without_stage_fails(self) -> None:
        self.write(
            "import fullmag as fm\n"
            "# %% Object-level IR fragment; no solver is launched here\n"
            "term = fm.Exchange()\n"
            "print(term.to_ir())"
        )
        errors = check_public_examples(self.root)
        self.assertTrue(any("complete stage-first scenario" in error for error in errors))

    def test_problem_run_fails_with_the_same_public_boundary(self) -> None:
        self.write(
            "import fullmag as fm\n"
            "# %% Low-level structural inspection\n"
            "snapshot = fm.Problem(name='snapshot')\n"
            "snapshot.run()"
        )
        errors = check_public_examples(self.root)
        self.assertTrue(any("must not contain fm.Problem" in error for error in errors))

    def test_simulation_without_stages_fails(self) -> None:
        self.write(
            "import fullmag as fm\n"
            "problem = fm.TimeEvolution(dynamics=fm.LLG(), outputs=[])\n"
            "magnet = fm.Ferromagnet(...)"
        )
        errors = check_public_examples(self.root)
        self.assertTrue(any("study.stages" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
