from __future__ import annotations

import inspect
from pathlib import Path
import unittest

import fullmag as fm


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
PUBLIC_DOCS_ROOT = REPOSITORY_ROOT / "public_docs/site"

API_PARAMETER_OWNERS: dict[str, Path] = {
    "Material": Path("python-api/materials/material.md"),
    "Box": Path("python-api/geometry/primitives.md"),
    "Ferromagnet": Path("python-api/magnets-and-textures/ferromagnet.md"),
    "texture.uniform": Path("python-api/magnets-and-textures/uniform-texture.md"),
    "TimeEvolution": Path("python-api/studies/time-evolution.md"),
    "LLG": Path("python-api/dynamics/llg.md"),
    "SaveField": Path("python-api/outputs/fields-and-scalars.md"),
    "SaveScalar": Path("python-api/outputs/fields-and-scalars.md"),
    "Problem": Path("python-api/problem/problem.md"),
    "DiscretizationHints": Path("python-api/discretization/discretization-hints.md"),
    "FDM": Path("python-api/discretization/fdm.md"),
    "FEM": Path("python-api/discretization/fem.md"),
}

API_CONSTRUCTORS = {
    "Material": fm.Material,
    "Box": fm.Box,
    "Ferromagnet": fm.Ferromagnet,
    "texture.uniform": fm.texture.uniform,
    "TimeEvolution": fm.TimeEvolution,
    "LLG": fm.LLG,
    "SaveField": fm.SaveField,
    "SaveScalar": fm.SaveScalar,
    "Problem": fm.Problem,
    "DiscretizationHints": fm.DiscretizationHints,
    "FDM": fm.FDM,
    "FEM": fm.FEM,
}


class PublicPythonApiDocumentationTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
