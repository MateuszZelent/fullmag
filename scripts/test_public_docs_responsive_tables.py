from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
CONF = ROOT / "public_docs/site/conf.py"
CSS = ROOT / "public_docs/site/_static/fullmag-docs.css"


class ResponsivePublicDocumentationTableTests(unittest.TestCase):
    @staticmethod
    def _rules_for_selector(css: str, selector: str) -> list[str]:
        return [
            declarations
            for selector_list, declarations in re.findall(r"([^{}]+)\{([^{}]*)\}", css)
            if selector in {item.strip() for item in selector_list.split(",")}
        ]

    def test_sphinx_registers_fullmag_documentation_css(self) -> None:
        conf = CONF.read_text(encoding="utf-8")
        self.assertIn('html_css_files = ["fullmag-docs.css"]', conf)
        self.assertIn('"responsive_tables"', conf)

    def test_tables_own_horizontal_overflow_without_hiding_the_page(self) -> None:
        css = CSS.read_text(encoding="utf-8")
        self.assertRegex(css, r"main article \.table-wrapper[^\{]*\{[^}]*overflow-x:\s*auto")
        self.assertRegex(css, r"th\s*,\s*[^\{]*td[^\{]*\{[^}]*white-space:\s*normal")
        self.assertIn("overflow-wrap: anywhere", css)
        self.assertNotRegex(css, r"(?:html|body)[^\{]*\{[^}]*overflow-x:\s*hidden")

    def test_table_rules_match_the_clarity_theme_dom(self) -> None:
        css = CSS.read_text(encoding="utf-8")
        self.assertIn("main article .table-wrapper", css)
        self.assertNotIn("article main", css)

    def test_cells_do_not_force_intrinsic_table_width(self) -> None:
        css = CSS.read_text(encoding="utf-8")
        cell_rules = []
        for selector in (
            "main article .table-wrapper th",
            "main article .table-wrapper td",
            "main article table th",
            "main article table td",
        ):
            cell_rules.extend(self._rules_for_selector(css, selector))

        self.assertTrue(
            any(re.search(r"min-width:\s*0", declarations) for declarations in cell_rules)
        )
        self.assertNotIn("min-width: 8rem", css)

    def test_clarity_nested_main_content_is_constrained(self) -> None:
        css = CSS.read_text(encoding="utf-8")
        rules = self._rules_for_selector(css, "main article")

        self.assertTrue(
            any(
                re.search(r"min-width:\s*0", declarations)
                and re.search(r"max-width:\s*100%", declarations)
                for declarations in rules
            )
        )

    def test_wrapped_table_keeps_a_constrained_scrollport(self) -> None:
        css = CSS.read_text(encoding="utf-8")
        wrapper_rules = self._rules_for_selector(css, "main article .table-wrapper")
        table_rules = self._rules_for_selector(css, "main article .table-wrapper table")

        self.assertTrue(
            any(
                re.search(r"display:\s*block", declarations)
                and re.search(r"width:\s*100%", declarations)
                and re.search(r"min-width:\s*0", declarations)
                and re.search(r"max-width:\s*100%", declarations)
                and re.search(r"overflow-x:\s*auto", declarations)
                and re.search(r"overflow-y:\s*hidden", declarations)
                and re.search(r"contain:\s*inline-size", declarations)
                for declarations in wrapper_rules
            )
        )
        self.assertTrue(
            any(
                re.search(r"width:\s*max-content", declarations)
                or re.search(r"max-width:\s*none", declarations)
                for declarations in table_rules
            )
        )

    def test_theme_grid_content_cannot_grow_from_wide_tables(self) -> None:
        css = CSS.read_text(encoding="utf-8")
        content_rules = self._rules_for_selector(css, ".drawer-content")
        descendant_rules = self._rules_for_selector(css, ".drawer-content > *")
        wrapper_rules = self._rules_for_selector(css, "main article .table-wrapper")

        for rules in (content_rules, descendant_rules):
            self.assertTrue(
                any(
                    re.search(r"box-sizing:\s*border-box", declarations)
                    and re.search(r"min-width:\s*0", declarations)
                    and re.search(r"max-width:\s*100%", declarations)
                    for declarations in rules
                )
            )

        self.assertTrue(
            any(
                re.search(r"box-sizing:\s*border-box", declarations)
                and re.search(r"overflow-x:\s*auto", declarations)
                for declarations in wrapper_rules
            )
        )

    def test_long_content_uses_local_horizontal_scrollports(self) -> None:
        css = CSS.read_text(encoding="utf-8")

        for selector in ("main article div.math", "main article pre"):
            rules = self._rules_for_selector(css, selector)
            self.assertTrue(
                any(
                    re.search(r"display:\s*block", declarations)
                    and re.search(r"max-width:\s*100%", declarations)
                    and re.search(r"overflow-x:\s*auto", declarations)
                    for declarations in rules
                ),
                selector,
            )

        header_rules = self._rules_for_selector(css, "#main-header")
        self.assertTrue(
            any(re.search(r"overflow-x:\s*clip", declarations) for declarations in header_rules)
        )


if __name__ == "__main__":
    unittest.main()
