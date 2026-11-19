"""Editorial, math, table, and code-formatting hygiene gates for published Fullmag docs."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[4]
SITE_ROOT = ROOT / "public_docs" / "site"

EXCLUDED_DIRS = {"_build", "internal", "generated"}
EXCLUDED_FILENAMES = {"README.md", "PAGE_TEMPLATE.md"}

ANY_DIRECTIVE_OPEN_RE = re.compile(
    r"^(\s*)(`{3,}|~{3,}|:{3,})\{([A-Za-z0-9_:-]+)\}\s*(.*?)\s*$"
)
CODE_FENCE_OPEN_RE = re.compile(r"^\s*(`{3,}|~{3,})(?!\{)(.*)$")
RAW_DIRECTIVES = {"code", "code-block", "sourcecode", "eval-rst", "raw", "mermaid"}
OPTION_LINE_RE = re.compile(r"^:([A-Za-z0-9_-]+):(?:\s*(.*))?$")

BARE_FIG_REF_RE = re.compile(r"\{ref\}`([^`]+)`")
MATH_TEXT_MACRO_RE = re.compile(r"\\(?:mathrm|text|operatorname)\s*\{")
FAKE_QIR_RE = re.compile(r"q_\{\\mathrm\{IR\}\}|qualified inputs", re.IGNORECASE)

BANNED_HEADING_PATTERNS = (
    re.compile(r"^\s*#{1,6}\s+Publication rule\b", re.IGNORECASE),
    re.compile(r"^\s*#{1,6}\s+Recommended documentation split\b", re.IGNORECASE),
    re.compile(r"^\s*#{1,6}\s+(?:\d+\.\s*)?Required per-page frontend crosswalk contract\b", re.IGNORECASE),
    re.compile(r"^\s*#{1,6}\s+Recording future changes\b", re.IGNORECASE),
    re.compile(r"^\s*#{1,6}\s+Source-map coverage\b", re.IGNORECASE),
    re.compile(r"^\s*#{1,6}\s+Control Room crosswalk\b", re.IGNORECASE),
    re.compile(r"^\s*#{1,6}\s+Python/API crosswalk\b", re.IGNORECASE),
)
BANNED_PHRASES_LOWER = (
    "this is a navigation page",
    "no independent scientific model is introduced",
    "adds no new equation or unverified implementation claim",
    "frontend support is not implemented applies to",
    "runnable python is not applicable here",
)
BANNED_LITERAL_SUBSTRINGS = (
    ".source-map.json",
    "**Last changes:",
)
INTERNAL_DOCS_REF_RE = re.compile(r"(?<![A-Za-z0-9_])docs/(?!fullmag-logo-traced-optimized\.svg)")

BARE_REPO_PATH_RE = re.compile(
    r"(?<![A-Za-z0-9_./-])(?:packages/fullmag-py|crates/fullmag-[A-Za-z0-9_-]+|apps/control-room)/[^\s`)\]>\"'|,;]+"
)
BARE_FM_IDENT_RE = re.compile(r"(?<![A-Za-z0-9_.-])fm(?:\.[A-Za-z0-9_]+)+")
ASSET_EXTENSIONS = (".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".html", ".css", ".js")
MYST_ROLE_RE = re.compile(r"\{[A-Za-z0-9_:-]+\}`[^`\n]+`")
HTML_ATTR_RE = re.compile(r"""\b(?:href|src|alt)\s*=\s*(?:"[^"]*"|'[^']*')""", re.IGNORECASE)
REF_LINK_DEF_RE = re.compile(r"^(\s*\[[^\]]+\]:\s*)\S.*$")
TABLE_SEPARATOR_RE = re.compile(r"^\s*\|[\s:|-]+\|\s*$")


@dataclass(frozen=True)
class LineRecord:
    """One segmented source line from a Markdown document."""

    line_number: int
    text: str
    kind: str  # "frontmatter", "prose", "directive_option", "math"


@dataclass(frozen=True)
class ParsedDocument:
    """Segmented regions of a published Markdown document."""

    lines: list[LineRecord]


def iter_published_markdown_files(site_root: Path = SITE_ROOT) -> list[Path]:
    """Return all published Markdown files under ``public_docs/site``."""
    return sorted(
        path
        for path in site_root.rglob("*.md")
        if path.is_file()
        and not any(part in EXCLUDED_DIRS for part in path.relative_to(site_root).parts)
        and path.name not in EXCLUDED_FILENAMES
    )


def _is_closing_fence(line: str, fence_char: str, fence_len: int) -> bool:
    return bool(re.match(rf"^\s*{re.escape(fence_char)}{{{fence_len},}}\s*$", line))


def _is_unescaped_at(text: str, index: int) -> bool:
    backslashes = 0
    pos = index - 1
    while pos >= 0 and text[pos] == "\\":
        backslashes += 1
        pos -= 1
    return backslashes % 2 == 0


def _strip_base_indent(line: str, base_indent: str) -> str:
    if base_indent and line.startswith(base_indent):
        return line[len(base_indent):]
    return line


def parse_markdown_regions(text: str) -> ParsedDocument:
    """Segment a MyST Markdown file into frontmatter, prose, directive options, and math blocks."""
    raw_lines = text.splitlines()
    records: list[LineRecord] = []
    idx = 0

    if raw_lines and raw_lines[0].strip() == "---":
        records.append(LineRecord(1, raw_lines[0], "frontmatter"))
        idx = 1
        while idx < len(raw_lines):
            records.append(LineRecord(idx + 1, raw_lines[idx], "frontmatter"))
            if raw_lines[idx].strip() in ("---", "..."):
                idx += 1
                break
            idx += 1

    fence_stack: list[tuple[str, int]] = []
    in_directive_options = False
    directive_base_indent = ""
    directive_option_key: str | None = None

    while idx < len(raw_lines):
        line = raw_lines[idx]
        line_no = idx + 1

        if fence_stack and _is_closing_fence(line, *fence_stack[-1]):
            fence_stack.pop()
            in_directive_options = False
            directive_option_key = None
            records.append(LineRecord(line_no, line, "prose"))
            idx += 1
            continue

        dir_match = ANY_DIRECTIVE_OPEN_RE.match(line)
        if dir_match:
            base_indent, fence, kind = dir_match.group(1), dir_match.group(2), dir_match.group(3).strip()
            fence_char, fence_len = fence[0], len(fence)
            if kind in RAW_DIRECTIVES:
                idx += 1
                while idx < len(raw_lines) and not _is_closing_fence(raw_lines[idx], fence_char, fence_len):
                    idx += 1
                idx += 1
                continue
            if kind == "math":
                idx += 1
                in_opts = True
                while idx < len(raw_lines) and not _is_closing_fence(raw_lines[idx], fence_char, fence_len):
                    body_line = raw_lines[idx]
                    stripped_opt = _strip_base_indent(body_line, base_indent)
                    if in_opts and OPTION_LINE_RE.match(stripped_opt):
                        idx += 1
                        continue
                    in_opts = False
                    records.append(LineRecord(idx + 1, body_line, "math"))
                    idx += 1
                idx += 1
                continue
            fence_stack.append((fence_char, fence_len))
            in_directive_options = True
            directive_base_indent = base_indent
            directive_option_key = None
            records.append(LineRecord(line_no, line, "directive_option"))
            idx += 1
            continue

        code_match = CODE_FENCE_OPEN_RE.match(line)
        if code_match:
            fence = code_match.group(1)
            fence_char, fence_len = fence[0], len(fence)
            idx += 1
            while idx < len(raw_lines) and not _is_closing_fence(raw_lines[idx], fence_char, fence_len):
                idx += 1
            idx += 1
            continue

        if in_directive_options:
            rel_line = _strip_base_indent(line, directive_base_indent)
            if not rel_line.strip():
                in_directive_options = False
                directive_option_key = None
            elif OPTION_LINE_RE.match(rel_line):
                directive_option_key = OPTION_LINE_RE.match(rel_line).group(1)  # type: ignore[union-attr]
                records.append(LineRecord(line_no, line, "directive_option"))
                idx += 1
                continue
            elif directive_option_key is not None and rel_line[:1].isspace():
                records.append(LineRecord(line_no, line, "directive_option"))
                idx += 1
                continue
            else:
                in_directive_options = False
                directive_option_key = None

        records.append(LineRecord(line_no, line, "prose"))
        idx += 1

    return ParsedDocument(lines=records)


def mask_inline_code_spans(text: str) -> str:
    """Replace CommonMark inline backtick code spans with spaces, preserving newlines."""
    chars = list(text)
    length = len(text)
    i = 0
    while i < length:
        if text[i] != "`" or not _is_unescaped_at(text, i):
            i += 1
            continue
        run_end = i
        while run_end < length and text[run_end] == "`":
            run_end += 1
        tick_len = run_end - i

        para_end = text.find("\n\n", run_end)
        if para_end == -1:
            para_end = length

        # Single-backtick MyST role spans like {ref}`fig-foo` are not inline code spans.
        if (
            tick_len == 1
            and i > 0
            and text[i - 1] == "}"
            and re.search(r"\{[A-Za-z0-9_:-]+\}$", text[max(0, i - 64) : i])
        ):
            role_end = text.find("`", run_end, para_end)
            if role_end != -1:
                i = role_end + 1
                continue

        j = run_end
        matched_end = -1
        while j < para_end:
            if text[j] == "`":
                close_end = j
                while close_end < para_end and text[close_end] == "`":
                    close_end += 1
                if close_end - j == tick_len:
                    matched_end = close_end
                    break
                j = close_end
                continue
            j += 1

        if matched_end != -1:
            for k in range(i, matched_end):
                if chars[k] != "\n":
                    chars[k] = " "
            i = matched_end
        else:
            i = run_end
    return "".join(chars)


def mask_markdown_link_urls(text: str) -> str:
    """Replace ``](url)`` targets and reference link URLs with spaces, keeping link labels."""
    chars = list(text)
    length = len(text)
    i = 0
    while i < length - 1:
        if text[i] == "]" and text[i + 1] == "(" and _is_unescaped_at(text, i):
            para_end = text.find("\n\n", i + 2)
            if para_end == -1:
                para_end = length
            depth = 1
            j = i + 2
            while j < para_end and depth > 0:
                ch = text[j]
                if ch == "\\" and j + 1 < para_end:
                    j += 2
                    continue
                if ch == "(":
                    depth += 1
                elif ch == ")":
                    depth -= 1
                    if depth == 0:
                        for k in range(i + 2, j):
                            if chars[k] != "\n":
                                chars[k] = " "
                        break
                j += 1
            i = j + 1
            continue
        i += 1

    lines = "".join(chars).splitlines(keepends=True)
    masked_lines: list[str] = []
    for line in lines:
        m = REF_LINK_DEF_RE.match(line.rstrip("\r\n"))
        if m:
            newline = line[len(line.rstrip("\r\n")):]
            masked_lines.append(m.group(1) + newline)
        else:
            masked_lines.append(line)
    return "".join(masked_lines)


def _find_matching_brace(text: str, open_brace_idx: int) -> int:
    depth = 0
    i = open_brace_idx
    while i < len(text):
        if text[i] == "\\" and i + 1 < len(text):
            i += 2
            continue
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1


def _iter_math_fragments(doc: ParsedDocument) -> list[tuple[int, str]]:
    """Extract (start_line, math_expression) pairs from {math}, $$...$$, and inline $...$."""
    fragments: list[tuple[int, str]] = []

    # 1. {math} directive blocks
    math_buf: list[str] = []
    math_start = 0
    prev_line = -2
    for rec in doc.lines:
        if rec.kind == "math":
            if rec.line_number != prev_line + 1 and math_buf:
                fragments.append((math_start, "\n".join(math_buf)))
                math_buf = []
            if not math_buf:
                math_start = rec.line_number
            math_buf.append(rec.text)
            prev_line = rec.line_number
        elif math_buf:
            fragments.append((math_start, "\n".join(math_buf)))
            math_buf = []
    if math_buf:
        fragments.append((math_start, "\n".join(math_buf)))

    # 2. Prose $$...$$ and $...$ outside inline code spans
    prose_blocks: list[tuple[int, str]] = []
    cur_lines: list[str] = []
    cur_start = 0
    prev_prose_line = -2
    for rec in doc.lines:
        if rec.kind == "prose":
            if rec.line_number != prev_prose_line + 1 and cur_lines:
                prose_blocks.append((cur_start, "\n".join(cur_lines)))
                cur_lines = []
            if not cur_lines:
                cur_start = rec.line_number
            cur_lines.append(rec.text)
            prev_prose_line = rec.line_number
        elif cur_lines:
            prose_blocks.append((cur_start, "\n".join(cur_lines)))
            cur_lines = []
    if cur_lines:
        prose_blocks.append((cur_start, "\n".join(cur_lines)))

    for block_start, block_text in prose_blocks:
        clean = mask_inline_code_spans(block_text)
        # Extract $$...$$ first
        chars = list(clean)
        i = 0
        while i < len(clean) - 1:
            if clean[i : i + 2] == "$$" and _is_unescaped_at(clean, i):
                end = clean.find("$$", i + 2)
                while end != -1 and not _is_unescaped_at(clean, end):
                    end = clean.find("$$", end + 2)
                if end != -1:
                    expr = clean[i + 2 : end]
                    line_no = block_start + clean[:i].count("\n")
                    fragments.append((line_no, expr))
                    for k in range(i, end + 2):
                        if chars[k] != "\n":
                            chars[k] = " "
                    i = end + 2
                    continue
            i += 1

        # Extract inline $...$ per line
        rem = "".join(chars)
        for line_offset, line in enumerate(rem.splitlines()):
            pos = 0
            while pos < len(line):
                if line[pos] == "$" and _is_unescaped_at(line, pos):
                    end = pos + 1
                    while end < len(line):
                        if line[end] == "$" and _is_unescaped_at(line, end):
                            fragments.append((block_start + line_offset, line[pos + 1 : end]))
                            pos = end + 1
                            break
                        end += 1
                    else:
                        break
                    continue
                pos += 1

    return fragments


def _has_unescaped_underscore_outside_nested_math(macro_name: str, arg: str) -> bool:
    """Check whether ``arg`` has an unescaped ``_`` (allowing nested ``$...$`` inside ``\\text``)."""
    in_nested_math = False
    allow_nested_math = macro_name == "text"
    i = 0
    while i < len(arg):
        ch = arg[i]
        if ch == "\\" and i + 1 < len(arg):
            i += 2
            continue
        if allow_nested_math and ch == "$":
            in_nested_math = not in_nested_math
            i += 1
            continue
        if ch == "_" and not in_nested_math:
            return True
        i += 1
    return False


def find_math_macro_underscore_errors(text: str) -> list[tuple[int, str]]:
    """Return ``(line_no, snippet)`` for unescaped ``_`` in ``\\mathrm``/``\\text``/``\\operatorname``."""
    doc = parse_markdown_regions(text)
    issues: list[tuple[int, str]] = []
    for base_line, expr in _iter_math_fragments(doc):
        for match in MATH_TEXT_MACRO_RE.finditer(expr):
            open_idx = match.end() - 1
            close_idx = _find_matching_brace(expr, open_idx)
            if close_idx == -1:
                continue
            arg = expr[open_idx + 1 : close_idx]
            macro_name = match.group(0).lstrip("\\").split("{", 1)[0].strip()
            if _has_unescaped_underscore_outside_nested_math(macro_name, arg):
                line_no = base_line + expr[: match.start()].count("\n")
                issues.append((line_no, expr[match.start() : close_idx + 1]))
    return issues


def find_bare_figure_refs(text: str) -> list[tuple[int, str]]:
    """Return ``(line_no, ref)`` for bare ``{ref}`fig-...` `` without ``<custom text>``."""
    doc = parse_markdown_regions(text)
    prose_lines = [rec for rec in doc.lines if rec.kind == "prose"]
    if not prose_lines:
        return []
    joined = "\n".join(rec.text for rec in prose_lines)
    masked = mask_inline_code_spans(joined)
    issues: list[tuple[int, str]] = []
    for line_idx, line in enumerate(masked.splitlines()):
        src_line_no = prose_lines[line_idx].line_number
        for match in BARE_FIG_REF_RE.finditer(line):
            target = match.group(1).strip()
            if target.startswith("fig-") and "<" not in target:
                issues.append((src_line_no, match.group(0)))
    return issues


def _count_unescaped_pipes(line: str) -> int:
    return sum(1 for idx, ch in enumerate(line) if ch == "|" and _is_unescaped_at(line, idx))


def find_inconsistent_table_pipes(text: str) -> list[tuple[int, str]]:
    """Return ``(header_line_no, detail)`` for Markdown tables with mismatched unescaped ``|`` counts."""
    doc = parse_markdown_regions(text)
    issues: list[tuple[int, str]] = []
    block: list[LineRecord] = []

    def check_block(rows: list[LineRecord]) -> None:
        if len(rows) < 2 or not TABLE_SEPARATOR_RE.match(rows[1].text):
            return
        counts = [_count_unescaped_pipes(row.text) for row in rows]
        expected = counts[1]
        if any(count != expected for count in counts):
            bad_rows = [
                f"L{row.line_number}({count})"
                for row, count in zip(rows, counts)
                if count != expected
            ]
            issues.append(
                (rows[0].line_number, f"expected {expected} pipes from separator row, saw {', '.join(bad_rows)}")
            )

    prev_line = -2
    for rec in doc.lines:
        if rec.kind == "prose" and rec.text.lstrip().startswith("|"):
            if rec.line_number != prev_line + 1 and block:
                check_block(block)
                block = []
            block.append(rec)
            prev_line = rec.line_number
        else:
            if block:
                check_block(block)
                block = []
    if block:
        check_block(block)

    return issues


def find_fake_qir_math(text: str) -> list[tuple[int, str]]:
    """Return ``(line_no, snippet)`` for fake ``q_{\\mathrm{IR}}`` or ``qualified inputs`` text."""
    doc = parse_markdown_regions(text)
    issues: list[tuple[int, str]] = []
    for rec in doc.lines:
        if rec.kind not in ("prose", "math"):
            continue
        for match in FAKE_QIR_RE.finditer(rec.text):
            issues.append((rec.line_number, match.group(0)))
    return issues


def find_banned_editorial_and_internal_refs(text: str) -> list[tuple[int, str]]:
    """Return ``(line_no, rule_hit)`` for banned headings, AI boilerplate, or internal ``docs/`` refs."""
    doc = parse_markdown_regions(text)
    issues: list[tuple[int, str]] = []
    for rec in doc.lines:
        if rec.kind == "frontmatter":
            if not rec.text.lstrip().startswith("source_of_truth:"):
                if INTERNAL_DOCS_REF_RE.search(rec.text):
                    issues.append((rec.line_number, "internal docs/ reference in frontmatter"))
            continue
        if rec.kind not in ("prose", "directive_option"):
            continue

        line = rec.text
        lowered = line.lower()

        for heading_re in BANNED_HEADING_PATTERNS:
            if heading_re.search(line):
                issues.append((rec.line_number, f"banned heading: {line.strip()}"))

        for phrase in BANNED_PHRASES_LOWER:
            if phrase in lowered:
                issues.append((rec.line_number, f"banned boilerplate phrase: {phrase!r}"))

        for literal in BANNED_LITERAL_SUBSTRINGS:
            if literal in line:
                issues.append((rec.line_number, f"banned editorial artifact: {literal!r}"))

        if INTERNAL_DOCS_REF_RE.search(line):
            issues.append((rec.line_number, f"internal docs/ reference: {line.strip()[:100]}"))

    return issues


def find_bare_paths_and_fm_identifiers(text: str) -> list[tuple[int, str]]:
    """Return ``(line_no, token)`` for unbackticked repo paths or ``fm.*`` tokens in prose."""
    doc = parse_markdown_regions(text)
    prose_lines = [rec for rec in doc.lines if rec.kind == "prose"]
    if not prose_lines:
        return []
    joined = "\n".join(rec.text for rec in prose_lines)
    masked = mask_inline_code_spans(joined)
    masked = mask_markdown_link_urls(masked)
    masked = MYST_ROLE_RE.sub(lambda m: " " * len(m.group(0)), masked)
    masked = HTML_ATTR_RE.sub(lambda m: " " * len(m.group(0)), masked)

    issues: list[tuple[int, str]] = []
    for line_idx, line in enumerate(masked.splitlines()):
        src_line_no = prose_lines[line_idx].line_number
        for match in BARE_REPO_PATH_RE.finditer(line):
            issues.append((src_line_no, f"unbackticked path {match.group(0)!r}"))
        for match in BARE_FM_IDENT_RE.finditer(line):
            token = match.group(0)
            if token.lower().endswith(ASSET_EXTENSIONS):
                continue
            issues.append((src_line_no, f"unbackticked identifier {token!r}"))
    return issues


class PublicDocsEditorialHygieneTests(unittest.TestCase):
    """Repository-wide and parser regression checks for published Markdown cleanliness."""

    def _assert_site_check_clean(self, checker, label: str) -> None:
        violations: list[str] = []
        for md_path in iter_published_markdown_files():
            rel = md_path.relative_to(SITE_ROOT).as_posix()
            text = md_path.read_text(encoding="utf-8")
            for line_no, detail in checker(text):
                violations.append(f"{rel}:{line_no}: {detail}")
        if violations:
            preview = "\n  ".join(violations[:60])
            suffix = f"\n  ... ({len(violations) - 60} more)" if len(violations) > 60 else ""
            self.fail(f"{label} found {len(violations)} violation(s):\n  {preview}{suffix}")

    def test_no_bare_figure_ref_without_custom_text(self) -> None:
        self._assert_site_check_clean(find_bare_figure_refs, "Bare figure {ref} check")

    def test_no_unescaped_underscores_in_math_text_macros(self) -> None:
        self._assert_site_check_clean(
            find_math_macro_underscore_errors, "Unescaped underscore in math text macro check"
        )

    def test_markdown_tables_have_consistent_pipe_counts(self) -> None:
        self._assert_site_check_clean(
            find_inconsistent_table_pipes, "Markdown table pipe consistency check"
        )

    def test_no_fake_qir_or_qualified_inputs_pseudocode(self) -> None:
        self._assert_site_check_clean(find_fake_qir_math, "Fake q_IR pseudocode check")

    def test_no_banned_editorial_headings_boilerplate_or_internal_docs_refs(self) -> None:
        self._assert_site_check_clean(
            find_banned_editorial_and_internal_refs,
            "Banned editorial headings, boilerplate, and internal docs/ check",
        )

    def test_no_bare_repository_paths_or_fm_identifiers(self) -> None:
        self._assert_site_check_clean(
            find_bare_paths_and_fm_identifiers,
            "Unbackticked repo paths and fm.* identifiers check",
        )

    def test_helpers_handle_fences_code_spans_urls_and_frontmatter(self) -> None:
        clean_sample = r"""---
title: Clean Sample
source_of_truth: docs/physics/0400-sample.md
---

See {numref}`fig-example` and {ref}`Fig. 1 custom <fig-example>`, plus {ref}`fm.connect() <live>`.
Use `packages/fullmag-py/src/fullmag/model/exchange.py`, `fm.study("demo")`, and
[`crates/fullmag-ir/src/lib.rs`](https://github.com/MateuszZelent/fullmag/blob/master/crates/fullmag-ir/src/lib.rs).
Logo asset: <img src="https://raw.githubusercontent.com/MateuszZelent/fullmag/master/docs/fullmag-logo-traced-optimized.svg" alt="logo">

```{figure} /_static/diagrams/example.svg
:alt: Diagram driven by fm.study and packages/fullmag-py/src/fullmag/model/exchange.py
:name: fig-example
:figclass: fm-physics-figure

Caption with `fm.Exchange(A=13e-12)` and $M_{\mathrm{s}}$ ($\mu_0\lvert\gamma_e\rvert$).
```

| Symbol | Formula | Unit |
| --- | --- | --- |
| $\gamma_{\mu_0}$ | $\mu_0\lvert\gamma_e\rvert$ | $\mathrm{m\,(A\,s)^{-1}}$ |
| `str \| None` | $\operatorname{sgn}(x)$ | $1$ |

```{math}
:label: eq-clean
E = \int_{\Omega} A \lvert \nabla \mathbf{m} \rvert^2 \, dV + \text{offset for $m_z$}
```

```python
# Fenced code is ignored for editorial prose checks:
# packages/fullmag-py/src/fullmag/world.py fm.study("x")
# docs/physics/internal.md
```
"""
        self.assertEqual(find_bare_figure_refs(clean_sample), [])
        self.assertEqual(find_math_macro_underscore_errors(clean_sample), [])
        self.assertEqual(find_inconsistent_table_pipes(clean_sample), [])
        self.assertEqual(find_fake_qir_math(clean_sample), [])
        self.assertEqual(find_banned_editorial_and_internal_refs(clean_sample), [])
        self.assertEqual(find_bare_paths_and_fm_identifiers(clean_sample), [])

    def test_helpers_catch_each_violation_kind(self) -> None:
        dirty_sample = r"""---
title: Dirty Sample
---

Bare fig ref {ref}`fig-broken` and unbackticked fm.study or packages/fullmag-py/src/a.py or
[crates/fullmag-ir/src/lib.rs](https://example.com/crates/fullmag-ir/src/lib.rs).
Inline math $q_{\mathrm{IR}} = \text{foo_bar}$ and `unmatched backtick.

## Publication rule
## Control Room crosswalk
### Python/API crosswalk
This is a navigation page referencing docs/physics/0100-foo.md and foo.source-map.json.
**Last changes: 12:00 01.01.2026**

| A | B |
| --- | --- |
| $x | y$ | ok |

```{math}
q_{\mathrm{IR}} = \operatorname{bad_op}(\text{qualified inputs})
```
"""
        self.assertEqual(len(find_bare_figure_refs(dirty_sample)), 1)
        self.assertEqual(len(find_math_macro_underscore_errors(dirty_sample)), 2)
        self.assertEqual(len(find_inconsistent_table_pipes(dirty_sample)), 1)
        self.assertEqual(len(find_fake_qir_math(dirty_sample)), 3)
        banned_hits = find_banned_editorial_and_internal_refs(dirty_sample)
        self.assertGreaterEqual(len(banned_hits), 7)
        self.assertTrue(any("Control Room crosswalk" in hit for _, hit in banned_hits))
        self.assertTrue(any("Python/API crosswalk" in hit for _, hit in banned_hits))
        self.assertEqual(len(find_bare_paths_and_fm_identifiers(dirty_sample)), 3)

    def test_iter_published_markdown_files_excludes_non_published_docs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            site = Path(tmp)
            (site / "_build").mkdir()
            (site / "internal").mkdir()
            (site / "generated").mkdir()
            (site / "physics").mkdir()
            (site / "_build" / "a.md").write_text("# ignored", encoding="utf-8")
            (site / "internal" / "b.md").write_text("# ignored", encoding="utf-8")
            (site / "generated" / "c.md").write_text("# ignored", encoding="utf-8")
            (site / "README.md").write_text("# ignored", encoding="utf-8")
            (site / "PAGE_TEMPLATE.md").write_text("# ignored", encoding="utf-8")
            (site / "physics" / "real.md").write_text("# Real", encoding="utf-8")

            found = iter_published_markdown_files(site_root=site)
            self.assertEqual(found, [site / "physics" / "real.md"])


if __name__ == "__main__":
    unittest.main()
