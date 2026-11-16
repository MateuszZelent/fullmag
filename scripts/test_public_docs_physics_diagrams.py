"""Validate SVG physics diagrams and MyST figure/image directives in public docs."""

from __future__ import annotations

from dataclasses import dataclass
import math
from pathlib import Path
import re
import tempfile
from typing import Iterator
import unittest
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
SITE_ROOT = ROOT / "public_docs" / "site"
PHYSICS_ROOT = SITE_ROOT / "physics"
DIAGRAMS_DIR = SITE_ROOT / "_static" / "diagrams"

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


class PublicDocsPhysicsDiagramsTests(unittest.TestCase):
    def test_diagram_svgs_are_valid_accessible_and_self_contained(self) -> None:
        self.assertTrue(DIAGRAMS_DIR.is_dir(), f"Missing diagrams directory: {DIAGRAMS_DIR}")
        svg_files = sorted(DIAGRAMS_DIR.rglob("*.svg"))
        self.assertTrue(svg_files, f"Expected at least one SVG file under {DIAGRAMS_DIR}")

        for svg_path in svg_files:
            rel_path = svg_path.relative_to(ROOT)
            with self.subTest(svg=str(rel_path)):
                raw_xml = svg_path.read_text(encoding="utf-8")
                try:
                    root = ET.fromstring(raw_xml)
                except ET.ParseError as exc:
                    self.fail(f"{rel_path} failed XML parsing: {exc}")

                self.assertEqual(_local_name(root.tag), "svg", f"{rel_path} root element must be <svg>")

                view_box = (root.attrib.get("viewBox") or "").strip()
                self.assertTrue(view_box, f"{rel_path} is missing a non-empty viewBox")
                parts = re.split(r"[\s,]+", view_box)
                self.assertEqual(len(parts), 4, f"{rel_path} viewBox must have 4 numbers: {view_box!r}")
                coords = [float(part) for part in parts]
                self.assertTrue(all(math.isfinite(val) for val in coords), f"{rel_path} viewBox has non-finite values")
                self.assertGreater(coords[2], 0.0, f"{rel_path} viewBox width must be > 0")
                self.assertGreater(coords[3], 0.0, f"{rel_path} viewBox height must be > 0")

                self.assertEqual(root.attrib.get("role"), "img", f'{rel_path} must declare role="img"')

                titles = [
                    "".join(elem.itertext()).strip()
                    for elem in root.iter()
                    if _local_name(elem.tag) == "title"
                ]
                self.assertTrue(any(titles), f"{rel_path} must contain a non-empty <title>")

                descs = [
                    "".join(elem.itertext()).strip()
                    for elem in root.iter()
                    if _local_name(elem.tag) == "desc"
                ]
                self.assertTrue(any(descs), f"{rel_path} must contain a non-empty <desc>")

                for elem in root.iter():
                    tag_name = _local_name(elem.tag)
                    self.assertNotEqual(tag_name, "script", f"{rel_path} must not contain <script>")
                    if tag_name == "image":
                        for attr_name, attr_val in elem.attrib.items():
                            if _local_name(attr_name) == "href":
                                self.assertFalse(
                                    EXTERNAL_URL_RE.match(attr_val.strip()),
                                    f"{rel_path} has external <image> href: {attr_val!r}",
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
        referenced = _collect_referenced_svg_paths()
        svg_files = sorted(DIAGRAMS_DIR.rglob("*.svg"))
        orphaned = [
            str(svg_path.relative_to(ROOT))
            for svg_path in svg_files
            if svg_path.resolve() not in referenced
        ]
        self.assertEqual(orphaned, [], f"Orphaned SVG files not referenced in public_docs/site/: {orphaned}")

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


if __name__ == "__main__":
    unittest.main()
