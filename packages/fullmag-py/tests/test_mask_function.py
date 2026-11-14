"""Hand-written mask and time functions are transpiled to field_expr.v1."""

from __future__ import annotations

import math
import textwrap
import unittest
from math import exp, log, pi, sin, sqrt

import fullmag as fm
from fullmag import GHz, mT, nm
from fullmag.model.mask_function import register_script_source

B_GLOBAL = 2.5e-4


def antenna_mask(x, y, z, B01, wavelength, fwhm_y, xs):
    k = 2 * pi / wavelength
    sigma_y = fwhm_y / (2 * sqrt(2 * log(2)))
    g = exp(-(x + xs)**2 / (2 * wavelength**2)) * exp(-y**2 / (2 * sigma_y**2))
    return (B01 * g * sin(k * x - pi / 2), 0.0, B01 * g * sin(k * x))


def antenna_time(t, frequency, t0):
    return sin(2 * pi * frequency * (t - t0))


def with_default(x, y, z, a=2.5e-4):
    return (a, 0, 0)


def uses_global_and_math(x, y, z):
    return (B_GLOBAL * math.fabs(x), 1_000 * y, math.pi * z)


def module_with_closure(wavelength, B0):
    k = 2 * pi / wavelength

    def inner(x, y, z):
        return (B0 * sin(k * x), 0, 0)

    return fm.mask(inner)


def evaluate(ir: dict, **variables: float) -> tuple[float, ...]:
    """Evaluate transpiled equations with Python's math (an independent check)."""
    scope: dict[str, object] = {
        name: getattr(math, name)
        for name in (
            "sin", "cos", "tan", "asin", "acos", "atan", "atan2",
            "sinh", "cosh", "tanh", "exp", "log", "sqrt",
        )
    }
    scope.update(abs=abs, min=min, max=max, pi=math.pi)
    scope.update({item["name"]: item["value"] for item in ir.get("parameters", [])})
    scope.update(variables)
    for local in ir.get("locals", []):
        scope[local["name"]] = eval(local["expression"].replace("^", "**"), {"__builtins__": {}}, scope)
    return tuple(
        eval(output.replace("^", "**"), {"__builtins__": {}}, scope) for output in ir["outputs"]
    )


def compile_source(source: str, name: str = "f", **namespace: object):
    filename = f"<test-mask-function-{abs(hash(source))}>"
    source = textwrap.dedent(source)
    register_script_source(filename, source)
    scope: dict[str, object] = dict(namespace)
    exec(compile(source, filename, "exec"), scope)
    return scope[name]


class MaskFunctionTests(unittest.TestCase):
    def test_antenna_mask_transpiles(self) -> None:
        field = fm.mask(
            antenna_mask, B01=0.2 * mT, wavelength=279 * nm, fwhm_y=240 * nm, xs=6000 * nm / 2.3
        )
        ir = field.to_ir()
        self.assertEqual(ir["expression_version"], "field_expr.v1")
        self.assertEqual(
            [(item["name"], item["value"]) for item in ir["parameters"]],
            [
                ("B01", 0.2 * mT),
                ("wavelength", 279 * nm),
                ("fwhm_y", 240 * nm),
                ("xs", 6000 * nm / 2.3),
            ],
        )
        self.assertNotIn("source", ir["parameters"][0])
        self.assertEqual([item["name"] for item in ir["locals"]], ["k", "sigma_y", "g"])
        self.assertEqual(
            ir["locals"][2]["expression"],
            "exp(-(x + xs)^2 / (2 * wavelength^2)) * exp(-y^2 / (2 * sigma_y^2))",
        )
        self.assertEqual(
            ir["outputs"],
            ["B01 * g * sin(k * x - pi / 2)", "0.0", "B01 * g * sin(k * x)"],
        )

    def test_antenna_time_transpiles(self) -> None:
        ir = fm.time(antenna_time, frequency=3.6 * GHz, t0=0.0).to_ir()
        self.assertEqual(
            ir,
            {
                "expression_version": "field_expr.v1",
                "parameters": [
                    {"name": "frequency", "value": 3.6e9},
                    {"name": "t0", "value": 0.0},
                ],
                "outputs": ["sin(2 * pi * frequency * (t - t0))"],
            },
        )

    def test_missing_value_is_an_error(self) -> None:
        with self.assertRaisesRegex(fm.MaskFunctionError, "parameter 'wavelength': no value"):
            fm.mask(antenna_mask, B01=1e-3, fwhm_y=1e-7, xs=0.0)

    def test_unknown_value_is_an_error(self) -> None:
        with self.assertRaisesRegex(fm.MaskFunctionError, "parameter 'foo'"):
            fm.time(antenna_time, frequency=1e9, t0=0.0, foo=1.0)

    def test_value_must_be_a_finite_real_number(self) -> None:
        for value in (float("nan"), True, "1"):
            with self.assertRaises(fm.MaskFunctionError):
                fm.time(antenna_time, frequency=value, t0=0.0)

    def test_default_in_def_is_used_when_no_value_given(self) -> None:
        ir = fm.mask(with_default).to_ir()
        self.assertEqual(ir["parameters"], [{"name": "a", "value": 2.5e-4, "source": "2.5e-4"}])

    def test_value_overrides_default(self) -> None:
        ir = fm.mask(with_default, a=1e-3).to_ir()
        self.assertEqual(ir["parameters"], [{"name": "a", "value": 1e-3}])

    def test_globals_closures_and_math_prefix(self) -> None:
        ir = fm.mask(uses_global_and_math).to_ir()
        self.assertEqual(ir["parameters"], [{"name": "B_GLOBAL", "value": 2.5e-4}])
        self.assertEqual(ir["outputs"], ["B_GLOBAL * abs(x)", "1000 * y", "pi * z"])
        ir = module_with_closure(196e-9, 1e-3).to_ir()
        self.assertEqual(
            sorted(item["name"] for item in ir["parameters"]), ["B0", "k"]
        )
        self.assertAlmostEqual(
            {item["name"]: item["value"] for item in ir["parameters"]}["k"],
            2 * math.pi / 196e-9,
        )

    def test_with_parameter_replaces_one_value(self) -> None:
        drive = fm.time(antenna_time, frequency=3.6e9, t0=0.0).with_parameter("frequency", 4e9)
        self.assertEqual(drive.to_ir()["parameters"][0], {"name": "frequency", "value": 4e9})

    def test_multiline_expressions_and_comments(self) -> None:
        f = compile_source(
            """
            def f(x, y, z, a):
                g = (a * x
                     + a ** 2)  # a comment
                return (g, -y ** 2, +z)
            """
        )
        ir = fm.mask(f, a=2.0).to_ir()
        self.assertEqual(ir["locals"][0]["expression"], "a * x + a ^ 2")
        self.assertEqual(ir["outputs"], ["g", "-y ^ 2", "+z"])

    def test_rejections_name_the_line(self) -> None:
        cases = {
            "if": ("def f(x, y, z, a):\n    if a:\n        b = 1\n    return (a, 0, 0)\n", 2),
            "loop": ("def f(x, y, z):\n    for i in range(3):\n        pass\n    return (x, 0, 0)\n", 2),
            "numpy": ("def f(x, y, z):\n    return (np.sin(x), 0, 0)\n", 2),
            "helper": ("def f(x, y, z):\n    return (g(x), 0, 0)\n", 2),
            "used_before": ("def f(x, y, z):\n    a = b + 1\n    b = 2\n    return (a, 0, 0)\n", 2),
            "time_in_mask": ("def f(x, y, z):\n    return (t, 0, 0)\n", 2),
            "pair": ("def f(x, y, z):\n    return (x, 0)\n", 2),
            "compare": ("def f(x, y, z):\n    return (x > 0, 0, 0)\n", 2),
            "augmented_modulo": ("def f(x, y, z):\n    a = x\n    a %= 2\n    return (a, 0, 0)\n", 3),
            "augmented_unbound": ("def f(x, y, z):\n    a += 1\n    return (a, 0, 0)\n", 2),
            "augmented_global": ("def f(x, y, z):\n    b += 1\n    return (b, 0, 0)\n", 2),
            "reserved_function": ("def f(x, y, z):\n    sin = x\n    return (sin, 0, 0)\n", 2),
            "other_variable": ("def f(x, y, z):\n    t = x\n    return (t, 0, 0)\n", 2),
            "tuple_target": ("def f(x, y, z):\n    a, b = x, y\n    return (a, b, 0)\n", 2),
            "wrong_leading": ("def f(a, y, z):\n    return (a, 0, 0)\n", 1),
            "string": ("def f(x, y, z):\n    return ('x', 0, 0)\n", 2),
            "modulo": ("def f(x, y, z):\n    return (x % 2, 0, 0)\n", 2),
        }
        for name, (source, line) in cases.items():
            with self.subTest(name):
                f = compile_source(source, np=None, b=5.0, g=abs, t=3.0)
                with self.assertRaisesRegex(fm.MaskFunctionError, f"^line {line}:"):
                    fm.mask(f)

    def test_reassignment_gets_new_versions(self) -> None:
        f = compile_source(
            """
            def f(x, y, z, a, g_2):
                g = a * x
                g = g * 2
                g *= g_2
                x = x - a
                return (g, x, a)
            """
        )
        ir = fm.mask(f, a=2.0, g_2=3.0).to_ir()
        self.assertEqual(
            [(local["name"], local["expression"]) for local in ir["locals"]],
            [("g", "a * x"), ("g_3", "g * 2"), ("g_4", "g_3 * (g_2)"), ("x_2", "x - a")],
        )
        self.assertEqual(ir["outputs"], ["g_4", "x_2", "a"])

    def test_reassigned_functions_match_python(self) -> None:
        def mateusz_style(x, y, z, B01, wavelength, fwhm_y, xs):
            k = 2 * pi / wavelength
            sigma_y = fwhm_y / (2 * sqrt(2 * log(2)))
            g = exp(-(x + xs) ** 2 / (2 * wavelength**2))
            g = g * exp(-y**2 / (2 * sigma_y**2))
            g *= B01
            return (g * sin(k * x - pi / 2), 0.0, g * sin(k * x))

        def chirp(t, frequency, t0):
            t = t - t0
            phase = 2 * pi * frequency * t
            phase += 0.5 * frequency * t
            return sin(phase)

        values = dict(B01=0.2 * mT, wavelength=279 * nm, fwhm_y=240 * nm, xs=6000 * nm / 2.3)
        mask_ir = fm.mask(mateusz_style, **values).to_ir()
        for point in ((-2.6e-6, 1e-7, 0.0), (-2.4e-6, -3e-8, 5e-9), (0.0, 0.0, 0.0)):
            expected = mateusz_style(*point, **values)
            got = evaluate(mask_ir, x=point[0], y=point[1], z=point[2])
            for a, b in zip(got, expected):
                self.assertAlmostEqual(a, b, delta=1e-12 * max(1.0, abs(b)))
        time_ir = fm.time(chirp, frequency=3.6 * GHz, t0=0.1e-9).to_ir()
        for t in (0.0, 0.37e-9, 2e-9):
            self.assertAlmostEqual(evaluate(time_ir, t=t)[0], chirp(t, 3.6 * GHz, 0.1e-9), delta=1e-12)

    def test_time_function_rules(self) -> None:
        f = compile_source("def f(t):\n    return sin(x)\n", sin=math.sin, x=1.0)
        with self.assertRaisesRegex(fm.MaskFunctionError, "'x' cannot be used in a time function"):
            fm.time(f)
        f = compile_source("def f(t):\n    return (t, t)\n")
        with self.assertRaisesRegex(fm.MaskFunctionError, "must return one number"):
            fm.time(f)

    def test_lambda_is_rejected(self) -> None:
        with self.assertRaisesRegex(fm.MaskFunctionError, "lambda"):
            fm.mask(lambda x, y, z: (x, y, z))


if __name__ == "__main__":
    unittest.main()
