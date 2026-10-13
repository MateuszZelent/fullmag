"""Source guards only; do not execute Rust validators or qualify runtime behavior."""
from pathlib import Path
import argparse
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--git-ref")
args, remaining = parser.parse_known_args()


def validation_source():
    path = "crates/fullmag-authoring/src/validation.rs"
    if args.git_ref:
        return subprocess.check_output(["git", "show", f"{args.git_ref}:{path}"],
                                       cwd=ROOT, text=True, encoding="utf-8")
    return (ROOT / path).read_text(encoding="utf-8")


class SceneAuthoringReferenceSourceTests(unittest.TestCase):
    def body(self):
        return validation_source().split("fn validate_scene_document_with_mode(", 1)[1].split(
            "fn ", 1)[0]

    def test_explicit_material_reference_is_checked_in_both_modes_and_all_roles(self):
        body = self.body()
        self.assertNotIn('if object.role != "magnet" {\n            continue;', body)
        self.assertNotIn("if !require_solve_refs {\n            continue;", body)
        self.assertIn('let requires_magnetic_refs = require_solve_refs && object.role == "magnet";', body)
        self.assertIn('(requires_magnetic_refs || !object.material_ref.trim().is_empty())', body)
        self.assertIn('!material_ids.contains(&object.material_ref)', body)

    def test_explicit_magnetization_is_checked_without_requiring_draft_assignment(self):
        body = self.body()
        self.assertIn('Some(reference) if !magnetization_ids.contains(reference)', body)
        self.assertIn('None if requires_magnetic_refs', body)
        self.assertIn('.filter(|reference| !reference.trim().is_empty())', body)

    def test_execution_and_authoring_gates_stay_distinct(self):
        source = validation_source()
        self.assertIn('validate_scene_document_with_mode(scene, true)', source)
        self.assertIn('validate_scene_document_with_mode(scene, false)', source)


if __name__ == "__main__":
    unittest.main(argv=[__file__, *remaining])
