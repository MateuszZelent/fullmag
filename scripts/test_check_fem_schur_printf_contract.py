"""Regression checks for source-level variadic diagnostic safety."""
import unittest

from check_fem_schur_printf_contract import SOURCE, check_source, expected_arity


class SchurPrintfContractTests(unittest.TestCase):
    def test_production_diagnostics_have_matching_arguments(self):
        self.assertGreaterEqual(check_source(SOURCE.read_text(encoding="utf-8")), 26)

    def test_missing_ncv_argument_in_actual_window_certificate_is_rejected(self):
        source = SOURCE.read_text(encoding="utf-8")
        argument = "static_cast<unsigned long long>(resolved_ncv(requested_nev)),"
        self.assertEqual(source.count(argument), 3)
        broken = source.replace(argument, "", 1)
        with self.assertRaisesRegex(ValueError, "printf expects"):
            check_source(broken)

    def test_nested_calls_literals_and_comments_do_not_split_arguments(self):
        source = 'std::snprintf(buffer, size, "%llu %s %%", convert(pair(1, 2)), "a,b");'
        self.assertEqual(check_source(source), 1)

    def test_width_precision_and_escaped_percent(self):
        self.assertEqual(expected_arity("%*.*g %% %zu"), 4)

    def test_missing_literal_contract_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "No literal diagnostic calls"):
            check_source("void f() {}")


if __name__ == "__main__":
    unittest.main()
