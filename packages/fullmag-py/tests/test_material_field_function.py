"""``fm.fields.function``: a material parameter field as an equation of position.

Contract: docs/specs/material-assignment-and-spatial-fields-v0.md (``function``
kind) and docs/specs/mask-function-v1.md, section 9.
"""

from __future__ import annotations

import math
import tempfile
import unittest
from fractions import Fraction
from math import cos, exp, pi
from pathlib import Path

import fullmag as fm
from fullmag.model.field_function import FieldFunctionError, compile_field_function
from fullmag.runtime.scene_document import build_scene_document_from_builder
from fullmag.runtime.script_builder import (
    export_builder_draft,
    render_scene_document_as_script,
    rewrite_loaded_problem_script,
)

ALPHA_TEXT = "a0 + a_max*max(0.0, (x - x_edge)/L)**3"
ALPHA_VALUES = {"a0": 0.01, "a_max": 0.5, "x_edge": 2e-6, "L": 600e-9}
CAPTURED_SCALE = 1e-3


def alpha(x, y, z, a0, a_max, x_edge, L):
    return a0 + a_max * max(0.0, (x - x_edge) / L) ** 3


def alpha_with_locals(x, y, z, a0, a_max, x_edge, L=600e-9):
    """mumax3-style: locals, a reassigned variable, a default and a captured number."""
    x = x - x_edge
    s = max(0.0, x / L)
    s **= 3
    return a0 + a_max * s + CAPTURED_SCALE * cos(pi * y / L) * exp(-(z / L) ** 2)


SAMPLE_POINTS = [
    (x, y, z)
    for x in (-1e-6, 0.0, 2e-6, 2.1e-6, 2.45e-6, 2.6e-6, 3.0e-6)
    for y in (0.0, 1.5e-7)
    for z in (0.0, -2e-9)
]


class FieldFunctionAuthoringTests(unittest.TestCase):
    def test_string_form_lowers_to_function_ir_without_a_name(self):
        field = fm.fields.function(ALPHA_TEXT, **ALPHA_VALUES)
        self.assertIsInstance(field, fm.fields.MaterialParameterField)
        self.assertEqual(
            field.to_ir(),
            {
                "kind": "function",
                "function": {
                    "expression_version": "field_expr.v1",
                    "parameters": [
                        {"name": "a0", "value": 0.01},
                        {"name": "a_max", "value": 0.5},
                        {"name": "x_edge", "value": 2e-6},
                        {"name": "L", "value": 600e-9},
                    ],
                    "outputs": [ALPHA_TEXT],
                },
                "frame": "object",
            },
        )
        world = fm.fields.function(f"  {ALPHA_TEXT}\t", frame="WORLD", unit="1", **ALPHA_VALUES)
        self.assertEqual(world.to_ir()["frame"], "world")
        self.assertEqual(world.to_ir()["unit"], "1")
        self.assertEqual(world.to_ir()["function"]["outputs"], [ALPHA_TEXT])

    def test_def_form_lowers_to_function_ir_with_its_name(self):
        payload = fm.fields.function(alpha, **ALPHA_VALUES).to_ir()
        self.assertEqual(payload["kind"], "function")
        self.assertEqual(payload["function"]["name"], "alpha")
        self.assertEqual(
            [item["name"] for item in payload["function"]["parameters"]],
            ["a0", "a_max", "x_edge", "L"],
        )
        self.assertEqual(
            payload["function"]["outputs"], ["a0 + a_max * max(0.0, (x - x_edge) / L) ** 3"]
        )
        self.assertNotIn("locals", payload["function"])

    def test_def_form_keeps_locals_defaults_and_captured_numbers_as_values(self):
        function = fm.fields.function(alpha_with_locals, a0=0.01, a_max=0.5, x_edge=2e-6).to_ir()[
            "function"
        ]
        self.assertEqual(
            function["parameters"],
            [
                {"name": "a0", "value": 0.01},
                {"name": "a_max", "value": 0.5},
                {"name": "x_edge", "value": 2e-6},
                # A default stores its value only; its text is not kept.
                {"name": "L", "value": 600e-9},
                {"name": "CAPTURED_SCALE", "value": 1e-3},
            ],
        )
        self.assertEqual(
            [local["name"] for local in function["locals"]], ["x_2", "s", "s_2"]
        )

    def test_values_accept_real_numbers(self):
        payload = fm.fields.function("a + 0*x", a=Fraction(1, 4)).to_ir()
        self.assertEqual(payload["function"]["parameters"], [{"name": "a", "value": 0.25}])
        payload = fm.fields.function("a + 0*x", a=3).to_ir()
        self.assertEqual(payload["function"]["parameters"][0]["value"], 3.0)

    def test_no_parameters_and_heaviside_and_pi(self):
        payload = fm.fields.function("0.01 + 0.2*heaviside(x - 1e-6)*sin(pi*y/2e-7)**2").to_ir()
        self.assertNotIn("parameters", payload["function"])


class FieldFunctionValidationTests(unittest.TestCase):
    def assert_error(self, expected: str, *args, **kwargs) -> None:
        with self.assertRaises(FieldFunctionError) as context:
            fm.fields.function(*args, **kwargs)
        self.assertIsInstance(context.exception, ValueError)
        self.assertIn(expected, str(context.exception))

    def test_string_errors_name_the_character_or_parameter(self):
        self.assert_error("parameter 'L': the equation does not use it", "a0 + x", a0=1.0, L=2.0)
        self.assert_error(
            "character 5: name 'b' is not x, y, z, pi, a function or a parameter; pass its value as b=...",
            "a0 + b*x",
            a0=1.0,
        )
        self.assert_error("character 5: a field function may use only x, y, z, not 't'", "a0 + t", a0=1.0)
        self.assert_error("character 4: '^' is not allowed", "x**2^2")
        self.assert_error("character 0: function 'log1p' is not allowed", "log1p(x)")
        self.assert_error("character 0: function 'max' must be called", "max")
        self.assert_error("only ASCII", "x + µ")
        self.assert_error("one line", "x +\n 1")
        self.assert_error("the formula is empty", "   ")
        self.assert_error("character 4: '.' is not allowed", "math.sin(x)")
        self.assert_error("character 2: '>' is not allowed", "x > 0")
        self.assert_error("argument list cannot end with ','", "max(x, 0,)")

    def test_parameter_names_and_values_are_checked(self):
        self.assert_error("parameter 'max': the name is reserved", "x", max=1.0)
        self.assert_error("parameter 'y': the name is reserved", "x", y=1.0)
        self.assert_error("parameter 'heaviside': the name is reserved", "x", heaviside=1.0)
        self.assert_error("parameter 'lambda': a Python keyword", "x", **{"lambda": 1.0})
        self.assert_error("parameter 'a': value must be a real number", "a*x", a="1")
        self.assert_error("parameter 'a': value must be a real number", "a*x", a=True)
        self.assert_error("parameter 'a': value must be finite", "a*x", a=math.inf)
        self.assert_error("parameter 'a': value must be finite", "a*x", a=math.nan)

    def test_source_and_frame_are_checked(self):
        self.assert_error("takes an equation string or a def, not float", 1.0)
        with self.assertRaises(ValueError):
            fm.fields.function("x", frame="universe")

    def test_def_errors_carry_the_script_line(self):
        def wrong_variables(x, y, a):
            return a

        line = wrong_variables.__code__.co_firstlineno
        self.assert_error(f"line {line}: a field function must start with the parameters x, y, z", wrong_variables)

        def returns_tuple(x, y, z):
            return (x, y, z)

        self.assert_error("a field function must return one number", returns_tuple)

        def uses_time(x, y, z, t0):
            return x * t

        self.assert_error("'t' cannot be used in a field function", uses_time, t0=1.0)
        self.assert_error(
            "parameter 'L': no value; pass it as fm.fields.function(alpha, L=...)",
            alpha,
            a0=0.01,
            a_max=0.5,
            x_edge=2e-6,
        )
        self.assert_error("parameter 'q': alpha has no such parameter", alpha, q=1.0, **ALPHA_VALUES)
        self.assert_error("a lambda cannot be", lambda x, y, z: x)

        def keyword_parameter(x, y, z, unit=1.0):
            return unit * x

        self.assert_error("unit is a keyword of fm.fields.function", keyword_parameter)

    def test_vector_parameter_is_rejected(self):
        study = fm.study("vector-function-field")
        body = study.geometry(fm.Box(size=(10e-9, 10e-9, 2e-9)), name="body")
        with self.assertRaisesRegex(ValueError, "vector parameter"):
            body.set_material_field("AnisotropyAxis", fm.fields.function("1 + 0*x"))


class FieldFunctionEvaluationTests(unittest.TestCase):
    """The stored equation, evaluated by the formula checker/evaluator, equals
    the author's Python function evaluated with Python's math."""

    def test_string_and_def_forms_match_the_python_reference(self):
        for field in (
            fm.fields.function(ALPHA_TEXT, **ALPHA_VALUES),
            fm.fields.function(alpha, **ALPHA_VALUES),
        ):
            evaluate = compile_field_function(field.to_ir()["function"])
            for point in SAMPLE_POINTS:
                self.assertEqual(evaluate(*point), alpha(*point, **ALPHA_VALUES), point)

    def test_locals_and_captured_numbers_match_the_python_reference(self):
        values = {"a0": 0.01, "a_max": 0.5, "x_edge": 2e-6}
        evaluate = compile_field_function(
            fm.fields.function(alpha_with_locals, **values).to_ir()["function"]
        )
        for point in SAMPLE_POINTS:
            self.assertEqual(evaluate(*point), alpha_with_locals(*point, **values), point)

    def test_heaviside_and_ieee_results_follow_fullmag_expr(self):
        evaluate = compile_field_function(
            fm.fields.function("heaviside(x) + 1/y").to_ir()["function"]
        )
        self.assertEqual(evaluate(-1.0, 1.0, 0.0), 1.0)
        self.assertEqual(evaluate(0.0, 1.0, 0.0), 1.5)
        self.assertEqual(evaluate(2.0, 0.0, 0.0), math.inf)

    def test_compile_rejects_a_bad_stored_function(self):
        with self.assertRaises(FieldFunctionError):
            compile_field_function({"expression_version": "field_expr.v1", "outputs": ["x", "y"]})
        with self.assertRaises(FieldFunctionError):
            compile_field_function({"expression_version": "field_expr.v0", "outputs": ["x"]})
        with self.assertRaisesRegex(FieldFunctionError, "name 'q'"):
            compile_field_function({"expression_version": "field_expr.v1", "outputs": ["q*x"]})


SCRIPT = '''import fullmag as fm
from math import exp

study = fm.study("alpha-function")
study.engine("fdm").device("cpu").mode("strict")
study.cell(5e-9, 5e-9, 5e-9)
film = study.geometry(fm.Box(size=(200e-9, 50e-9, 5e-9)), name="film")
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.01
film.m = fm.texture.uniform(1.0, 0.0, 0.0)


def ramp(x, y, z, a0, a_max, x_edge, L):
    s = max(0.0, (x - x_edge) / L)
    return a0 + a_max * s ** 3 * exp(0.0 * y)


{alpha_line}
core = film.add_region("core", fm.Box(size=(50e-9, 50e-9, 5e-9)))
core.set_material("Aex", fm.fields.function("A0*(1 + 0.1*heaviside(x))", A0=13e-12, unit="J/m"))
film.set_material_field(
    "Ms",
    fm.fields.function("800e3 - 1e3*cos(pi*y/50e-9)", frame="world", unit="A/m"),
    region=core,
)
study.run(1e-12)
'''

ALPHA_LINES = {
    "string": 'film.alpha = fm.fields.function("a0 + a_max*max(0.0, (x - x_edge)/L)**3", '
    "a0=0.01, a_max=0.5, x_edge=50e-9, L=50e-9)",
    "def": "film.alpha = fm.fields.function(ramp, a0=0.01, a_max=0.5, x_edge=50e-9, L=50e-9)",
}


class FieldFunctionStudyTests(unittest.TestCase):
    def test_film_alpha_assignment_creates_one_object_field_and_replaces_it(self):
        study = fm.study("alpha-setter")
        film = study.geometry(fm.Box(size=(100e-9, 20e-9, 2e-9)), name="film")
        film.alpha = 0.02
        film.alpha = fm.fields.function("a + 0*x", a=0.1)
        film.alpha = fm.fields.function(ALPHA_TEXT, **ALPHA_VALUES)
        self.assertEqual(film.alpha.value, 0.02)
        assignments = film._material_parameter_assignments
        self.assertEqual(len(assignments), 1)
        self.assertEqual(assignments[0].assignment_id, "film:object:alpha")
        self.assertIsNone(assignments[0].region_id)
        self.assertEqual(
            assignments[0].to_ir()["value"]["function"]["outputs"], [ALPHA_TEXT]
        )
        # A number sets only the base value; the field stays.
        film.alpha = 0.03
        self.assertEqual(film.alpha.value, 0.03)
        self.assertEqual(len(film._material_parameter_assignments), 1)

    def test_invalid_alpha_replacement_preserves_the_previous_assignment(self):
        with fm.execution_context():
            study = fm.study("alpha-replacement")
            film = study.geometry(fm.Box(size=(100e-9, 20e-9, 2e-9)), name="film")
            film.alpha = fm.fields.function("0.02 + 0*x")
            before = [assignment.to_ir() for assignment in film._material_parameter_assignments]
            with self.assertRaisesRegex(ValueError, "Alpha unit"):
                film.alpha = fm.fields.function("0.1", unit="J/m")
            self.assertEqual(
                [assignment.to_ir() for assignment in film._material_parameter_assignments], before,
            )

    def test_scripts_round_trip_through_problem_and_scene_exports(self):
        for form, alpha_line in ALPHA_LINES.items():
            with tempfile.TemporaryDirectory() as directory, self.subTest(form=form):
                root = Path(directory)
                source = root / "source.py"
                source.write_text(SCRIPT.replace("{alpha_line}", alpha_line), encoding="utf-8")
                loaded = fm.load_problem_from_script(source, lightweight_assets=True)
                original = loaded.problem.to_ir(include_geometry_assets=False)
                fields = {
                    item["assignment_id"]: item["value"]
                    for item in original["material_parameter_fields"]
                }
                alpha_field = fields["film:object:alpha"]["function"]
                self.assertEqual("name" in alpha_field, form == "def")
                scene = build_scene_document_from_builder(export_builder_draft(loaded))
                exports = {
                    "problem": rewrite_loaded_problem_script(loaded)["rendered_source"],
                    "scene": render_scene_document_as_script(scene),
                }
                for path, rendered in exports.items():
                    with self.subTest(path=path):
                        if form == "string":
                            self.assertIn(
                                '.alpha = fm.fields.function("a0 + a_max*max(0.0, (x - x_edge)/L)**3", '
                                "a0=0.01, a_max=0.5, x_edge=5e-08, L=5e-08)",
                                rendered,
                            )
                            self.assertNotIn("def ramp", rendered)
                        else:
                            self.assertIn("from math import exp", rendered)
                            self.assertIn("def ramp(x, y, z, a0, a_max, x_edge, L):", rendered)
                            self.assertIn(".alpha = fm.fields.function(ramp, a0=0.01", rendered)
                        self.assertIn(
                            'fm.fields.function("A0*(1 + 0.1*heaviside(x))", A0=1.3e-11, unit="J/m")',
                            rendered,
                        )
                        target = root / f"exported_{path}.py"
                        target.write_text(rendered, encoding="utf-8")
                        reloaded = fm.load_problem_from_script(target, lightweight_assets=True)
                        actual = reloaded.problem.to_ir(include_geometry_assets=False)
                        self.assertEqual(
                            actual["material_parameter_fields"], original["material_parameter_fields"]
                        )
                        self.assertEqual(
                            [r["material_overrides"] for r in actual["object_regions"]],
                            [r["material_overrides"] for r in original["object_regions"]],
                        )


if __name__ == "__main__":
    unittest.main()
