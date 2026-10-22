"""Reference-only RT0 reconstruction checks; no native solve or H qualification."""
from copy import deepcopy
from decimal import Decimal, localcontext
import unittest

from antenna_rt0_surface_oracle import fit_retained_rt0


VERTICES = ((0., 0., 0.), (2., 0., 0.), (.5, 1., 0.), (.25, .5, 1.5))


def currents(vertices=VERTICES, scale=1.):
    return tuple(tuple(scale * (a + .75 * x) for a, x in zip((3., -2., 5.), p))
                 for p in vertices)


class RetainedRT0FitTests(unittest.TestCase):
    def test_scalar_slope_and_centered_intercept(self):
        fits = fit_retained_rt0(VERTICES, currents())
        for kind, fit in fits.items():
            with self.subTest(kind=kind), localcontext() as context:
                context.prec = 120
                expected = tuple(Decimal.from_float(a) + Decimal('.75') * c
                                 for a, c in zip((3., -2., 5.), fit['center_m'])) if kind == 'decimal120' else tuple(a + .75 * c for a, c in zip((3., -2., 5.), fit['center_m']))
                error = max(abs(a - b) for a, b in zip(fit['alpha_apm2'], expected))
                tolerance = Decimal('1e-105') if kind == 'decimal120' else 1e-13
                self.assertLessEqual(error, tolerance)
                self.assertLessEqual(abs(fit['beta_apm2'] / fit['length_m'] - (Decimal('.75') if kind == 'decimal120' else .75)), tolerance)
                self.assertLessEqual(fit['maximum_residual_apm2'], fit['residual_limit_apm2'])
        self.assertEqual(set(fits), {'binary64', 'decimal120'})

    def test_zero_field_has_exact_zero_coefficients_and_residual(self):
        for fit in fit_retained_rt0(VERTICES, ((0., 0., 0.),) * 4).values():
            self.assertEqual(fit['alpha_apm2'], (0, 0, 0))
            self.assertEqual(fit['beta_apm2'], 0)
            self.assertEqual(fit['maximum_residual_apm2'], 0)
            self.assertEqual(fit['residual_limit_apm2'], 0)

    def test_constant_current_is_not_a_magnetic_state(self):
        for fit in fit_retained_rt0(VERTICES, ((2., -4., 8.),) * 4).values():
            self.assertLessEqual(max(abs(a-b) for a, b in zip(fit['alpha_apm2'], (2, -4, 8))), 1e-13)
            self.assertLessEqual(abs(fit['beta_apm2']), 1e-13)

    def test_full_affine_non_rt0_gradients_are_rejected(self):
        for gradient in (((1, 0, 0), (0, 2, 0), (0, 0, 3)),
                         ((0, 1, 0), (0, 0, 0), (0, 0, 0)),
                         ((0, -1, 0), (1, 0, 0), (0, 0, 0))):
            with self.subTest(gradient=gradient):
                field = tuple(tuple(sum(a*x for a, x in zip(row, p)) for row in gradient) for p in VERTICES)
                with self.assertRaisesRegex(ValueError, 'RT0 residual'):
                    fit_retained_rt0(VERTICES, field)

    def test_geometry_scaling_and_exact_translation_preserve_centered_current(self):
        base = fit_retained_rt0(VERTICES, currents())
        for length in (2.**-20, 1., 2.**20):
            shifted = tuple(tuple(length*x+t for x, t in zip(p, (3., -2., 1.))) for p in VERTICES)
            for kind, fit in fit_retained_rt0(shifted, currents()).items():
                with self.subTest(length=length, kind=kind), localcontext() as context:
                    context.prec = 120
                    scale = Decimal.from_float(length) if kind == 'decimal120' else length
                    tolerance = Decimal('1e-104') if kind == 'decimal120' else 1e-12
                    self.assertLessEqual(max(abs(a-b) for a, b in zip(fit['alpha_apm2'], base[kind]['alpha_apm2'])), tolerance)
                    self.assertLessEqual(abs(fit['beta_apm2'] - base[kind]['beta_apm2']), tolerance)
                    self.assertLessEqual(abs(fit['length_m']/scale-base[kind]['length_m']), tolerance)

    def test_current_scaling_has_no_absolute_acceptance_floor(self):
        for scale in (2.**-600, 1., 2.**600):
            with self.subTest(scale=scale):
                data = currents(scale=scale)
                fits = fit_retained_rt0(VERTICES, data)
                self.assertGreater(fits['binary64']['residual_limit_apm2'], 0)
                bad = [list(p) for p in data]
                bad[0][1] += scale * .01
                with self.assertRaisesRegex(ValueError, 'RT0 residual'):
                    fit_retained_rt0(VERTICES, bad)

    def test_positive_even_permutation_preserves_fit(self):
        data = currents()
        a = fit_retained_rt0(VERTICES, data)
        order = (1, 2, 0, 3)
        b = fit_retained_rt0(tuple(VERTICES[i] for i in order), tuple(data[i] for i in order))
        for kind in a:
            self.assertLessEqual(max(abs(x-y) for x, y in zip(a[kind]['alpha_apm2'], b[kind]['alpha_apm2'])), 1e-13)
            self.assertLessEqual(abs(a[kind]['beta_apm2']-b[kind]['beta_apm2']), 1e-13)

    def test_degenerate_and_reversed_tetrahedra_are_refused(self):
        for vertices in (((0., 0., 0.), (1., 0., 0.), (0., 1., 0.), (1., 1., 0.)),
                         (VERTICES[0], VERTICES[0], VERTICES[2], VERTICES[3]),
                         (VERTICES[1], VERTICES[0], VERTICES[2], VERTICES[3])):
            with self.subTest(vertices=vertices), self.assertRaisesRegex(ValueError, 'positive tetrahedron'):
                fit_retained_rt0(vertices, currents())

    def test_nonfinite_bool_and_wrong_shape_are_refused(self):
        for bad in (True, float('nan'), float('inf')):
            for change_vertices in (True, False):
                vertices, field = list(map(list, VERTICES)), list(map(list, currents()))
                (vertices if change_vertices else field)[0][0] = bad
                with self.subTest(bad=bad, vertices=change_vertices), self.assertRaises(ValueError):
                    fit_retained_rt0(vertices, field)
        for vertices, field in ((VERTICES[:3], currents()), (VERTICES, currents()[:3]),
                                (VERTICES, ((0., 0.),)*4)):
            with self.assertRaises(ValueError):
                fit_retained_rt0(vertices, field)

    def test_decimal120_is_independent_of_caller_rounding_traps_and_exponents(self):
        from decimal import Inexact, ROUND_FLOOR
        expected = fit_retained_rt0(VERTICES, currents())
        with localcontext() as context:
            context.prec = 17
            context.rounding = ROUND_FLOOR
            context.Emax, context.Emin = 2, -2
            context.traps[Inexact] = True
            before = repr(context)
            actual = fit_retained_rt0(VERTICES, currents())
            self.assertEqual(actual, expected)
            self.assertEqual(repr(context), before)

    def test_inputs_and_decimal_context_are_preserved(self):
        vertices, data = list(map(list, VERTICES)), list(map(list, currents()))
        before = deepcopy((vertices, data))
        with localcontext() as context:
            context.prec = 19
            fit_retained_rt0(vertices, data)
            self.assertEqual(context.prec, 19)
        self.assertEqual((vertices, data), before)

    def test_exact_binary64_conversion_is_not_decimal_text_rounding(self):
        vertices = ((.1, 0., 0.), (2., 0., 0.), (.5, 1., 0.), (.25, .5, 1.5))
        fit = fit_retained_rt0(vertices, ((1., 2., 3.),)*4)['decimal120']
        with localcontext() as context:
            context.prec = 120
            expected = sum(Decimal.from_float(p[0]) for p in vertices)/4
            rounded = sum(Decimal(str(p[0])) for p in vertices)/4
            self.assertEqual(fit['center_m'][0], expected)
            self.assertNotEqual(expected, rounded)


if __name__ == '__main__':
    unittest.main()
