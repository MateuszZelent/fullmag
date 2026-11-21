"""``field_expr.v1`` text is a Python expression: ``**`` is power, ``^`` its legacy spelling.

The case table is shared with the Rust tests of ``crates/fullmag-expr``
(``tests/power_operator_tests.rs``): here every expected value and canonical
text is checked against Python's own ``eval``, there against ``fullmag-expr``.
"""

from __future__ import annotations

import copy
import json
import math
import textwrap
import unittest
from pathlib import Path

import fullmag as fm
from fullmag.antennas import rebuild_terms_ir
from fullmag.model.mask_function import register_script_source
from fullmag.runtime.script_builder import (
    _canonical_function_ir,
    _library_call_runs,
    _render_mask_function_def,
)

CASES_PATH = (
    Path(__file__).resolve().parents[3]
    / "crates"
    / "fullmag-expr"
    / "tests"
    / "fixtures"
    / "power_operator_cases.json"
)
MATH = {name: getattr(math, name) for name in ("sin", "cos", "exp", "sqrt", "log")}


def _cases() -> list[dict[str, object]]:
    return json.loads(CASES_PATH.read_text(encoding="utf-8"))


def _eval(text: str, scope: dict[str, object]) -> float:
    return eval(text, {"__builtins__": {}}, scope)


def _time_function(case: dict[str, object]):
    """``def <name>(t, <parameters>)`` with the case's locals and output, as a user writes it."""
    parameters = [name for name, _ in case["parameters"]]
    lines = [f"def {case['name']}({', '.join(['t', *parameters])}):"]
    lines += [f"    {name} = {expression}" for name, expression in case["locals"]]
    lines.append(f"    return {case['output']}")
    source = "\n".join(lines) + "\n"
    filename = f"<field-expr-power-{case['name']}>"
    register_script_source(filename, source)
    scope: dict[str, object] = dict(MATH)
    exec(compile(source, filename, "exec"), scope)
    return scope[case["name"]]


def _legacy(function_ir: dict[str, object]) -> dict[str, object]:
    """The same function with every ``**`` written as ``^`` (IR stored before ``**``)."""
    legacy = copy.deepcopy(function_ir)
    for local in legacy.get("locals") or []:
        local["expression"] = local["expression"].replace("**", "^")
    legacy["outputs"] = [output.replace("**", "^") for output in legacy["outputs"]]
    return legacy


class SharedPowerCasesTests(unittest.TestCase):
    def test_table_is_python_semantics(self) -> None:
        cases = _cases()
        self.assertEqual(len(cases), 11)
        for case in cases:
            with self.subTest(case["name"]):
                for t, expected in case["samples"]:
                    scope: dict[str, object] = dict(MATH, t=t)
                    scope.update({name: value for name, value in case["parameters"]})
                    for name, expression in case["locals"]:
                        scope[name] = _eval(expression, scope)
                    self.assertEqual(_eval(case["output"], scope), expected)
                    # The canonical text of fullmag-expr folds parameters and locals.
                    self.assertEqual(_eval(case["canonical"], dict(MATH, t=t)), expected)

    def test_transpiler_keeps_double_star(self) -> None:
        for case in _cases():
            with self.subTest(case["name"]):
                ir = fm.time(_time_function(case), **dict(case["parameters"])).to_ir()
                self.assertEqual(ir["outputs"], [case["output"]])
                self.assertEqual(
                    [(local["name"], local["expression"]) for local in ir.get("locals", [])],
                    [tuple(local) for local in case["locals"]],
                )
                self.assertNotIn("^", json.dumps(ir))


class PowerSpellingTests(unittest.TestCase):
    def test_augmented_power_writes_double_star(self) -> None:
        source = textwrap.dedent(
            """
            def f(x, y, z, a):
                g = a * x
                g **= 2
                return (g, 0, 0)
            """
        )
        filename = "<field-expr-power-augmented>"
        register_script_source(filename, source)
        scope: dict[str, object] = {}
        exec(compile(source, filename, "exec"), scope)
        ir = fm.mask(scope["f"], a=2.0).to_ir()
        self.assertEqual(ir["locals"][1]["expression"], "g ** (2)")

    def test_exporter_reads_legacy_caret(self) -> None:
        function = {
            "expression_version": "field_expr.v1",
            "parameters": [{"name": "s", "value": 2e-7}],
            "locals": [{"name": "g", "expression": "exp(-x^2 / s^2)"}],
            "outputs": ["g * -y^-2", "0.0", "(-z)^2"],
        }
        lines = _render_mask_function_def("mask", "legacy", function)
        self.assertEqual(
            lines,
            [
                "def legacy(x, y, z, s):",
                "    g = exp(-x**2 / s**2)",
                "    return (g * -y**-2, 0.0, (-z)**2)",
            ],
        )
        # The rendered body is Python with the meaning of the legacy text.
        scope: dict[str, object] = dict(MATH)
        exec("\n".join(lines), scope)
        x, y, z, s = 1e-7, 3.0, -0.5, 2e-7
        g = math.exp(-(x**2) / s**2)
        self.assertEqual(scope["legacy"](x, y, z, s), (g * -(y**-2), 0.0, 0.25))

    def test_legacy_ready_antenna_terms_still_export_as_the_call(self) -> None:
        arguments = {
            "amplitude": 2e-4,
            "wavelength": 6e-8,
            "frequency": 3.6e9,
            "fwhm_y": 4e-8,
            "center_x": -1e-7,
        }
        terms = rebuild_terms_ir("fullmag.antennas.gaussian_k_source", arguments)
        legacy_terms = copy.deepcopy(terms)
        for term in legacy_terms:
            term["mask"]["function"] = _legacy(term["mask"]["function"])
        self.assertIn("^", json.dumps(legacy_terms))
        for new, old in zip(terms, legacy_terms):
            self.assertEqual(
                _canonical_function_ir(new["mask"]["function"]),
                _canonical_function_ir(old["mask"]["function"]),
            )
        self.assertEqual(
            _library_call_runs({"terms": legacy_terms}),
            _library_call_runs({"terms": terms}),
        )
        self.assertEqual(list(_library_call_runs({"terms": legacy_terms})), [0])


if __name__ == "__main__":
    unittest.main()
