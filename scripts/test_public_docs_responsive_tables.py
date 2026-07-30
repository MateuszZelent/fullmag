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
        self.assertIn(
            'html_css_files = ["fullmag-docs.css"]',
            CONF.read_text(encoding="utf-8"),
        )

    def test_tables_own_horizontal_overflow_without_hiding_the_page(self) -> None:
        css = CSS.read_text(encoding="utf-8")
        self.assertRegex(css, r"\.table-wrapper[^\{]*\{[^}]*overflow-x:\s*auto")
        self.assertRegex(css, r"th\s*,\s*[^\{]*td[^\{]*\{[^}]*white-space:\s*normal")
        self.assertIn("overflow-wrap: anywhere", css)
        self.assertNotRegex(css, r"(?:html|body)[^\{]*\{[^}]*overflow-x:\s*hidden")

    def test_unwrapped_direct_table_keeps_a_constrained_scrollport(self) -> None:
        css = CSS.read_text(encoding="utf-8")
        direct_table_rules = self._rules_for_selector(css, "article > main table")

        self.assertTrue(
            any(
                re.search(r"display:\s*block", declarations)
                and re.search(r"width:\s*100%", declarations)
                and re.search(r"max-width:\s*100%", declarations)
                and re.search(r"overflow-x:\s*auto", declarations)
                for declarations in direct_table_rules
            )
        )
        self.assertFalse(
            any(
                re.search(r"width:\s*max-content", declarations)
                or re.search(r"max-width:\s*none", declarations)
                for declarations in direct_table_rules
            )
        )

    def test_long_content_uses_local_horizontal_scrollports(self) -> None:
        css = CSS.read_text(encoding="utf-8")

        for selector in ("article > main div.math", "article > main pre"):
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
