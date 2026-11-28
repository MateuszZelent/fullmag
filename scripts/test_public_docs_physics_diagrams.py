"""Validate SVG physics diagrams, Light/Dark pairs, themed_diagrams extension, and MyST directives."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
import math
from pathlib import Path
import re
import sys
import tempfile
from types import SimpleNamespace
from typing import Iterator
import unittest
import xml.etree.ElementTree as ET

from docutils import nodes


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = ROOT / "scripts"
SITE_ROOT = ROOT / "public_docs" / "site"
PHYSICS_ROOT = SITE_ROOT / "physics"
DIAGRAMS_DIR = SITE_ROOT / "_static" / "diagrams"
EXTENSIONS_DIR = SITE_ROOT / "_extensions"
CSS_PATH = SITE_ROOT / "_static" / "fullmag-docs.css"
CONF_PATH = SITE_ROOT / "conf.py"

for _import_dir in (SCRIPTS_DIR, EXTENSIONS_DIR):
    if str(_import_dir) not in sys.path:
        sys.path.insert(0, str(_import_dir))

import themed_diagrams  # noqa: E402
from physics_diagrams.primitives import SvgCanvas  # noqa: E402
from physics_diagrams.theme import (  # noqa: E402
    STROKE_CONTRAST_TOKENS,
    TEXT_CONTRAST_TOKENS,
    THEMES,
    contrast_ratio,
)

EXCLUDED_DIRS = {"_build", "internal", "generated"}
EXCLUDED_FILENAMES = {"README.md", "PAGE_TEMPLATE.md"}

CODE_FENCE_OPEN_RE = re.compile(r"^\s*(?:(`{3,})(?!\{)[^`]*|(~{3,})(?!\{).*)$")
ANY_DIRECTIVE_OPEN_RE = re.compile(r"^(\s*)(`{3,}|~{3,}|:{3,})\{([A-Za-z0-9_:-]+)\}\s*(.*?)\s*$")
RAW_DIRECTIVES = {"code", "code-block", "sourcecode", "eval-rst", "raw", "mermaid"}
OPTION_LINE_RE = re.compile(r"^:([A-Za-z0-9_-]+):(?:\s*(.*))?$")
MARKDOWN_SVG_REF_RE = re.compile(
    r"""(?:!\[[^\]]*\]\(|(?:src|href)=["'])([^"')\s>]+\.svg)(?:[#?][^"')\s>]*)?""",
    re.IGNORECASE,
)
EXTERNAL_URL_RE = re.compile(r"^(?:https?:|javascript:|//)", re.IGNORECASE)


@dataclass(frozen=True)
class DirectiveRecord:
    """Parsed MyST figure or image directive from a documentation page."""

    source_file: Path
    line_number: int
    kind: str
    target: str
    options: dict[str, str]


def _local_name(tag: str) -> str:
    if tag.startswith("{") and "}" in tag:
        return tag.split("}", 1)[1]
    return tag


def _is_dark_variant(path: Path) -> bool:
    return path.name.lower().endswith("-dark.svg")


def _light_sibling_for(dark_path: Path) -> Path:
    stem = dark_path.name[:-9]  # strip "-dark.svg"
    return dark_path.with_name(f"{stem}.svg")


def _dark_sibling_for(light_path: Path) -> Path:
    stem = light_path.name[:-4]  # strip ".svg"
    return light_path.with_name(f"{stem}-dark.svg")


def _is_excluded_doc(path: Path, site_root: Path = SITE_ROOT) -> bool:
    rel_parts = path.relative_to(site_root).parts
    if any(part in EXCLUDED_DIRS for part in rel_parts):
        return True
    return path.name in EXCLUDED_FILENAMES


def _iter_site_markdown_files(base_dir: Path, site_root: Path = SITE_ROOT) -> list[Path]:
    return sorted(
        path
        for path in base_dir.rglob("*.md")
        if path.is_file() and not _is_excluded_doc(path, site_root=site_root)
    )


def _strip_base_indent(line: str, base_indent: str) -> str:
    if base_indent and line.startswith(base_indent):
        return line[len(base_indent):]
    return line


def _parse_directive_options(body_lines: list[str], base_indent: str = "") -> dict[str, str]:
    options: dict[str, str] = {}
    current_key: str | None = None
    for raw_line in body_lines:
        line = _strip_base_indent(raw_line, base_indent)
        stripped = line.strip()
        if not stripped:
            break
        match = OPTION_LINE_RE.match(line)
        if match:
            current_key = match.group(1)
            options[current_key] = (match.group(2) or "").strip()
            continue
        if current_key is not None and line[:1].isspace():
            previous = options[current_key]
            options[current_key] = f"{previous} {stripped}".strip()
            continue
        break
    return options


def _is_closing_fence(line: str, fence_char: str, fence_len: int) -> bool:
    return bool(re.match(rf"^\s*{re.escape(fence_char)}{{{fence_len},}}\s*$", line))


def _iter_non_code_lines(lines: list[str]) -> Iterator[tuple[int, str]]:
    """Yield (0-based index, line) strictly outside fenced code blocks and raw directives."""
    fence_stack: list[tuple[str, int]] = []
    idx = 0
    while idx < len(lines):
        line = lines[idx]

        # Close the innermost open directive container before interpreting a bare fence as code.
        if fence_stack and _is_closing_fence(line, *fence_stack[-1]):
            fence_stack.pop()
            yield idx, line
            idx += 1
            continue

        dir_match = ANY_DIRECTIVE_OPEN_RE.match(line)
        if dir_match:
            fence, kind = dir_match.group(2), dir_match.group(3)
            fence_char, fence_len = fence[0], len(fence)
            if kind in RAW_DIRECTIVES:
                idx += 1
                while idx < len(lines) and not _is_closing_fence(lines[idx], fence_char, fence_len):
                    idx += 1
                idx += 1
                continue
            fence_stack.append((fence_char, fence_len))
            yield idx, line
            idx += 1
            continue

        code_match = CODE_FENCE_OPEN_RE.match(line)
        if code_match:
            fence = code_match.group(1) or code_match.group(2)
            fence_char, fence_len = fence[0], len(fence)
            idx += 1
            while idx < len(lines) and not _is_closing_fence(lines[idx], fence_char, fence_len):
                idx += 1
            idx += 1
            continue

        yield idx, line
        idx += 1


def _extract_directives(md_file: Path) -> list[DirectiveRecord]:
    lines = md_file.read_text(encoding="utf-8").splitlines()
    directives: list[DirectiveRecord] = []
    stream = _iter_non_code_lines(lines)
    for idx, line in stream:
        dir_match = ANY_DIRECTIVE_OPEN_RE.match(line)
        if not dir_match:
            continue
        base_indent, fence, kind, target = (
            dir_match.group(1),
            dir_match.group(2),
            dir_match.group(3),
            dir_match.group(4).strip(),
        )
        if kind not in ("figure", "image"):
            continue
        fence_char, fence_len = fence[0], len(fence)
        start_line = idx + 1
        body_lines: list[str] = []
        for _, body_line in stream:
            if _is_closing_fence(body_line, fence_char, fence_len):
                break
            body_lines.append(body_line)
        directives.append(
            DirectiveRecord(
                source_file=md_file,
                line_number=start_line,
                kind=kind,
                target=target,
                options=_parse_directive_options(body_lines, base_indent=base_indent),
            )
        )
    return directives


def _resolve_site_target(
    source_file: Path, raw_target: str, site_root: Path = SITE_ROOT
) -> Path | None:
    target = raw_target.strip().split("#", 1)[0].split("?", 1)[0]
    if not target or EXTERNAL_URL_RE.match(target):
        return None
    if target.startswith("/"):
        candidate = (site_root / target.lstrip("/")).resolve()
    else:
        candidate = (source_file.parent / target).resolve()
    site_root_resolved = site_root.resolve()
    if not candidate.is_relative_to(site_root_resolved):
        return None
    return candidate


def _collect_referenced_svg_paths(site_root: Path = SITE_ROOT) -> set[Path]:
    referenced: set[Path] = set()
    for md_file in _iter_site_markdown_files(site_root, site_root=site_root):
        for directive in _extract_directives(md_file):
            resolved = _resolve_site_target(md_file, directive.target, site_root=site_root)
            if resolved is not None and resolved.suffix.lower() == ".svg":
                referenced.add(resolved)
        lines = md_file.read_text(encoding="utf-8").splitlines()
        for _, line in _iter_non_code_lines(lines):
            for match in MARKDOWN_SVG_REF_RE.finditer(line):
                resolved = _resolve_site_target(md_file, match.group(1), site_root=site_root)
                if resolved is not None:
                    referenced.add(resolved)
    return referenced


def _find_orphaned_diagram_svgs(
    diagrams_dir: Path = DIAGRAMS_DIR,
    referenced: set[Path] | None = None,
) -> list[Path]:
    """Return unreferenced SVGs under ``diagrams_dir``.

    A dark-mode companion ``<slug>-dark.svg`` is considered referenced if and only
    if its sibling light diagram ``<slug>.svg`` is referenced in documentation.
    """
    ref_set = _collect_referenced_svg_paths() if referenced is None else referenced
    orphaned: list[Path] = []
    for svg_path in sorted(diagrams_dir.rglob("*.svg")):
        resolved = svg_path.resolve()
        if _is_dark_variant(svg_path):
            light_sibling = _light_sibling_for(svg_path).resolve()
            if light_sibling not in ref_set:
                orphaned.append(svg_path)
        elif resolved not in ref_set:
            orphaned.append(svg_path)
    return orphaned


def _parse_and_validate_svg(testcase: unittest.TestCase, svg_path: Path, label: str) -> str:
    """Validate XML well-formedness, viewBox, accessibility, and self-containment.

    Returns the normalized ``viewBox`` string.
    """
    raw_xml = svg_path.read_text(encoding="utf-8")
    try:
        root = ET.fromstring(raw_xml)
    except ET.ParseError as exc:
        testcase.fail(f"{label} failed XML parsing: {exc}")

    testcase.assertEqual(_local_name(root.tag), "svg", f"{label} root element must be <svg>")

    view_box = (root.attrib.get("viewBox") or "").strip()
    testcase.assertTrue(view_box, f"{label} is missing a non-empty viewBox")
    parts = re.split(r"[\s,]+", view_box)
    testcase.assertEqual(len(parts), 4, f"{label} viewBox must have 4 numbers: {view_box!r}")
    coords = [float(part) for part in parts]
    testcase.assertTrue(all(math.isfinite(val) for val in coords), f"{label} viewBox has non-finite values")
    testcase.assertGreater(coords[2], 0.0, f"{label} viewBox width must be > 0")
    testcase.assertGreater(coords[3], 0.0, f"{label} viewBox height must be > 0")

    testcase.assertEqual(root.attrib.get("role"), "img", f'{label} must declare role="img"')

    titles = [
        "".join(elem.itertext()).strip()
        for elem in root.iter()
        if _local_name(elem.tag) == "title"
    ]
    testcase.assertTrue(any(titles), f"{label} must contain a non-empty <title>")

    descs = [
        "".join(elem.itertext()).strip()
        for elem in root.iter()
        if _local_name(elem.tag) == "desc"
    ]
    testcase.assertTrue(any(descs), f"{label} must contain a non-empty <desc>")

    for elem in root.iter():
        tag_name = _local_name(elem.tag)
        testcase.assertNotEqual(tag_name, "script", f"{label} must not contain <script>")
        if tag_name == "image":
            for attr_name, attr_val in elem.attrib.items():
                if _local_name(attr_name) == "href":
                    testcase.assertFalse(
                        EXTERNAL_URL_RE.match(attr_val.strip()),
                        f"{label} has external <image> href: {attr_val!r}",
                    )

    return " ".join(parts)


class _FakeImageMap(dict):
    """Minimal stand-in for ``sphinx.util.images.ImageMap`` in unit tests."""

    def add_file(self, docname: str, filename: str) -> str:
        basename = Path(filename).name
        docs, _ = self.get(filename, (set(), basename))
        docs = set(docs)
        docs.add(docname)
        self[filename] = (docs, basename)
        return basename


class PublicDocsPhysicsDiagramsTests(unittest.TestCase):
    def test_diagram_svgs_are_valid_accessible_and_self_contained(self) -> None:
        self.assertTrue(DIAGRAMS_DIR.is_dir(), f"Missing diagrams directory: {DIAGRAMS_DIR}")
        svg_files = sorted(DIAGRAMS_DIR.rglob("*.svg"))
        self.assertTrue(svg_files, f"Expected at least one SVG file under {DIAGRAMS_DIR}")

        for svg_path in svg_files:
            rel_path = svg_path.relative_to(ROOT)
            with self.subTest(svg=str(rel_path)):
                _parse_and_validate_svg(self, svg_path, str(rel_path))

    def test_every_referenced_diagram_has_matching_dark_variant(self) -> None:
        diagrams_root = DIAGRAMS_DIR.resolve()
        referenced = sorted(
            path
            for path in _collect_referenced_svg_paths()
            if path.is_relative_to(diagrams_root) and not _is_dark_variant(path)
        )
        self.assertTrue(referenced, "Expected referenced SVG diagrams under _static/diagrams/")

        for light_path in referenced:
            rel_light = light_path.relative_to(ROOT)
            dark_path = _dark_sibling_for(light_path)
            rel_dark = dark_path.relative_to(ROOT)
            with self.subTest(diagram=str(rel_light)):
                self.assertTrue(light_path.is_file(), f"Missing light diagram: {rel_light}")
                self.assertTrue(
                    dark_path.is_file(),
                    f"Missing dark-mode companion diagram {rel_dark} for {rel_light}",
                )
                light_vb = _parse_and_validate_svg(self, light_path, str(rel_light))
                dark_vb = _parse_and_validate_svg(self, dark_path, str(rel_dark))
                self.assertEqual(
                    light_vb,
                    dark_vb,
                    f"Mismatched viewBox between {rel_light} ({light_vb!r}) and {rel_dark} ({dark_vb!r})",
                )

    def test_physics_figure_and_image_directives_resolve_with_alt_and_unique_names(self) -> None:
        physics_files = _iter_site_markdown_files(PHYSICS_ROOT)
        self.assertTrue(physics_files, f"No physics markdown files found under {PHYSICS_ROOT}")

        physics_directives: list[DirectiveRecord] = []
        for md_file in physics_files:
            physics_directives.extend(_extract_directives(md_file))

        self.assertTrue(physics_directives, "Expected at least one {figure} or {image} directive in physics docs")

        for record in physics_directives:
            rel_md = record.source_file.relative_to(ROOT)
            with self.subTest(file=str(rel_md), line=record.line_number, target=record.target):
                resolved = _resolve_site_target(record.source_file, record.target)
                self.assertIsNotNone(
                    resolved,
                    f"{rel_md}:{record.line_number} directive target {record.target!r} escapes {SITE_ROOT}",
                )
                assert resolved is not None
                self.assertTrue(
                    resolved.is_file(),
                    f"{rel_md}:{record.line_number} target does not exist: {record.target!r} -> {resolved}",
                )
                alt_text = record.options.get("alt", "").strip()
                self.assertTrue(
                    alt_text,
                    f"{rel_md}:{record.line_number} {{{record.kind}}} is missing non-empty :alt:",
                )
                if record.kind == "figure":
                    class_tokens = record.options.get("class", "").split()
                    self.assertNotIn(
                        "fm-physics-figure",
                        class_tokens,
                        f"{rel_md}:{record.line_number} {{figure}} must use :figclass: fm-physics-figure instead of :class:",
                    )
                    if resolved.suffix.lower() == ".svg":
                        figclass_tokens = record.options.get("figclass", "").split()
                        self.assertIn(
                            "fm-physics-figure",
                            figclass_tokens,
                            f"{rel_md}:{record.line_number} SVG {{figure}} must declare :figclass: fm-physics-figure",
                        )
                if "name" in record.options:
                    self.assertTrue(
                        record.options["name"].strip(),
                        f"{rel_md}:{record.line_number} {{{record.kind}}} has empty :name:",
                    )

        seen_names: dict[str, tuple[Path, int]] = {}
        for md_file in _iter_site_markdown_files(SITE_ROOT):
            for record in _extract_directives(md_file):
                name = record.options.get("name", "").strip()
                if not name:
                    continue
                rel_md = record.source_file.relative_to(ROOT)
                if name in seen_names:
                    prev_file, prev_line = seen_names[name]
                    self.fail(
                        f"Duplicate directive :name: {name!r} at {rel_md}:{record.line_number} "
                        f"(previously defined at {prev_file.relative_to(ROOT)}:{prev_line})"
                    )
                seen_names[name] = (record.source_file, record.line_number)

    def test_no_orphaned_svg_files_in_diagrams_directory(self) -> None:
        orphaned = [str(p.relative_to(ROOT)) for p in _find_orphaned_diagram_svgs()]
        self.assertEqual(orphaned, [], f"Orphaned SVG files not referenced in public_docs/site/: {orphaned}")

    def test_orphan_check_accepts_paired_dark_svg_and_flags_unpaired_dark_svg(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            site_root = Path(tmp_dir)
            diagrams = site_root / "_static" / "diagrams"
            diagrams.mkdir(parents=True)
            for name in (
                "used.svg",
                "used-dark.svg",
                "unused-dark.svg",
                "lonely.svg",
                "lonely-dark.svg",
            ):
                (diagrams / name).write_text("<svg/>", encoding="utf-8")
            (site_root / "page.md").write_text("![Used](/_static/diagrams/used.svg)\n", encoding="utf-8")

            referenced = _collect_referenced_svg_paths(site_root=site_root)
            orphaned = [p.name for p in _find_orphaned_diagram_svgs(diagrams_dir=diagrams, referenced=referenced)]

        self.assertEqual(orphaned, ["lonely-dark.svg", "lonely.svg", "unused-dark.svg"])

    def test_extract_directives_handles_odd_math_fences_and_ignores_code_samples(self) -> None:
        sample = """# Sample page

```{math}
:label: eq-first
a = b
```

```{figure} /_static/diagrams/real.svg
:alt: Real diagram
:name: fig-real
:figclass: fm-physics-figure

Caption.
```

````markdown
```{figure} /_static/diagrams/example-only.svg
:alt: Example snippet
```
````

::::{grid} 1
:::{card}
```{image} /_static/diagrams/nested.svg
:alt: Nested diagram
```
:::
::::
"""
        with tempfile.TemporaryDirectory() as tmp_dir:
            sample_md = Path(tmp_dir) / "sample.md"
            sample_md.write_text(sample, encoding="utf-8")
            extracted = _extract_directives(sample_md)

        self.assertEqual([d.target for d in extracted], [
            "/_static/diagrams/real.svg",
            "/_static/diagrams/nested.svg",
        ])
        self.assertEqual(extracted[0].options["alt"], "Real diagram")
        self.assertEqual(extracted[0].options["name"], "fig-real")
        self.assertEqual(extracted[0].options["figclass"], "fm-physics-figure")
        self.assertEqual(extracted[1].options["alt"], "Nested diagram")

    def test_orphan_check_ignores_markdown_svg_references_inside_fenced_code_blocks(self) -> None:
        page_text = """# Page

```markdown
![Example](/_static/diagrams/example-only.svg)
<img src="/_static/diagrams/html-example-only.svg" alt="Example">
```

```{code-block} markdown
![Code block example](/_static/diagrams/raw-example-only.svg)
```

![Live](/_static/diagrams/live-used.svg)
"""
        with tempfile.TemporaryDirectory() as tmp_dir:
            site_root = Path(tmp_dir)
            diagrams = site_root / "_static" / "diagrams"
            diagrams.mkdir(parents=True)
            for name in (
                "example-only.svg",
                "html-example-only.svg",
                "raw-example-only.svg",
                "live-used.svg",
            ):
                (diagrams / name).write_text("<svg/>", encoding="utf-8")
            (site_root / "page.md").write_text(page_text, encoding="utf-8")

            referenced = _collect_referenced_svg_paths(site_root=site_root)

        self.assertEqual(referenced, {(diagrams / "live-used.svg").resolve()})

    def test_theme_palettes_meet_wcag_aa_contrast(self) -> None:
        for theme_name, theme in THEMES.items():
            for token in TEXT_CONTRAST_TOKENS:
                with self.subTest(theme=theme_name, token=token):
                    self.assertGreaterEqual(
                        contrast_ratio(theme[token], theme.surface_ref),
                        4.5,
                        f"{theme_name}.{token} failed 4.5:1 against surface_ref",
                    )
                    self.assertGreaterEqual(
                        contrast_ratio(theme[token], theme.node_fill),
                        4.5,
                        f"{theme_name}.{token} failed 4.5:1 against node_fill",
                    )
            for token in STROKE_CONTRAST_TOKENS:
                with self.subTest(theme=theme_name, stroke=token):
                    self.assertGreaterEqual(
                        contrast_ratio(theme[token], theme.surface_ref),
                        3.0,
                        f"{theme_name}.{token} failed 3.0:1 against surface_ref",
                    )
                    self.assertGreaterEqual(
                        contrast_ratio(theme[token], theme.node_fill),
                        3.0,
                        f"{theme_name}.{token} failed 3.0:1 against node_fill",
                    )

    def test_css_and_sphinx_config_enable_native_dual_theme_diagrams(self) -> None:
        conf_text = CONF_PATH.read_text(encoding="utf-8")
        self.assertIn('"themed_diagrams"', conf_text)

        css_text = CSS_PATH.read_text(encoding="utf-8")
        self.assertIn("color-scheme: light dark;", css_text)
        self.assertIn("@media (prefers-color-scheme: dark)", css_text)
        self.assertIn("html:not([data-theme])", css_text)
        self.assertIn("img.fm-diagram-light", css_text)
        self.assertIn("img.fm-diagram-dark", css_text)
        self.assertIn("a.image-reference:has(> img.fm-diagram-dark)", css_text)
        self.assertIn("a.image-reference:has(> img.fm-diagram-light)", css_text)
        self.assertIn("@media (forced-colors: active)", css_text)
        self.assertNotIn("background-color: #fbfcfe;", css_text)

    def test_svg_canvas_text_overrides_win_css_cascade(self) -> None:
        canvas = SvgCanvas(200, 100, theme="light", title="Cascade test", desc="Test inline overrides.")
        canvas.text(10, 20, "Red", cls="fm-label", fill="m", size=14.0, weight=700, italic=True)
        canvas.math_text(10, 50, "H", fill="H", size=11.0, italic=False)
        root = ET.fromstring(canvas.to_svg())
        texts = [elem for elem in root.iter() if _local_name(elem.tag) == "text"]
        self.assertEqual(len(texts), 2)
        style_0 = texts[0].attrib.get("style", "")
        self.assertIn(f"fill:{THEMES['light'].m}", style_0)
        self.assertIn("font-size:14px", style_0)
        self.assertIn("font-weight:700", style_0)
        self.assertIn("font-style:italic", style_0)
        style_1 = texts[1].attrib.get("style", "")
        self.assertIn(f"fill:{THEMES['light'].H}", style_1)
        self.assertIn("font-size:11px", style_1)
        self.assertIn("font-style:normal", style_1)


class ThemedDiagramsExtensionTests(unittest.TestCase):
    @staticmethod
    def _make_app(srcdir: Path, *, builder_format: str = "html", builder_name: str = "html"):
        env = SimpleNamespace(
            images=_FakeImageMap(),
            dependencies=defaultdict(set),
        )
        return SimpleNamespace(
            srcdir=str(srcdir),
            builder=SimpleNamespace(format=builder_format, name=builder_name),
            env=env,
        )

    def test_inject_themed_diagrams_pairs_svg_with_dark_sibling_and_leaves_unpaired_untouched(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            srcdir = Path(tmp_dir)
            diagrams = srcdir / "_static" / "diagrams"
            diagrams.mkdir(parents=True)
            (diagrams / "paired.svg").write_text("<svg/>", encoding="utf-8")
            (diagrams / "paired-dark.svg").write_text("<svg/>", encoding="utf-8")
            (diagrams / "single.svg").write_text("<svg/>", encoding="utf-8")
            (srcdir / "_static" / "logo.svg").write_text("<svg/>", encoding="utf-8")
            (srcdir / "_static" / "logo-dark.svg").write_text("<svg/>", encoding="utf-8")

            doc = nodes.document("", None)
            fig = nodes.figure("", classes=["fm-physics-figure"])
            paired_img = nodes.image(
                uri="_static/diagrams/paired.svg",
                alt="Paired diagram",
                ids=["fig-paired-img"],
                names=["fig-paired-img"],
            )
            paired_img["candidates"] = {"*": "_static/diagrams/paired.svg"}
            fig += paired_img
            fig += nodes.caption("", "Caption text")
            doc += fig

            single_para = nodes.paragraph("")
            single_img = nodes.image(uri="_static/diagrams/single.svg", alt="Single diagram")
            single_img["candidates"] = {"*": "_static/diagrams/single.svg"}
            single_para += single_img
            doc += single_para

            outside_para = nodes.paragraph("")
            outside_img = nodes.image(uri="_static/logo.svg", alt="Logo")
            outside_img["candidates"] = {"*": "_static/logo.svg"}
            outside_para += outside_img
            doc += outside_para

            app = self._make_app(srcdir)
            themed_diagrams._inject_themed_diagrams(app, doc, "physics/sample")
            # Verify idempotency on second pass
            themed_diagrams._inject_themed_diagrams(app, doc, "physics/sample")

            self.assertIn("fm-themed-figure", fig["classes"])
            fig_images = list(fig.findall(nodes.image))
            self.assertEqual(len(fig_images), 2)

            light_img, dark_img = fig_images
            self.assertEqual(light_img["uri"], "_static/diagrams/paired.svg")
            self.assertIn("fm-diagram-light", light_img["classes"])
            self.assertNotIn("fm-diagram-dark", light_img["classes"])
            self.assertEqual(light_img["alt"], "Paired diagram")

            self.assertEqual(dark_img["uri"], "_static/diagrams/paired-dark.svg")
            self.assertIn("fm-diagram-dark", dark_img["classes"])
            self.assertNotIn("fm-diagram-light", dark_img["classes"])
            self.assertEqual(dark_img["alt"], "Paired diagram")
            self.assertEqual(dark_img["ids"], [])
            self.assertEqual(dark_img["names"], [])
            self.assertEqual(dark_img["candidates"], {"*": "_static/diagrams/paired-dark.svg"})

            self.assertIn("_static/diagrams/paired-dark.svg", app.env.images)
            self.assertIn("_static/diagrams/paired-dark.svg", app.env.dependencies["physics/sample"])

            # Unpaired and non-diagram SVGs remain untouched
            self.assertEqual(len(list(single_para.findall(nodes.image))), 1)
            self.assertEqual(single_img["classes"], [])
            self.assertEqual(len(list(outside_para.findall(nodes.image))), 1)
            self.assertEqual(outside_img["classes"], [])

    def test_inject_themed_diagrams_skips_non_html_builders(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            srcdir = Path(tmp_dir)
            diagrams = srcdir / "_static" / "diagrams"
            diagrams.mkdir(parents=True)
            (diagrams / "paired.svg").write_text("<svg/>", encoding="utf-8")
            (diagrams / "paired-dark.svg").write_text("<svg/>", encoding="utf-8")

            doc = nodes.document("", None)
            img = nodes.image(uri="_static/diagrams/paired.svg", alt="Paired")
            doc += nodes.paragraph("", "", img)

            app = self._make_app(srcdir, builder_format="latex", builder_name="latex")
            themed_diagrams._inject_themed_diagrams(app, doc, "physics/sample")

            self.assertEqual(len(list(doc.findall(nodes.image))), 1)
            self.assertEqual(img["classes"], [])

    def test_inject_color_scheme_meta_adds_once(self) -> None:
        app = self._make_app(Path("."))
        ctx: dict[str, object] = {"metatags": '<meta name="description" content="docs" />'}
        themed_diagrams._inject_color_scheme_meta(app, "index", "page.html", ctx, None)
        self.assertIn('<meta name="color-scheme" content="light dark" />', str(ctx["metatags"]))
        first_value = str(ctx["metatags"])
        themed_diagrams._inject_color_scheme_meta(app, "index", "page.html", ctx, None)
        self.assertEqual(str(ctx["metatags"]), first_value)


if __name__ == "__main__":
    unittest.main()
