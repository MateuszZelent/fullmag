from __future__ import annotations

import contextlib
import io
import json
from pathlib import Path
import re
import unittest

import fullmag as fm


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
EXCHANGE_PAGE = (
    REPOSITORY_ROOT
    / "public_docs/site/physics/interactions/exchange/index.md"
)
PYTHON_BLOCK = re.compile(r"```python\s*\n(.*?)```", re.DOTALL)
JSON_BLOCK = re.compile(r"```json\s*\n(.*?)```", re.DOTALL)


def assert_json_subset(
    testcase: unittest.TestCase,
    expected: object,
    actual: object,
    path: str = "$",
) -> None:
    if isinstance(expected, dict):
        testcase.assertIsInstance(actual, dict, path)
        for key, value in expected.items():
            testcase.assertIn(key, actual, path)
            assert_json_subset(testcase, value, actual[key], f"{path}.{key}")
        return
    if isinstance(expected, list):
        testcase.assertIsInstance(actual, list, path)
        testcase.assertEqual(len(actual), len(expected), path)
        for index, value in enumerate(expected):
            assert_json_subset(testcase, value, actual[index], f"{path}[{index}]")
        return
    testcase.assertEqual(actual, expected, path)


class PublicExchangeDocumentationTests(unittest.TestCase):
    def test_stage_workflow_and_exchange_fragment_are_current(self) -> None:
        page = EXCHANGE_PAGE.read_text(encoding="utf-8")
        blocks = PYTHON_BLOCK.findall(page)
        self.assertTrue(blocks, "Exchange page must contain a Python example")
        self.assertNotIn("fm.Problem(", page)

        stage_source = next(
            (
                block
                for block in blocks
                if "study = fm.study(" in block
                and "study.stages.add_relax" in block
                and "study.stages.add_run" in block
            ),
            None,
        )
        self.assertIsNotNone(
            stage_source,
            "Exchange page must contain a complete stage-first workflow",
        )
        self.assertIn("# %%", stage_source)

        namespace: dict[str, object] = {}
        with contextlib.redirect_stdout(io.StringIO()):
            exec(compile(stage_source, str(EXCHANGE_PAGE), "exec"), namespace)
        self.assertIn("study", namespace)

        source = next(
            (block for block in blocks if "exchange = fm.Exchange()" in block),
            None,
        )
        self.assertIsNotNone(
            source,
            "Exchange page must contain an object-level interaction fragment",
        )
        with contextlib.redirect_stdout(io.StringIO()):
            exec(compile(source, str(EXCHANGE_PAGE), "exec"), namespace)

        exchange = namespace["exchange"]
        material_object = namespace["material"]
        self.assertEqual(exchange.to_ir(), {"kind": "exchange"})
        material = material_object.to_ir()
        self.assertEqual(material["exchange_stiffness"], 13.0e-12)
        self.assertEqual(material["saturation_magnetisation"], 800.0e3)
        self.assertEqual(material["damping"], 0.01)

        documented_ir = json.loads(JSON_BLOCK.search(page).group(1))
        assert_json_subset(
            self,
            {
                "materials": [
                    {
                        "exchange_stiffness": 13.0e-12,
                        "saturation_magnetisation": 800.0e3,
                        "damping": 0.01,
                    }
                ],
                "energy_terms": [{"kind": "exchange"}],
            },
            documented_ir,
        )

    def test_exchange_page_contains_only_exchange_facing_api(self) -> None:
        page = EXCHANGE_PAGE.read_text(encoding="utf-8")
        for forbidden in (
            "Geometry, magnet, study, and output parameters used above",
            "Discretization parameters used above",
            "`Material.Ku1`",
            "`Problem.elastic_materials`",
            "`LLG.integrator`",
        ):
            self.assertNotIn(forbidden, page)

        for required in (
            "`Material.A`",
            "`Material.A_field`",
            "`Material.Ms`",
            "`Material.Ms_field`",
            "`H_ex`",
            "`E_ex`",
            "`FDM.boundary_correction`",
            "`FDM.boundary_phi_floor`",
            "`FDM.boundary_delta_min`",
        ):
            self.assertIn(required, page)


if __name__ == "__main__":
    unittest.main()
