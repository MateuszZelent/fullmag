from __future__ import annotations

import inspect
import importlib.util
import json
from pathlib import Path
import re
import unittest

import fullmag as fm


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
PUBLIC_DOCS_ROOT = REPOSITORY_ROOT / "public_docs/site"
WORKFLOW = REPOSITORY_ROOT / ".github/workflows/documentation.yml"

API_PARAMETER_OWNERS: dict[str, Path] = {
    "Material": Path("python-api/materials/material.md"),
    "Box": Path("python-api/geometry/primitives.md"),
    "Ferromagnet": Path("python-api/magnets-and-textures/ferromagnet.md"),
    "texture.uniform": Path("python-api/magnets-and-textures/uniform-texture.md"),
    "texture.random": Path("python-api/magnets-and-textures/preset-textures.md"),
    "texture.random_seeded": Path("python-api/magnets-and-textures/preset-textures.md"),
    "texture.vortex": Path("python-api/magnets-and-textures/preset-textures.md"),
    "texture.antivortex": Path("python-api/magnets-and-textures/preset-textures.md"),
    "texture.bloch_skyrmion": Path("python-api/magnets-and-textures/preset-textures.md"),
    "texture.neel_skyrmion": Path("python-api/magnets-and-textures/preset-textures.md"),
    "texture.antiskyrmion": Path("python-api/magnets-and-textures/preset-textures.md"),
    "texture.skyrmionium": Path("python-api/magnets-and-textures/preset-textures.md"),
    "texture.hopfion": Path("python-api/magnets-and-textures/preset-textures.md"),
    "texture.bimeron": Path("python-api/magnets-and-textures/preset-textures.md"),
    "texture.domain_wall": Path("python-api/magnets-and-textures/preset-textures.md"),
    "texture.two_domain": Path("python-api/magnets-and-textures/preset-textures.md"),
    "texture.helical": Path("python-api/magnets-and-textures/preset-textures.md"),
    "texture.conical": Path("python-api/magnets-and-textures/preset-textures.md"),
    "TimeEvolution": Path("python-api/studies/time-evolution.md"),
    "LLG": Path("python-api/dynamics/llg.md"),
    "SaveField": Path("python-api/outputs/fields-and-scalars.md"),
    "SaveScalar": Path("python-api/outputs/fields-and-scalars.md"),
    "Problem": Path("python-api/problem/problem.md"),
    "DiscretizationHints": Path("python-api/discretization/discretization-hints.md"),
    "FDM": Path("python-api/meshing/fdm/index.md"),
    "FEM": Path("python-api/meshing/fem/index.md"),
    "MaterialParameterField.constant": Path(
        "python-api/materials/spatial-parameter-fields.md"
    ),
    "MaterialParameterField.linear": Path(
        "python-api/materials/spatial-parameter-fields.md"
    ),
    "MaterialParameterField.radial": Path(
        "python-api/materials/spatial-parameter-fields.md"
    ),
    "MaterialParameterField.sampled": Path(
        "python-api/materials/spatial-parameter-fields.md"
    ),
}

API_CONSTRUCTORS = {
    "Material": fm.Material,
    "Box": fm.Box,
    "Ferromagnet": fm.Ferromagnet,
    "texture.uniform": fm.texture.uniform,
    "texture.random": fm.texture.random,
    "texture.random_seeded": fm.texture.random_seeded,
    "texture.vortex": fm.texture.vortex,
    "texture.antivortex": fm.texture.antivortex,
    "texture.bloch_skyrmion": fm.texture.bloch_skyrmion,
    "texture.neel_skyrmion": fm.texture.neel_skyrmion,
    "texture.antiskyrmion": fm.texture.antiskyrmion,
    "texture.skyrmionium": fm.texture.skyrmionium,
    "texture.hopfion": fm.texture.hopfion,
    "texture.bimeron": fm.texture.bimeron,
    "texture.domain_wall": fm.texture.domain_wall,
    "texture.two_domain": fm.texture.two_domain,
    "texture.helical": fm.texture.helical,
    "texture.conical": fm.texture.conical,
    "TimeEvolution": fm.TimeEvolution,
    "LLG": fm.LLG,
    "SaveField": fm.SaveField,
    "SaveScalar": fm.SaveScalar,
    "Problem": fm.Problem,
    "DiscretizationHints": fm.DiscretizationHints,
    "FDM": fm.FDM,
    "FEM": fm.FEM,
    "MaterialParameterField.constant": fm.MaterialParameterField.constant,
    "MaterialParameterField.linear": fm.MaterialParameterField.linear,
    "MaterialParameterField.radial": fm.MaterialParameterField.radial,
    "MaterialParameterField.sampled": fm.MaterialParameterField.sampled,
}


class PublicPythonApiDocumentationTests(unittest.TestCase):
    def test_parameter_tables_have_stable_markdown_columns(self) -> None:
        malformed: list[str] = []
        unescaped_pipe = re.compile(r"(?<!\\)\|")
        for relative_page in sorted(set(API_PARAMETER_OWNERS.values())):
            lines = (PUBLIC_DOCS_ROOT / relative_page).read_text(encoding="utf-8").splitlines()
            expected_columns: int | None = None
            for line_number, line in enumerate(lines, start=1):
                if not line.startswith("|"):
                    expected_columns = None
                    continue
                separators = len(unescaped_pipe.findall(line))
                if expected_columns is None:
                    expected_columns = separators
                if separators != expected_columns:
                    malformed.append(
                        f"{relative_page}:{line_number}: {separators} separators, "
                        f"expected {expected_columns}"
                    )
        self.assertEqual(malformed, [])

    def test_each_constructor_signature_is_complete_on_its_owner_page(self) -> None:
        missing: list[str] = []
        duplicate_owners: list[str] = []
        owner_pages = {
            path: (PUBLIC_DOCS_ROOT / path).read_text(encoding="utf-8")
            for path in set(API_PARAMETER_OWNERS.values())
        }
        for qualified_name, owner in API_PARAMETER_OWNERS.items():
            page = owner_pages[owner]
            constructor = API_CONSTRUCTORS[qualified_name]
            for parameter in inspect.signature(constructor).parameters.values():
                if parameter.kind in {
                    inspect.Parameter.VAR_POSITIONAL,
                    inspect.Parameter.VAR_KEYWORD,
                }:
                    continue
                token = f"`{qualified_name}.{parameter.name}`"
                if token not in page:
                    missing.append(f"{owner}: {token}")
                for other_owner, other_page in owner_pages.items():
                    if other_owner != owner and token in other_page:
                        duplicate_owners.append(f"{token}: {owner} and {other_owner}")
        self.assertEqual(missing, [], f"undocumented constructor parameters: {missing}")
        self.assertEqual(
            duplicate_owners,
            [],
            f"constructor parameters with multiple canonical API owners: {duplicate_owners}",
        )

    def test_each_authored_python_api_reference_has_a_valid_source_map(self) -> None:
        validator_path = REPOSITORY_ROOT / (
            ".agents/skills/scientific-documentation-contract/scripts/"
            "validate_scientific_docs.py"
        )
        spec = importlib.util.spec_from_file_location("validate_scientific_docs", validator_path)
        assert spec is not None and spec.loader is not None
        validator = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(validator)

        authored_pages = {
            *API_PARAMETER_OWNERS.values(),
            Path("python-api/materials/spatial-parameter-fields.md"),
            Path("python-api/problem/problem-ir.md"),
        }
        failures: dict[str, list[str]] = {}
        for relative_page in sorted(authored_pages):
            source_map = (PUBLIC_DOCS_ROOT / relative_page).with_suffix(".source-map.json")
            if not source_map.is_file():
                failures[str(relative_page)] = ["adjacent source map is missing"]
                continue
            manifest = json.loads(source_map.read_text(encoding="utf-8"))
            errors = validator.validate_page(REPOSITORY_ROOT, manifest)
            documented = {
                parameter["python"]
                for parameter in manifest.get("public_api", {}).get("parameters", [])
            }
            page_owners = [
                name for name, owner in API_PARAMETER_OWNERS.items() if owner == relative_page
            ]
            expected = {
                f"{name}.{parameter.name}"
                for name in page_owners
                for parameter in inspect.signature(API_CONSTRUCTORS[name]).parameters.values()
                if parameter.kind
                not in {inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD}
            }
            if documented != expected:
                errors.append(
                    f"source-map parameters differ from constructor signature: "
                    f"missing={sorted(expected - documented)}, extra={sorted(documented - expected)}"
                )
            if errors:
                failures[str(relative_page)] = errors
        self.assertEqual(failures, {})

    def test_documentation_workflow_guards_python_api_contracts(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")
        self.assertGreaterEqual(workflow.count('"packages/fullmag-py/**"'), 2)
        self.assertIn("test_public_python_api_documentation.py", workflow)
        self.assertIn("public_docs/site/python-api", workflow)


if __name__ == "__main__":
    unittest.main()
