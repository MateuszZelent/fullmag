"""Source regression only; does not execute Rust validation or a mesher."""
from pathlib import Path
import argparse
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--git-ref")
args, unittest_args = parser.parse_known_args()


def read_geometry():
    if args.git_ref:
        return subprocess.check_output(
            ["git", "show", f"{args.git_ref}:crates/fullmag-authoring/src/geometry.rs"],
            cwd=ROOT, text=True, encoding="utf-8",
        )
    return (ROOT / "crates/fullmag-authoring/src/geometry.rs").read_text(encoding="utf-8")


class AuxiliaryGeometryValidationSourceTests(unittest.TestCase):
    def test_material_reference_is_optional_only_for_nonmagnetic_geometry(self):
        text = read_geometry()
        body = text.split("fn validate_object_geometry(", 1)[1].split("fn ", 1)[0]
        self.assertIn('let requires_magnetic_refs = object.role == "magnet";', body)
        self.assertIn('(requires_magnetic_refs || !object.material_ref.trim().is_empty())', body)
        self.assertIn('"GEOMETRY_OBJECT_MATERIAL_MISSING"', body)

    def test_explicit_magnetization_reference_remains_checked(self):
        body = read_geometry().split("fn validate_object_geometry(", 1)[1].split("fn ", 1)[0]
        self.assertIn('if requires_magnetic_refs || object.magnetization_ref.is_some()', body)
        self.assertIn('.any(|asset| asset.id == *reference)', body)
        self.assertIn('"GEOMETRY_OBJECT_MAGNETIZATION_MISSING"', body)
        self.assertIn('validate_geometry_node(', body)
        self.assertIn('!transform_is_valid(&object.transform)', body)

    def test_auxiliary_body_is_not_filtered_out_of_realization(self):
        body = read_geometry().split("pub fn build_geometry_workspace(", 1)[1].split("pub fn geometry_blocks_mesh_build", 1)[0]
        self.assertIn('for object in &scene.objects', body)
        self.assertIn('bodies.push(GeometryBody', body)
        self.assertNotIn('object.role', body)


if __name__ == "__main__":
    unittest.main(argv=[__file__, *unittest_args])
