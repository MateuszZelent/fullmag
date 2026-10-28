from pathlib import Path
import ast
import re
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[1]
CONF = ROOT / "public_docs/site/conf.py"
STATIC_DIR = ROOT / "public_docs/site/_static"
CSS = STATIC_DIR / "fullmag-docs.css"


class ResponsivePublicDocumentationTableTests(unittest.TestCase):
    @staticmethod
    def _rules_for_selector(css: str, selector: str) -> list[str]:
        uncommented = re.sub(r"/\*.*?\*/", "", css, flags=re.DOTALL)
        return [
            declarations
            for selector_list, declarations in re.findall(r"([^{}]+)\{([^{}]*)\}", uncommented)
            if selector in {item.strip() for item in selector_list.split(",")}
        ]

    @staticmethod
    def _conf_list(conf: str, variable_name: str) -> list[str]:
        tree = ast.parse(conf)
        for node in tree.body:
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name) and target.id == variable_name:
                        value = ast.literal_eval(node.value)
                        if isinstance(value, list):
                            return [str(item) for item in value]
        raise AssertionError(f"{variable_name} not found in conf.py")

    def test_sphinx_registers_fullmag_documentation_css(self) -> None:
        conf = CONF.read_text(encoding="utf-8")
        css_files = self._conf_list(conf, "html_css_files")
        js_files = self._conf_list(conf, "html_js_files")
        self.assertIn("fullmag-docs.css", css_files)
        self.assertIn("fullmag-embed.css", css_files)
        self.assertIn("fullmag-embed.js", js_files)
        self.assertIn('"responsive_tables"', conf)

        for asset_name in [*css_files, *js_files]:
            asset_path = STATIC_DIR / asset_name
            self.assertTrue(
                asset_path.is_file(),
                f"Registered Sphinx static asset does not exist: {asset_path}",
            )
            check_ignore = subprocess.run(
                ["git", "-C", str(ROOT), "check-ignore", "-q", str(asset_path.relative_to(ROOT))],
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(
                check_ignore.returncode,
                0,
                f"Registered Sphinx static asset must not be git-ignored: {asset_path}",
            )

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

    def test_clarity_article_main_has_a_constrained_fallback_scrollport(self) -> None:
        css = CSS.read_text(encoding="utf-8")
        main_rules = self._rules_for_selector(css, "article > main")
        section_rules = self._rules_for_selector(css, "article > main > section")

        self.assertTrue(
            any(
                re.search(r"box-sizing:\s*border-box", declarations)
                and re.search(r"width:\s*100%", declarations)
                and re.search(r"min-width:\s*0", declarations)
                and re.search(r"max-width:\s*100%", declarations)
                and re.search(r"overflow-x:\s*auto", declarations)
                for declarations in main_rules
            )
        )
        self.assertTrue(
            any(
                re.search(r"box-sizing:\s*border-box", declarations)
                and re.search(r"min-width:\s*0", declarations)
                and re.search(r"max-width:\s*100%", declarations)
                for declarations in section_rules
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

    def test_embedded_mode_collapses_duplicate_sphinx_header_and_search_modal(self) -> None:
        embed_css = (STATIC_DIR / "fullmag-embed.css").read_text(encoding="utf-8")
        root_rules = self._rules_for_selector(embed_css, "html[data-fullmag-embedded]")
        self.assertTrue(
            any(
                "--header-height: 0px !important" in declarations
                and "--announcement-height: 0px !important" in declarations
                for declarations in root_rules
            )
        )
        for selector in (
            "html[data-fullmag-embedded] #main-header",
            "html[data-fullmag-embedded] #searchModal",
        ):
            rules = self._rules_for_selector(embed_css, selector)
            self.assertTrue(
                any("display: none !important" in declarations for declarations in rules),
                selector,
            )

    def test_documentation_theme_tokens_align_with_fullmag_light_and_dark_palettes(self) -> None:
        css = CSS.read_text(encoding="utf-8")
        light_rules = self._rules_for_selector(css, 'html[data-theme="light"]')
        dark_rules = self._rules_for_selector(css, 'html[data-theme="dark"]')

        self.assertTrue(
            any(
                "--fm-docs-bg-app: #eff1f5" in declarations
                and "--fm-docs-bg-chrome: #e6e9ef" in declarations
                and "--fm-docs-text-primary: #4c4f69" in declarations
                and "--fm-docs-accent: #1e66f5" in declarations
                and "--color-base-100: var(--fm-docs-bg-app)" in declarations
                for declarations in light_rules
            )
        )
        self.assertTrue(
            any(
                "--fm-docs-bg-app: #1e1e2e" in declarations
                and "--fm-docs-bg-chrome: #181825" in declarations
                and "--fm-docs-text-primary: #cdd6f4" in declarations
                and "--fm-docs-accent: #89b4fa" in declarations
                and "--color-base-100: var(--fm-docs-bg-app)" in declarations
                for declarations in dark_rules
            )
        )


if __name__ == "__main__":
    unittest.main()
