"""Focused checks for deterministic output and standalone case contracts."""
from __future__ import annotations

import ast
import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

GENERATOR_PATH = Path(__file__).with_name("generate_cases.py")
SPEC = importlib.util.spec_from_file_location("bimeron_matrix_generator", GENERATOR_PATH)
assert SPEC is not None and SPEC.loader is not None
GENERATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GENERATOR)


class ScenarioMatrixGeneratorTests(unittest.TestCase):
    def test_build_outputs_is_repeatable_and_has_full_factorial(self) -> None:
        first = GENERATOR.build_outputs()
        second = GENERATOR.build_outputs()
        self.assertEqual(first, second)
        scripts = {name: data for name, data in first.items() if name.startswith("cases/")}
        self.assertEqual(len(scripts), 12)

        manifest = json.loads(first["manifest.json"])
        self.assertEqual(manifest["case_count"], 12)
        combinations = {
            (
                case["film_material"]["key"],
                case["initial_states"]["film"]["key"],
                case["initial_states"]["cylinder"]["key"],
            )
            for case in manifest["cases"]
        }
        self.assertEqual(len(combinations), 3 * 2 * 2)
        self.assertEqual(len({case["study_name"] for case in manifest["cases"]}), 12)

    def test_every_case_is_a_standalone_non_autorun_python_script(self) -> None:
        outputs = GENERATOR.build_outputs()
        manifest = json.loads(outputs["manifest.json"])
        allowed_imports = {"fullmag", "os", "pathlib"}
        for case in manifest["cases"]:
            path = case["script"]
            source = outputs[path].decode("utf-8")
            tree = ast.parse(source, filename=path)
            imports: set[str] = set()
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    imports.update(alias.name.split(".", 1)[0] for alias in node.names)
                elif isinstance(node, ast.ImportFrom):
                    imports.add((node.module or "").split(".", 1)[0])
                elif isinstance(node, ast.Call):
                    function = node.func
                    called_name = function.attr if isinstance(function, ast.Attribute) else (
                        function.id if isinstance(function, ast.Name) else ""
                    )
                    self.assertNotIn(called_name, {"run", "solve"}, path)
            self.assertLessEqual(imports, allowed_imports, path)
            self.assertEqual(hashlib.sha256(outputs[path]).hexdigest(), case["script_sha256"])
            self.assertEqual(case["expected_output_path"], str(Path(path).with_suffix(".zarr")))
            self.assertIn('study.storage(output_dir=CASE_ID + ".zarr", data_format="zarr")', source)
            self.assertNotIn('FULLMAG_PROJECT_STORAGE_ROOT', source)
            self.assertIn('algorithm="projected_gradient_bb"', source)
            self.assertIn("max_steps=3000", source)
            self.assertIn("every_steps=100", source)
            self.assertIn('fm.FieldAutosave("m", every_steps=1000)', source)
            self.assertIn('fm.FieldAutosave("H_demag", every_steps=1000)', source)
            self.assertIn('study.fdm(', source)
            self.assertIn('fft_backend="cufft"', source)
            self.assertNotIn("study.run(", source)
            self.assertNotIn("study.solve(", source)
            if case["film_material"]["key"] == "rdmi_current":
                self.assertIn("fm.RotatedInterfacialDMI(", source)
                self.assertIn("object_ids=[film.object_id]", source)
            else:
                self.assertNotIn("fm.RotatedInterfacialDMI(", source)
                self.assertNotIn("film.anisU", source)

    def test_symlinked_case_target_is_rejected_without_writing_through_it(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            GENERATOR.write_outputs(root)
            victim = root / "victim.txt"
            victim.write_bytes(b"preserve me")
            case_path = root / "cases/material_rdmi_current__film_bimeron__cylinder_plus_x.py"
            case_path.unlink()
            case_path.symlink_to(victim)
            with self.assertRaisesRegex(ValueError, "symlinked generated file"):
                GENERATOR.write_outputs(root)
            self.assertEqual(victim.read_bytes(), b"preserve me")

    def test_write_is_idempotent_and_check_is_read_only(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            file_count, changed_count = GENERATOR.write_outputs(root)
            self.assertEqual(file_count, 13)
            self.assertEqual(changed_count, 13)
            self.assertEqual(GENERATOR.check_outputs(root), (13, 0))
            self.assertEqual(GENERATOR.write_outputs(root), (13, 0))

    def test_modified_case_is_preserved_and_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            GENERATOR.write_outputs(root)
            path = root / "cases/material_rdmi_current__film_bimeron__cylinder_plus_x.py"
            user_content = path.read_bytes() + b"\n# local user edit\n"
            path.write_bytes(user_content)
            with self.assertRaisesRegex(ValueError, "refusing to overwrite"):
                GENERATOR.write_outputs(root)
            self.assertEqual(path.read_bytes(), user_content)


if __name__ == "__main__":
    unittest.main()
