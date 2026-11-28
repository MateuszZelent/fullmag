"""Minimalist publication-grade scientific SVG canvas and drawing primitives.

Designed for *Nature* / *Physical Review B* / *AIP* aesthetics with zero UI card
chrome, zero drop shadows, transparent root canvas, semantic dual-theme color
resolution, proper SVG ``<tspan>`` mathematical sub/superscripts, exact 2D/polar
plots, 3D orthographic unit-sphere projection, and RK4 ODE integration.
"""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import math
from pathlib import Path
import re
from typing import Callable, Iterable, Iterator, Sequence
import xml.etree.ElementTree as ET

from .theme import (
    ARROW_TOKENS,
    FONT_MATH,
    FONT_MONO,
    FONT_SANS,
    THEMES,
    Theme,
    get_theme,
)

DEFAULT_DIAGRAMS_DIR = (
    Path(__file__).resolve().parents[2] / "public_docs" / "site" / "_static" / "diagrams"
)


# ---------------------------------------------------------------------------
# Formatting & XML-safe mathematical typography helpers
# ---------------------------------------------------------------------------


def _f(value: float) -> str:
    """Compact deterministic coordinate formatter (up to 2 decimals, no -0)."""
    rounded = round(float(value), 2)
    if rounded == 0.0:
        return "0"
    text = f"{rounded:.2f}".rstrip("0").rstrip(".")
    return text if text != "-0" else "0"


def esc(text: str) -> str:
    """Escape plain text for safe inclusion inside SVG XML elements/attributes."""
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def sub(text: str, *, upright: bool = True, size: str = "74%") -> str:
    """Return an XML-safe SVG subscript ``<tspan>`` fragment."""
    style = ' font-style="normal" font-weight="400"' if upright else ' font-style="italic" font-weight="400"'
    return f'<tspan baseline-shift="sub" font-size="{esc(size)}"{style}>{esc(text)}</tspan>'


def sup(text: str, *, upright: bool = True, size: str = "74%") -> str:
    """Return an XML-safe SVG superscript ``<tspan>`` fragment."""
    style = ' font-style="normal" font-weight="400"' if upright else ' font-style="italic" font-weight="400"'
    return f'<tspan baseline-shift="super" font-size="{esc(size)}"{style}>{esc(text)}</tspan>'


def roman(text: str) -> str:
    """Return upright (non-italic) ``<tspan>`` fragment inside italic math."""
    return f'<tspan font-style="normal" font-weight="400">{esc(text)}</tspan>'


def math_span(markup: str, *, bold: bool = False, italic: bool = True) -> str:
    """Embed math-font markup cleanly inside a sans-serif label."""
    style = "italic" if italic else "normal"
    weight = "700" if bold else "400"
    return (
        f'<tspan font-family="{esc(FONT_MATH)}" font-style="{style}" '
        f'font-weight="{weight}">{markup}</tspan>'
    )


def vec(
    letter: str,
    *,
    sub_text: str | None = None,
    sup_text: str | None = None,
    sub_upright: bool = True,
    sup_upright: bool = True,
) -> str:
    """Bold upright scientific vector symbol (e.g. ``vec("H", sub_text="eff")`` -> **H**_eff)."""
    out = f'<tspan font-style="normal" font-weight="700">{esc(letter)}</tspan>'
    if sub_text:
        out += sub(sub_text, upright=sub_upright)
    if sup_text:
        out += sup(sup_text, upright=sup_upright)
    return out


def hat(letter: str) -> str:
    """Bold upright unit vector with combining circumflex (e.g. ``hat("z")``)."""
    return f'<tspan font-style="normal" font-weight="700">{esc(letter)}&#x0302;</tspan>'


def sym(
    base: str,
    *,
    sub_text: str | None = None,
    sup_text: str | None = None,
    bold: bool = False,
    italic: bool = True,
    sub_italic: bool = False,
    sup_italic: bool = False,
) -> str:
    """General math symbol fragment with optional sub- and superscripts."""
    style = "italic" if italic else "normal"
    weight = "700" if bold else "400"
    out = f'<tspan font-style="{style}" font-weight="{weight}">{esc(base)}</tspan>'
    if sub_text:
        out += sub(sub_text, upright=not sub_italic)
    if sup_text:
        out += sup(sup_text, upright=not sup_italic)
    return out


_MATH_TOKEN_RE = re.compile(
    r"\\mathbf\{([^}]*)\}"
    r"|\\mathrm\{([^}]*)\}"
    r"|\\hat\{([^}]*)\}"
    r"|_\{([^}]*)\}"
    r"|\^\{([^}]*)\}"
    r"|_([A-Za-z0-9α-ωΑ-Ω±−+-])"
    r"|\^([A-Za-z0-9α-ωΑ-Ω±−+*′'-])"
)


def format_math(expr: str) -> str:
    """Convert lightweight TeX-like sub/superscripts into valid SVG ``<tspan>`` markup.

    Supports ``_{...}``, ``_x``, ``^{...}``, ``^x``, ``\\mathbf{...}``,
    ``\\mathrm{...}``, and ``\\hat{...}``. All literal text is XML-escaped so
    ``<``, ``>``, ``&`` never break XML parsing and raw underscores never leak.
    """
    parts: list[str] = []
    pos = 0
    for match in _MATH_TOKEN_RE.finditer(expr):
        if match.start() > pos:
            parts.append(esc(expr[pos : match.start()]))
        g_bf, g_rm, g_hat, g_sub_b, g_sup_b, g_sub_s, g_sup_s = match.groups()
        if g_bf is not None:
            parts.append(f'<tspan font-style="normal" font-weight="700">{esc(g_bf)}</tspan>')
        elif g_rm is not None:
            parts.append(roman(g_rm))
        elif g_hat is not None:
            parts.append(hat(g_hat))
        elif g_sub_b is not None:
            parts.append(sub(g_sub_b, upright=True))
        elif g_sup_b is not None:
            parts.append(sup(g_sup_b, upright=True))
        elif g_sub_s is not None:
            parts.append(sub(g_sub_s, upright=True))
        elif g_sup_s is not None:
            parts.append(sup(g_sup_s, upright=True))
        pos = match.end()
    if pos < len(expr):
        parts.append(esc(expr[pos:]))
    return "".join(parts)


# ---------------------------------------------------------------------------
# Core SvgCanvas
# ---------------------------------------------------------------------------


_MARKER_SIZES: dict[str, tuple[float, float]] = {
    "sm": (5.0, 5.0),
    "md": (6.6, 6.6),
    "lg": (8.2, 8.2),
}


class SvgCanvas:
    """Clean, transparent-canvas scientific SVG builder."""

    def __init__(
        self,
        width: float,
        height: float,
        theme: Theme | str = "light",
        *,
        title: str,
        desc: str,
        id_prefix: str = "",
    ) -> None:
        self.width = float(width)
        self.height = float(height)
        self.theme: Theme = get_theme(theme)
        self.title = title.strip()
        self.desc = desc.strip()
        self._id_prefix = id_prefix
        self._elements: list[str] = []
        self._extra_defs: list[str] = []
        self._markers: dict[tuple[str, str], str] = {}
        self._indent = 1
        self._clip_counter = 0

        if not self.title:
            raise ValueError("SvgCanvas requires a non-empty title")
        if not self.desc:
            raise ValueError("SvgCanvas requires a non-empty desc")

        # Pre-register markers for core semantic tokens so defs stay predictable.
        for token in ARROW_TOKENS:
            self._register_marker(token, "md")
            self._register_marker(token, "sm")

    def _pid(self, name: str) -> str:
        return f"{self._id_prefix}{name}" if self._id_prefix else name

    def resolve_color(self, color: str | None) -> str:
        """Resolve a Theme token name (e.g. 'm', 'H', 'flux') or pass through CSS/hex."""
        if color is None:
            return "none"
        token_val = self.theme.get(color)
        if token_val is not None:
            return token_val
        return color

    def _register_marker(self, color_or_token: str, size: str = "md") -> str:
        if size not in _MARKER_SIZES:
            raise ValueError(f"Unknown marker size {size!r}; expected one of {tuple(_MARKER_SIZES)}")
        hex_color = self.resolve_color(color_or_token)
        key = (hex_color, size)
        if key in self._markers:
            return self._markers[key]
        if self.theme.get(color_or_token) is not None:
            safe_name = color_or_token.replace("_", "-")
        else:
            safe_name = "c-" + re.sub(r"[^A-Za-z0-9]+", "", hex_color.lower())
        suffix = "" if size == "md" else f"-{size}"
        mid = self._pid(f"arr-{safe_name}{suffix}")
        # Ensure uniqueness if two distinct hex values collide in name
        if mid in self._markers.values():
            mid = f"{mid}-{len(self._markers)}"
        self._markers[key] = mid
        return mid

    def marker_id(self, color_or_token: str, size: str = "md") -> str:
        """Return the SVG marker id for ``color_or_token`` and ``size`` ('sm'|'md'|'lg')."""
        return self._register_marker(color_or_token, size=size)

    def marker_url(self, color_or_token: str, size: str = "md") -> str:
        """Return ``url(#...)`` for an arrowhead marker."""
        return f"url(#{self.marker_id(color_or_token, size=size)})"

    def add_def(self, xml: str) -> None:
        """Append custom markup into ``<defs>``."""
        self._extra_defs.append(xml)

    def add_clip_rect(
        self,
        x: float,
        y: float,
        w: float,
        h: float,
        *,
        clip_id: str | None = None,
        rx: float = 0.0,
    ) -> str:
        """Register a ``<clipPath>`` rectangle and return its id."""
        if clip_id is None:
            self._clip_counter += 1
            clip_id = self._pid(f"clip-{self._clip_counter}")
        rx_attr = f' rx="{_f(rx)}"' if rx > 0 else ""
        self.add_def(
            f'<clipPath id="{esc(clip_id)}">'
            f'<rect x="{_f(x)}" y="{_f(y)}" width="{_f(w)}" height="{_f(h)}"{rx_attr}/>'
            f"</clipPath>"
        )
        return clip_id

    def raw(self, xml: str) -> None:
        """Emit raw SVG element markup at current indentation."""
        pad = "  " * self._indent
        self._elements.append(f"{pad}{xml}")

    @contextmanager
    def layer(
        self,
        *,
        opacity: float | None = None,
        clip_path: str | None = None,
        transform: str | None = None,
        cls: str | None = None,
    ) -> Iterator[None]:
        """Group child elements in an SVG ``<g>``."""
        attrs: list[str] = []
        if cls:
            attrs.append(f'class="{esc(cls)}"')
        if opacity is not None:
            attrs.append(f'opacity="{_f(opacity)}"')
        if clip_path:
            ref = clip_path if clip_path.startswith("url(") else f"url(#{clip_path})"
            attrs.append(f'clip-path="{esc(ref)}"')
        if transform:
            attrs.append(f'transform="{esc(transform)}"')
        attr_str = (" " + " ".join(attrs)) if attrs else ""
        self.raw(f"<g{attr_str}>")
        self._indent += 1
        try:
            yield
        finally:
            self._indent -= 1
            self.raw("</g>")

    def line(
        self,
        x1: float,
        y1: float,
        x2: float,
        y2: float,
        *,
        stroke: str = "ink",
        stroke_width: float = 1.2,
        dash: str | None = None,
        opacity: float | None = None,
        marker_start: str | None = None,
        marker_end: str | None = None,
        linecap: str = "round",
    ) -> None:
        attrs = [
            f'x1="{_f(x1)}"',
            f'y1="{_f(y1)}"',
            f'x2="{_f(x2)}"',
            f'y2="{_f(y2)}"',
            f'stroke="{esc(self.resolve_color(stroke))}"',
            f'stroke-width="{_f(stroke_width)}"',
        ]
        if linecap:
            attrs.append(f'stroke-linecap="{esc(linecap)}"')
        if dash:
            attrs.append(f'stroke-dasharray="{esc(dash)}"')
        if opacity is not None:
            attrs.append(f'opacity="{_f(opacity)}"')
        if marker_start:
            attrs.append(f'marker-start="{esc(marker_start)}"')
        if marker_end:
            attrs.append(f'marker-end="{esc(marker_end)}"')
        self.raw(f"<line {' '.join(attrs)}/>")

    def rect(
        self,
        x: float,
        y: float,
        w: float,
        h: float,
        *,
        fill: str | None = "none",
        stroke: str | None = "none",
        stroke_width: float = 1.0,
        rx: float = 0.0,
        dash: str | None = None,
        opacity: float | None = None,
        fill_opacity: float | None = None,
    ) -> None:
        attrs = [
            f'x="{_f(x)}"',
            f'y="{_f(y)}"',
            f'width="{_f(w)}"',
            f'height="{_f(h)}"',
        ]
        if rx > 0:
            attrs.append(f'rx="{_f(rx)}"')
        attrs.append(f'fill="{esc(self.resolve_color(fill))}"')
        if fill_opacity is not None:
            attrs.append(f'fill-opacity="{_f(fill_opacity)}"')
        stroke_col = self.resolve_color(stroke)
        if stroke_col != "none":
            attrs.append(f'stroke="{esc(stroke_col)}"')
            attrs.append(f'stroke-width="{_f(stroke_width)}"')
        if dash:
            attrs.append(f'stroke-dasharray="{esc(dash)}"')
        if opacity is not None:
            attrs.append(f'opacity="{_f(opacity)}"')
        self.raw(f"<rect {' '.join(attrs)}/>")

    def circle(
        self,
        cx: float,
        cy: float,
        r: float,
        *,
        fill: str | None = "none",
        stroke: str | None = "none",
        stroke_width: float = 1.2,
        dash: str | None = None,
        opacity: float | None = None,
        fill_opacity: float | None = None,
    ) -> None:
        attrs = [
            f'cx="{_f(cx)}"',
            f'cy="{_f(cy)}"',
            f'r="{_f(r)}"',
            f'fill="{esc(self.resolve_color(fill))}"',
        ]
        if fill_opacity is not None:
            attrs.append(f'fill-opacity="{_f(fill_opacity)}"')
        stroke_col = self.resolve_color(stroke)
        if stroke_col != "none":
            attrs.append(f'stroke="{esc(stroke_col)}"')
            attrs.append(f'stroke-width="{_f(stroke_width)}"')
        if dash:
            attrs.append(f'stroke-dasharray="{esc(dash)}"')
        if opacity is not None:
            attrs.append(f'opacity="{_f(opacity)}"')
        self.raw(f"<circle {' '.join(attrs)}/>")

    def ellipse(
        self,
        cx: float,
        cy: float,
        rx: float,
        ry: float,
        *,
        fill: str | None = "none",
        stroke: str | None = "none",
        stroke_width: float = 1.2,
        dash: str | None = None,
        opacity: float | None = None,
        fill_opacity: float | None = None,
        transform: str | None = None,
    ) -> None:
        attrs = [
            f'cx="{_f(cx)}"',
            f'cy="{_f(cy)}"',
            f'rx="{_f(rx)}"',
            f'ry="{_f(ry)}"',
            f'fill="{esc(self.resolve_color(fill))}"',
        ]
        if fill_opacity is not None:
            attrs.append(f'fill-opacity="{_f(fill_opacity)}"')
        stroke_col = self.resolve_color(stroke)
        if stroke_col != "none":
            attrs.append(f'stroke="{esc(stroke_col)}"')
            attrs.append(f'stroke-width="{_f(stroke_width)}"')
        if dash:
            attrs.append(f'stroke-dasharray="{esc(dash)}"')
        if opacity is not None:
            attrs.append(f'opacity="{_f(opacity)}"')
        if transform:
            attrs.append(f'transform="{esc(transform)}"')
        self.raw(f"<ellipse {' '.join(attrs)}/>")

    def polygon(
        self,
        points: Sequence[tuple[float, float]],
        *,
        fill: str | None = "none",
        stroke: str | None = "none",
        stroke_width: float = 1.1,
        dash: str | None = None,
        opacity: float | None = None,
        fill_opacity: float | None = None,
        linejoin: str = "round",
    ) -> None:
        pts = " ".join(f"{_f(x)},{_f(y)}" for x, y in points)
        attrs = [f'points="{pts}"', f'fill="{esc(self.resolve_color(fill))}"']
        if fill_opacity is not None:
            attrs.append(f'fill-opacity="{_f(fill_opacity)}"')
        stroke_col = self.resolve_color(stroke)
        if stroke_col != "none":
            attrs.append(f'stroke="{esc(stroke_col)}"')
            attrs.append(f'stroke-width="{_f(stroke_width)}"')
            if linejoin:
                attrs.append(f'stroke-linejoin="{esc(linejoin)}"')
        if dash:
            attrs.append(f'stroke-dasharray="{esc(dash)}"')
        if opacity is not None:
            attrs.append(f'opacity="{_f(opacity)}"')
        self.raw(f"<polygon {' '.join(attrs)}/>")

    def polyline(
        self,
        points: Sequence[tuple[float, float]],
        *,
        stroke: str = "ink",
        stroke_width: float = 1.6,
        dash: str | None = None,
        opacity: float | None = None,
        fill: str | None = "none",
        marker_start: str | None = None,
        marker_end: str | None = None,
    ) -> None:
        pts = " ".join(f"{_f(x)},{_f(y)}" for x, y in points)
        attrs = [
            f'points="{pts}"',
            f'fill="{esc(self.resolve_color(fill))}"',
            f'stroke="{esc(self.resolve_color(stroke))}"',
            f'stroke-width="{_f(stroke_width)}"',
            'stroke-linecap="round"',
            'stroke-linejoin="round"',
        ]
        if dash:
            attrs.append(f'stroke-dasharray="{esc(dash)}"')
        if opacity is not None:
            attrs.append(f'opacity="{_f(opacity)}"')
        if marker_start:
            attrs.append(f'marker-start="{esc(marker_start)}"')
        if marker_end:
            attrs.append(f'marker-end="{esc(marker_end)}"')
        self.raw(f"<polyline {' '.join(attrs)}/>")

    def path(
        self,
        d: str,
        *,
        fill: str | None = "none",
        stroke: str | None = "none",
        stroke_width: float = 1.6,
        dash: str | None = None,
        opacity: float | None = None,
        fill_opacity: float | None = None,
        marker_start: str | None = None,
        marker_end: str | None = None,
        linecap: str = "round",
        linejoin: str = "round",
    ) -> None:
        attrs = [f'd="{d}"', f'fill="{esc(self.resolve_color(fill))}"']
        if fill_opacity is not None:
            attrs.append(f'fill-opacity="{_f(fill_opacity)}"')
        stroke_col = self.resolve_color(stroke)
        if stroke_col != "none":
            attrs.append(f'stroke="{esc(stroke_col)}"')
            attrs.append(f'stroke-width="{_f(stroke_width)}"')
            if linecap:
                attrs.append(f'stroke-linecap="{esc(linecap)}"')
            if linejoin:
                attrs.append(f'stroke-linejoin="{esc(linejoin)}"')
        if dash:
            attrs.append(f'stroke-dasharray="{esc(dash)}"')
        if opacity is not None:
            attrs.append(f'opacity="{_f(opacity)}"')
        if marker_start:
            attrs.append(f'marker-start="{esc(marker_start)}"')
        if marker_end:
            attrs.append(f'marker-end="{esc(marker_end)}"')
        self.raw(f"<path {' '.join(attrs)}/>")

    def text(
        self,
        x: float,
        y: float,
        content: str,
        *,
        cls: str = "fm-label",
        fill: str | None = None,
        size: float | None = None,
        weight: int | str | None = None,
        anchor: str = "start",
        baseline: str | None = None,
        italic: bool | None = None,
        font: str | None = None,
        raw_markup: bool = False,
        halo: bool = False,
        transform: str | None = None,
        opacity: float | None = None,
    ) -> None:
        attrs = [f'x="{_f(x)}"', f'y="{_f(y)}"']
        if cls:
            attrs.append(f'class="{esc(cls)}"')
        if anchor and anchor != "start":
            attrs.append(f'text-anchor="{esc(anchor)}"')
        if baseline:
            attrs.append(f'dominant-baseline="{esc(baseline)}"')
        # Use inline style for explicit typography/fill overrides so they always
        # beat the `.fm-*` stylesheet rules in the SVG/CSS cascade.
        style_parts: list[str] = []
        if fill is not None:
            resolved_fill = self.resolve_color(fill)
            attrs.append(f'fill="{esc(resolved_fill)}"')
            style_parts.append(f"fill:{resolved_fill}")
        if size is not None:
            size_str = _f(size)
            attrs.append(f'font-size="{size_str}"')
            style_parts.append(f"font-size:{size_str}px")
        if weight is not None:
            w_str = str(weight)
            attrs.append(f'font-weight="{esc(w_str)}"')
            style_parts.append(f"font-weight:{w_str}")
        if italic is not None:
            style_val = "italic" if italic else "normal"
            attrs.append(f'font-style="{style_val}"')
            style_parts.append(f"font-style:{style_val}")
        if font is not None:
            attrs.append(f'font-family="{esc(font)}"')
            style_parts.append(f"font-family:{font}")
        if style_parts:
            attrs.append(f'style="{esc(";".join(style_parts))}"')
        if halo:
            attrs.append('paint-order="stroke"')
            attrs.append(f'stroke="{esc(self.theme.surface_ref)}"')
            attrs.append('stroke-width="3.4"')
            attrs.append('stroke-linejoin="round"')
        if transform:
            attrs.append(f'transform="{esc(transform)}"')
        if opacity is not None:
            attrs.append(f'opacity="{_f(opacity)}"')
        body = content if raw_markup else esc(content)
        self.raw(f"<text {' '.join(attrs)}>{body}</text>")

    def math_text(
        self,
        x: float,
        y: float,
        markup: str,
        *,
        fill: str | None = None,
        size: float = 12.5,
        bold: bool = False,
        italic: bool = True,
        anchor: str = "start",
        baseline: str | None = None,
        halo: bool = False,
        transform: str | None = None,
        auto_format: bool = False,
    ) -> None:
        """Render italic math-serif SVG text with ``<tspan>`` sub/superscripts.

        Pass prebuilt markup from ``sub()``, ``sup()``, ``vec()``, ``sym()``,
        ``format_math()``, OR set ``auto_format=True`` to parse ``_{...}`` /
        ``^{...}`` / ``\\mathbf{...}`` automatically.
        """
        rendered = format_math(markup) if auto_format else markup
        cls = "fm-math-bold" if bold else "fm-math"
        self.text(
            x,
            y,
            rendered,
            cls=cls,
            fill=fill,
            size=size,
            weight=700 if bold else 400,
            anchor=anchor,
            baseline=baseline,
            italic=italic,
            font=FONT_MATH,
            raw_markup=True,
            halo=halo,
            transform=transform,
        )

    def text_lines(
        self,
        x: float,
        y: float,
        lines: Sequence[str],
        *,
        line_height: float = 15.0,
        cls: str = "fm-sub",
        fill: str | None = None,
        size: float | None = None,
        weight: int | str | None = None,
        anchor: str = "start",
        raw_markup: bool = False,
        halo: bool = False,
    ) -> None:
        """Render multiple stacked text lines with consistent baseline spacing."""
        for idx, line in enumerate(lines):
            self.text(
                x,
                y + idx * line_height,
                line,
                cls=cls,
                fill=fill,
                size=size,
                weight=weight,
                anchor=anchor,
                raw_markup=raw_markup,
                halo=halo,
            )

    def _build_defs(self) -> list[str]:
        t = self.theme
        defs: list[str] = ["  <defs>"]
        defs.append("    <style>")
        defs.append(f"      .fm-panel-letter {{ font: 700 15px {FONT_SANS}; fill: {t.ink}; }}")
        defs.append(f"      .fm-panel-title {{ font: 600 12.5px {FONT_SANS}; fill: {t.ink}; }}")
        defs.append(f"      .fm-label {{ font: 500 11.8px {FONT_SANS}; fill: {t.ink}; }}")
        defs.append(f"      .fm-label-bold {{ font: 600 11.8px {FONT_SANS}; fill: {t.ink}; }}")
        defs.append(f"      .fm-sub {{ font: 400 11px {FONT_SANS}; fill: {t.ink_secondary}; }}")
        defs.append(f"      .fm-note {{ font: 400 10.4px {FONT_SANS}; fill: {t.ink_muted}; }}")
        defs.append(f"      .fm-tick {{ font: 400 10.4px {FONT_SANS}; fill: {t.ink_muted}; }}")
        defs.append(f"      .fm-math {{ font: italic 12.5px {FONT_MATH}; fill: {t.ink}; }}")
        defs.append(f"      .fm-math-sm {{ font: italic 11.2px {FONT_MATH}; fill: {t.ink_secondary}; }}")
        defs.append(f"      .fm-math-bold {{ font: italic 700 13px {FONT_MATH}; fill: {t.ink}; }}")
        defs.append(f"      .fm-code {{ font: 500 10.6px {FONT_MONO}; fill: {t.ink_secondary}; }}")
        defs.append("    </style>")

        # Sleek dart-shaped scientific arrowheads (minimal, crisp, publication-grade)
        for (hex_color, size), mid in self._markers.items():
            mw, mh = _MARKER_SIZES[size]
            defs.append(
                f'    <marker id="{esc(mid)}" viewBox="0 0 10 10" refX="8.2" refY="5" '
                f'markerWidth="{_f(mw)}" markerHeight="{_f(mh)}" orient="auto-start-reverse">'
                f'<path d="M 0.5 1.6 L 9.2 5 L 0.5 8.4 L 2.2 5 z" fill="{esc(hex_color)}"/>'
                f"</marker>"
            )

        # Subtle theme-calibrated hatching patterns
        hatch_specs = (
            ("hatch-warm", t.accent_warm, 45, 0.24),
            ("hatch-cool", t.H, -45, 0.22),
            ("hatch-muted", t.air_stroke, -45, 0.24),
            ("hatch-fm", t.fm_stroke, 45, 0.22),
            ("hatch-flux", t.flux, 45, 0.22),
        )
        for hid, hcolor, angle, op in hatch_specs:
            defs.append(
                f'    <pattern id="{esc(self._pid(hid))}" width="7" height="7" '
                f'patternTransform="rotate({angle} 0 0)" patternUnits="userSpaceOnUse">'
                f'<line x1="0" y1="0" x2="0" y2="7" stroke="{esc(hcolor)}" '
                f'stroke-width="1.1" stroke-opacity="{_f(op)}"/></pattern>'
            )

        # Subtle minimalist 3D sphere shading gradient
        defs.append(
            f'    <radialGradient id="{esc(self._pid("sphere-grad"))}" cx="36%" cy="30%" r="70%">'
            f'<stop offset="0%" stop-color="{esc(t.sphere_grad_0)}" stop-opacity="0.82"/>'
            f'<stop offset="62%" stop-color="{esc(t.sphere_grad_1)}" stop-opacity="0.58"/>'
            f'<stop offset="100%" stop-color="{esc(t.sphere_grad_2)}" stop-opacity="0.45"/>'
            f"</radialGradient>"
        )

        for extra in self._extra_defs:
            defs.append(f"    {extra}")
        defs.append("  </defs>")
        return defs

    def to_svg(self) -> str:
        """Serialize the complete self-contained transparent SVG document."""
        title_id = self._pid("title")
        desc_id = self._pid("desc")
        lines = [
            f'<svg xmlns="http://www.w3.org/2000/svg" '
            f'viewBox="0 0 {_f(self.width)} {_f(self.height)}" '
            f'width="100%" role="img" aria-labelledby="{esc(title_id)} {esc(desc_id)}">',
            f'  <title id="{esc(title_id)}">{esc(self.title)}</title>',
            f'  <desc id="{esc(desc_id)}">{esc(self.desc)}</desc>',
        ]
        lines.extend(self._build_defs())
        lines.extend(self._elements)
        lines.append("</svg>")
        return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# Minimalist panel headers & dividers (NO boxes, NO pill badges!)
# ---------------------------------------------------------------------------


def panel_label(
    c: SvgCanvas,
    x: float,
    y: float,
    letter: str,
    title: str | None = None,
    *,
    subtitle: str | None = None,
    title_markup: bool = False,
    subtitle_markup: bool = False,
) -> None:
    """Nature / Physical Review B bare bold panel label (``a``, ``b``, ``c``).

    Zero pill boxes, zero parentheses, zero surrounding borders.
    """
    clean_letter = letter.strip().strip("()")
    c.text(x, y, clean_letter, cls="fm-panel-letter")
    if title:
        c.text(
            x + 17.0,
            y,
            title,
            cls="fm-panel-title",
            raw_markup=title_markup,
        )
    if subtitle:
        c.text(
            x + 17.0,
            y + 15.5,
            subtitle,
            cls="fm-note",
            raw_markup=subtitle_markup,
        )


def panel_divider(
    c: SvgCanvas,
    x1: float,
    y1: float,
    x2: float,
    y2: float,
    *,
    dashed: bool = False,
    opacity: float = 0.55,
) -> None:
    """Delicate hairline rule separating panels without box clutter."""
    c.line(
        x1,
        y1,
        x2,
        y2,
        stroke="hairline",
        stroke_width=0.85,
        dash="4,3.5" if dashed else None,
        opacity=opacity,
    )


# ---------------------------------------------------------------------------
# Vectors, arrows, spins, and physics symbols
# ---------------------------------------------------------------------------


def vector_arrow(
    c: SvgCanvas,
    x1: float,
    y1: float,
    x2: float,
    y2: float,
    *,
    color: str = "ink",
    width: float = 2.0,
    size: str = "md",
    dash: str | None = None,
    double: bool = False,
    label: str | None = None,
    label_pos: tuple[float, float] | None = None,
    label_offset: tuple[float, float] = (0.0, -8.0),
    label_anchor: str = "middle",
    math_label: bool = True,
    halo: bool = False,
    opacity: float | None = None,
) -> None:
    """Draw a crisp scientific vector arrow with optional math or text label."""
    m_url = c.marker_url(color, size=size)
    c.line(
        x1,
        y1,
        x2,
        y2,
        stroke=color,
        stroke_width=width,
        dash=dash,
        opacity=opacity,
        marker_start=m_url if double else None,
        marker_end=m_url,
    )
    if label:
        if label_pos is not None:
            lx, ly = label_pos
        else:
            lx = 0.5 * (x1 + x2) + label_offset[0]
            ly = 0.5 * (y1 + y2) + label_offset[1]
        if math_label:
            c.math_text(lx, ly, label, fill=color, anchor=label_anchor, halo=halo)
        else:
            c.text(lx, ly, label, cls="fm-sub", fill=color, anchor=label_anchor, halo=halo)


def curved_arrow(
    c: SvgCanvas,
    x1: float,
    y1: float,
    cx: float,
    cy: float,
    x2: float,
    y2: float,
    *,
    color: str = "ink",
    width: float = 1.8,
    size: str = "md",
    dash: str | None = None,
    double: bool = False,
    opacity: float | None = None,
) -> None:
    """Draw a smooth quadratic Bézier arrow from ``(x1, y1)`` via ``(cx, cy)`` to ``(x2, y2)``."""
    m_url = c.marker_url(color, size=size)
    d = f"M {_f(x1)} {_f(y1)} Q {_f(cx)} {_f(cy)} {_f(x2)} {_f(y2)}"
    c.path(
        d,
        stroke=color,
        stroke_width=width,
        dash=dash,
        opacity=opacity,
        marker_start=m_url if double else None,
        marker_end=m_url,
    )


def arc_arrow(
    c: SvgCanvas,
    cx: float,
    cy: float,
    r: float,
    start_deg: float,
    end_deg: float,
    *,
    color: str = "ink",
    width: float = 1.8,
    size: str = "md",
    dash: str | None = None,
    double: bool = False,
    opacity: float | None = None,
) -> None:
    """Draw a circular arc arrow in screen coordinates (degrees, 0=right, 90=down)."""
    a1 = math.radians(start_deg)
    a2 = math.radians(end_deg)
    x1, y1 = cx + r * math.cos(a1), cy + r * math.sin(a1)
    x2, y2 = cx + r * math.cos(a2), cy + r * math.sin(a2)
    delta = end_deg - start_deg
    large_arc = 1 if abs(delta) > 180.0 else 0
    sweep = 1 if delta >= 0 else 0
    m_url = c.marker_url(color, size=size)
    d = f"M {_f(x1)} {_f(y1)} A {_f(r)} {_f(r)} 0 {large_arc} {sweep} {_f(x2)} {_f(y2)}"
    c.path(
        d,
        stroke=color,
        stroke_width=width,
        dash=dash,
        opacity=opacity,
        marker_start=m_url if double else None,
        marker_end=m_url,
    )


def spin_arrow(
    c: SvgCanvas,
    cx: float,
    cy: float,
    angle_deg: float,
    *,
    length: float = 20.0,
    color: str = "m",
    width: float = 1.8,
    size: str = "sm",
    center_dot: bool = False,
    opacity: float | None = None,
) -> None:
    """Draw a centered magnetic moment arrow at ``(cx, cy)``.

    Angle convention is standard mathematical Cartesian: ``0°`` points right (+x),
    ``90°`` points up (+y / -SVG y), ``180°`` points left (-x), ``-90°`` down.
    """
    rad = math.radians(angle_deg)
    half = 0.5 * length
    dx = half * math.cos(rad)
    dy = -half * math.sin(rad)
    c.line(
        cx - dx,
        cy - dy,
        cx + dx,
        cy + dy,
        stroke=color,
        stroke_width=width,
        opacity=opacity,
        marker_end=c.marker_url(color, size=size),
    )
    if center_dot:
        c.circle(cx, cy, max(1.6, width * 0.9), fill=color, opacity=opacity)


def out_of_plane_symbol(
    c: SvgCanvas,
    cx: float,
    cy: float,
    *,
    direction: str = "out",
    r: float = 7.0,
    color: str = "H",
    width: float = 1.4,
    fill: str | None = None,
) -> None:
    """Draw standard physics out-of-page (dot, ``direction="out"``) or into-page (cross, ``"in"``)."""
    bg = fill if fill is not None else c.theme.surface_ref
    c.circle(cx, cy, r, fill=bg, stroke=color, stroke_width=width)
    if direction == "out":
        c.circle(cx, cy, max(1.8, r * 0.28), fill=color)
    elif direction == "in":
        d = r * 0.56
        c.line(cx - d, cy - d, cx + d, cy + d, stroke=color, stroke_width=width)
        c.line(cx - d, cy + d, cx + d, cy - d, stroke=color, stroke_width=width)
    else:
        raise ValueError(f"direction must be 'out' or 'in', got {direction!r}")


# ---------------------------------------------------------------------------
# Curves, 2D scientific axes, and polar plots
# ---------------------------------------------------------------------------


def curve_path(
    points: Sequence[tuple[float, float]],
    *,
    closed: bool = False,
    smooth: bool = False,
) -> str:
    """Build an SVG path ``d`` string from ``[(x, y), ...]``."""
    pts = list(points)
    if not pts:
        return ""
    if len(pts) == 1:
        x, y = pts[0]
        return f"M {_f(x)} {_f(y)}"
    if not smooth or len(pts) < 3:
        cmds = [f"M {_f(pts[0][0])} {_f(pts[0][1])}"]
        cmds.extend(f"L {_f(x)} {_f(y)}" for x, y in pts[1:])
        if closed:
            cmds.append("Z")
        return " ".join(cmds)

    # Catmull-Rom to cubic Bézier smoothing
    n = len(pts)
    cmds = [f"M {_f(pts[0][0])} {_f(pts[0][1])}"]
    seg_count = n if closed else n - 1
    for i in range(seg_count):
        p0 = pts[(i - 1) % n] if closed else pts[max(0, i - 1)]
        p1 = pts[i % n]
        p2 = pts[(i + 1) % n]
        p3 = pts[(i + 2) % n] if closed else pts[min(n - 1, i + 2)]
        c1x = p1[0] + (p2[0] - p0[0]) / 6.0
        c1y = p1[1] + (p2[1] - p0[1]) / 6.0
        c2x = p2[0] - (p3[0] - p1[0]) / 6.0
        c2y = p2[1] - (p3[1] - p1[1]) / 6.0
        cmds.append(
            f"C {_f(c1x)} {_f(c1y)} {_f(c2x)} {_f(c2y)} {_f(p2[0])} {_f(p2[1])}"
        )
    if closed:
        cmds.append("Z")
    return " ".join(cmds)


@dataclass(frozen=True)
class PlotFrame:
    """Coordinate mapper and plotting helpers returned by ``axes_2d``."""

    canvas: SvgCanvas
    x0: float
    y0: float
    width: float
    height: float
    xlim: tuple[float, float]
    ylim: tuple[float, float]
    clip_id: str

    def px(self, x: float) -> float:
        lo, hi = self.xlim
        return self.x0 + (x - lo) / (hi - lo) * self.width

    def py(self, y: float) -> float:
        lo, hi = self.ylim
        return self.y0 + self.height - (y - lo) / (hi - lo) * self.height

    def pt(self, x: float, y: float) -> tuple[float, float]:
        return (self.px(x), self.py(y))

    def plot_curve(
        self,
        xs: Sequence[float],
        ys: Sequence[float],
        *,
        color: str = "H",
        width: float = 2.0,
        dash: str | None = None,
        opacity: float | None = None,
        smooth: bool = False,
        clip: bool = True,
    ) -> None:
        pts = [self.pt(x, y) for x, y in zip(xs, ys)]
        d = curve_path(pts, smooth=smooth)
        if clip:
            with self.canvas.layer(clip_path=self.clip_id):
                self.canvas.path(d, stroke=color, stroke_width=width, dash=dash, opacity=opacity)
        else:
            self.canvas.path(d, stroke=color, stroke_width=width, dash=dash, opacity=opacity)

    def fill_between(
        self,
        xs: Sequence[float],
        ys1: Sequence[float],
        ys2: Sequence[float] | float = 0.0,
        *,
        fill: str = "H_soft",
        opacity: float = 0.45,
        clip: bool = True,
    ) -> None:
        xs_list = list(xs)
        ys1_list = list(ys1)
        if isinstance(ys2, (int, float)):
            ys2_list = [float(ys2)] * len(xs_list)
        else:
            ys2_list = list(ys2)
        upper = [self.pt(x, y) for x, y in zip(xs_list, ys1_list)]
        lower = [self.pt(x, y) for x, y in zip(reversed(xs_list), reversed(ys2_list))]
        pts = upper + lower
        if clip:
            with self.canvas.layer(clip_path=self.clip_id):
                self.canvas.polygon(pts, fill=fill, fill_opacity=opacity)
        else:
            self.canvas.polygon(pts, fill=fill, fill_opacity=opacity)

    def scatter(
        self,
        xs: Sequence[float],
        ys: Sequence[float],
        *,
        r: float = 3.2,
        fill: str = "m",
        stroke: str | None = "surface_ref",
        stroke_width: float = 1.0,
        opacity: float | None = None,
    ) -> None:
        for x, y in zip(xs, ys):
            sx, sy = self.pt(x, y)
            self.canvas.circle(
                sx,
                sy,
                r,
                fill=fill,
                stroke=stroke,
                stroke_width=stroke_width,
                opacity=opacity,
            )

    def vline(
        self,
        x: float,
        *,
        color: str = "hairline",
        width: float = 1.0,
        dash: str | None = "4,3",
        label: str | None = None,
        label_y: float | None = None,
        label_anchor: str = "start",
        math_label: bool = True,
    ) -> None:
        sx = self.px(x)
        self.canvas.line(sx, self.y0, sx, self.y0 + self.height, stroke=color, stroke_width=width, dash=dash)
        if label:
            ly = label_y if label_y is not None else self.y0 + 13.0
            dx = 4.0 if label_anchor == "start" else (-4.0 if label_anchor == "end" else 0.0)
            if math_label:
                self.canvas.math_text(sx + dx, ly, label, fill=color, size=11.0, anchor=label_anchor, halo=True)
            else:
                self.canvas.text(sx + dx, ly, label, cls="fm-note", fill=color, anchor=label_anchor, halo=True)

    def hline(
        self,
        y: float,
        *,
        color: str = "hairline",
        width: float = 1.0,
        dash: str | None = "4,3",
        label: str | None = None,
        label_x: float | None = None,
        label_anchor: str = "end",
        math_label: bool = True,
    ) -> None:
        sy = self.py(y)
        self.canvas.line(self.x0, sy, self.x0 + self.width, sy, stroke=color, stroke_width=width, dash=dash)
        if label:
            lx = label_x if label_x is not None else self.x0 + self.width - 4.0
            if math_label:
                self.canvas.math_text(lx, sy - 4.5, label, fill=color, size=11.0, anchor=label_anchor, halo=True)
            else:
                self.canvas.text(lx, sy - 4.5, label, cls="fm-note", fill=color, anchor=label_anchor, halo=True)


def axes_2d(
    c: SvgCanvas,
    x0: float,
    y0: float,
    width: float,
    height: float,
    *,
    xlim: tuple[float, float] = (0.0, 1.0),
    ylim: tuple[float, float] = (0.0, 1.0),
    xlabel: str | None = None,
    ylabel: str | None = None,
    xticks: Sequence[float] | None = None,
    yticks: Sequence[float] | None = None,
    xtick_labels: Sequence[str] | None = None,
    ytick_labels: Sequence[str] | None = None,
    grid: bool = False,
    zero_lines: bool = False,
    box: bool = False,
    arrow_axes: bool = False,
    math_labels: bool = True,
    xlabel_offset: float = 30.0,
    ylabel_offset: float = 36.0,
) -> PlotFrame:
    """Draw minimalist publication-grade 2D scientific axes and return a ``PlotFrame``."""
    clip_id = c.add_clip_rect(x0, y0, width, height)
    frame = PlotFrame(
        canvas=c,
        x0=x0,
        y0=y0,
        width=width,
        height=height,
        xlim=xlim,
        ylim=ylim,
        clip_id=clip_id,
    )

    x_right = x0 + width
    y_bot = y0 + height

    # Optional subtle gridlines
    if grid:
        if xticks:
            for xv in xticks:
                sx = frame.px(xv)
                if x0 + 0.5 < sx < x_right - 0.5:
                    c.line(sx, y0, sx, y_bot, stroke="grid", stroke_width=0.75)
        if yticks:
            for yv in yticks:
                sy = frame.py(yv)
                if y0 + 0.5 < sy < y_bot - 0.5:
                    c.line(x0, sy, x_right, sy, stroke="grid", stroke_width=0.75)

    # Optional zero reference lines
    if zero_lines:
        if xlim[0] < 0.0 < xlim[1]:
            sx0 = frame.px(0.0)
            c.line(sx0, y0, sx0, y_bot, stroke="hairline", stroke_width=0.9, dash="3,3")
        if ylim[0] < 0.0 < ylim[1]:
            sy0 = frame.py(0.0)
            c.line(x0, sy0, x_right, sy0, stroke="hairline", stroke_width=0.9, dash="3,3")

    # Axes spines (clean L-frame by default; optional full box or arrow tips)
    if box:
        c.rect(x0, y0, width, height, fill="none", stroke="axis", stroke_width=1.05)
    else:
        m_axis = c.marker_url("axis", size="sm") if arrow_axes else None
        c.line(x0, y_bot, x_right + (6.0 if arrow_axes else 0.0), y_bot, stroke="axis", stroke_width=1.15, marker_end=m_axis)
        c.line(x0, y_bot, x0, y0 - (6.0 if arrow_axes else 0.0), stroke="axis", stroke_width=1.15, marker_end=m_axis)

    # X ticks & labels (short crisp outward ticks)
    if xticks is not None:
        labels = list(xtick_labels) if xtick_labels is not None else [_f(v) for v in xticks]
        for xv, lbl in zip(xticks, labels):
            sx = frame.px(xv)
            c.line(sx, y_bot, sx, y_bot + 4.0, stroke="axis", stroke_width=1.0)
            if lbl:
                c.text(sx, y_bot + 15.0, lbl, cls="fm-tick", anchor="middle", raw_markup="<tspan" in lbl)

    # Y ticks & labels
    if yticks is not None:
        labels = list(ytick_labels) if ytick_labels is not None else [_f(v) for v in yticks]
        for yv, lbl in zip(yticks, labels):
            sy = frame.py(yv)
            c.line(x0 - 4.0, sy, x0, sy, stroke="axis", stroke_width=1.0)
            if lbl:
                c.text(
                    x0 - 7.0,
                    sy + 3.5,
                    lbl,
                    cls="fm-tick",
                    anchor="end",
                    raw_markup="<tspan" in lbl,
                )

    # Axis titles
    if xlabel:
        ex, ey = x0 + 0.5 * width, y_bot + xlabel_offset
        if math_labels:
            c.math_text(ex, ey, xlabel, fill="ink_secondary", size=11.8, anchor="middle")
        else:
            c.text(ex, ey, xlabel, cls="fm-sub", anchor="middle", raw_markup="<tspan" in xlabel)
    if ylabel:
        lx, ly = x0 - ylabel_offset, y0 + 0.5 * height
        rot = f"rotate(-90 {_f(lx)} {_f(ly)})"
        if math_labels:
            c.math_text(lx, ly, ylabel, fill="ink_secondary", size=11.8, anchor="middle", transform=rot)
        else:
            c.text(
                lx,
                ly,
                ylabel,
                cls="fm-sub",
                anchor="middle",
                transform=rot,
                raw_markup="<tspan" in ylabel,
            )

    return frame


def polar_axes(
    c: SvgCanvas,
    cx: float,
    cy: float,
    r_max: float,
    *,
    rings: Sequence[float] = (0.5, 1.0),
    spokes_deg: Sequence[float] = (0.0, 45.0, 90.0, 135.0, 180.0, 225.0, 270.0, 315.0),
    axis_labels: Sequence[tuple[float, str]] | None = None,
    math_labels: bool = True,
) -> None:
    """Draw clean minimalist polar coordinate grid (rings + radial spokes)."""
    for frac in rings:
        c.circle(
            cx,
            cy,
            r_max * frac,
            fill="none",
            stroke="grid" if frac < 0.99 else "hairline",
            stroke_width=0.8 if frac < 0.99 else 0.95,
            dash="3,3" if frac < 0.99 else None,
        )
    for deg in spokes_deg:
        rad = math.radians(deg)
        c.line(
            cx,
            cy,
            cx + r_max * math.cos(rad),
            cy - r_max * math.sin(rad),
            stroke="grid",
            stroke_width=0.75,
        )
    if axis_labels:
        for deg, lbl in axis_labels:
            rad = math.radians(deg)
            lx = cx + (r_max + 15.0) * math.cos(rad)
            ly = cy - (r_max + 15.0) * math.sin(rad) + 4.0
            anchor = "middle"
            if math.cos(rad) > 0.35:
                anchor = "start"
            elif math.cos(rad) < -0.35:
                anchor = "end"
            if math_labels:
                c.math_text(lx, ly, lbl, fill="ink_secondary", size=11.2, anchor=anchor)
            else:
                c.text(lx, ly, lbl, cls="fm-note", anchor=anchor, raw_markup="<tspan" in lbl)


def polar_curve(
    c: SvgCanvas,
    cx: float,
    cy: float,
    r_max: float,
    angles_rad: Sequence[float],
    radii: Sequence[float],
    *,
    r_scale: float | None = None,
    color: str = "H",
    width: float = 2.0,
    fill: str | None = None,
    fill_opacity: float = 0.14,
    dash: str | None = None,
    closed: bool = True,
) -> None:
    """Plot an exact mathematical polar curve ``r(angle)`` (angle=0 right, pi/2 up)."""
    rad_vals = list(radii)
    scale = r_scale if r_scale is not None else (max(abs(v) for v in rad_vals) or 1.0)
    pts = [
        (cx + (r / scale) * r_max * math.cos(a), cy - (r / scale) * r_max * math.sin(a))
        for a, r in zip(angles_rad, rad_vals)
    ]
    d = curve_path(pts, closed=closed)
    c.path(
        d,
        fill=fill if fill is not None else "none",
        fill_opacity=fill_opacity if fill is not None else None,
        stroke=color,
        stroke_width=width,
        dash=dash,
    )


# ---------------------------------------------------------------------------
# 3D Orthographic projection, unit sphere S^2, and RK4 ODE integrator
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class OrthoProj:
    """Right-handed 3D orthographic projection onto 2D SVG coordinates.

    Convention: ``+z`` points vertically up on screen; ``azim_deg`` rotates
    viewpoint around ``z`` from ``+x`` toward ``+y``; ``elev_deg`` tilts camera
    above the ``xy`` equatorial plane. Returns ``(sx, sy, depth)`` where
    ``depth > 0`` lies on the front (camera-facing) hemisphere.
    """

    cx: float
    cy: float
    radius: float
    azim_deg: float = 32.0
    elev_deg: float = 20.0

    def project(self, x: float, y: float, z: float) -> tuple[float, float, float]:
        az = math.radians(self.azim_deg)
        el = math.radians(self.elev_deg)
        ca, sa = math.cos(az), math.sin(az)
        ce, se = math.cos(el), math.sin(el)
        # Camera basis:
        #   right = (-sin az, cos az, 0)
        #   up    = (-cos az * sin el, -sin az * sin el, cos el)
        #   view  = (cos az * cos el, sin az * cos el, sin el)
        rx = -sa * x + ca * y
        ry = -ca * se * x - sa * se * y + ce * z
        depth = ca * ce * x + sa * ce * y + se * z
        return (self.cx + self.radius * rx, self.cy - self.radius * ry, depth)

    def pt2(self, v: Sequence[float]) -> tuple[float, float]:
        sx, sy, _ = self.project(v[0], v[1], v[2])
        return (sx, sy)


def ortho_project(
    v: Sequence[float],
    *,
    cx: float,
    cy: float,
    radius: float,
    azim_deg: float = 32.0,
    elev_deg: float = 20.0,
) -> tuple[float, float, float]:
    """Project a single 3D vector ``v=(x, y, z)`` via ``OrthoProj``."""
    return OrthoProj(cx, cy, radius, azim_deg=azim_deg, elev_deg=elev_deg).project(v[0], v[1], v[2])


def sphere_curve(
    c: SvgCanvas,
    proj: OrthoProj,
    points_3d: Sequence[Sequence[float]],
    *,
    color: str = "flux",
    width: float = 2.0,
    back_color: str | None = None,
    back_width: float | None = None,
    back_opacity: float = 0.35,
    back_dash: str | None = "3.5,3",
    front_dash: str | None = None,
    front_opacity: float | None = None,
) -> None:
    """Draw a 3D curve on ``S^2``, splitting cleanly into front (solid) and back (dashed)."""
    if len(points_3d) < 2:
        return
    projected = [proj.project(p[0], p[1], p[2]) for p in points_3d]
    runs: list[tuple[bool, list[tuple[float, float]]]] = []
    cur_front = projected[0][2] >= 0.0
    cur_pts: list[tuple[float, float]] = [(projected[0][0], projected[0][1])]
    for sx, sy, depth in projected[1:]:
        is_front = depth >= 0.0
        if is_front != cur_front:
            cur_pts.append((sx, sy))
            runs.append((cur_front, cur_pts))
            cur_front = is_front
            cur_pts = [(sx, sy)]
        else:
            cur_pts.append((sx, sy))
    if len(cur_pts) >= 2:
        runs.append((cur_front, cur_pts))

    b_col = back_color if back_color is not None else color
    b_w = back_width if back_width is not None else max(0.9, width * 0.72)

    # Render back segments first, then front segments on top
    for is_front, pts in runs:
        if not is_front:
            c.path(
                curve_path(pts),
                stroke=b_col,
                stroke_width=b_w,
                dash=back_dash,
                opacity=back_opacity,
            )
    for is_front, pts in runs:
        if is_front:
            c.path(
                curve_path(pts),
                stroke=color,
                stroke_width=width,
                dash=front_dash,
                opacity=front_opacity,
            )


def unit_sphere(
    c: SvgCanvas,
    cx: float,
    cy: float,
    radius: float,
    *,
    azim_deg: float = 32.0,
    elev_deg: float = 20.0,
    meridians_deg: Sequence[float] = (0.0, 90.0),
    latitudes_deg: Sequence[float] = (0.0,),
    axes: bool = True,
    axis_labels: tuple[str, str, str] | None = ("x", "y", "z"),
    shaded: bool = True,
    samples: int = 120,
) -> OrthoProj:
    """Draw a clean, minimalist publication-grade 3D unit sphere ``S^2``."""
    proj = OrthoProj(cx=cx, cy=cy, radius=radius, azim_deg=azim_deg, elev_deg=elev_deg)
    fill_val = f"url(#{c._pid('sphere-grad')})" if shaded else "none"
    c.circle(cx, cy, radius, fill=fill_val, stroke="sphere_stroke", stroke_width=1.25)

    # Latitude circles (equator highlighted slightly over other parallels)
    for lat_deg in latitudes_deg:
        lat = math.radians(lat_deg)
        cl, sl = math.cos(lat), math.sin(lat)
        pts = [
            (cl * math.cos(2.0 * math.pi * k / samples), cl * math.sin(2.0 * math.pi * k / samples), sl)
            for k in range(samples + 1)
        ]
        is_eq = abs(lat_deg) < 1e-6
        sphere_curve(
            c,
            proj,
            pts,
            color="sphere_wire",
            width=1.05 if is_eq else 0.75,
            back_color="sphere_wire_back",
            back_width=0.85 if is_eq else 0.65,
            back_opacity=0.85,
            back_dash="3.5,3.5",
        )

    # Meridians
    for phi_deg in meridians_deg:
        phi = math.radians(phi_deg)
        cp, sp = math.cos(phi), math.sin(phi)
        pts = [
            (math.sin(2.0 * math.pi * k / samples) * cp, math.sin(2.0 * math.pi * k / samples) * sp, math.cos(2.0 * math.pi * k / samples))
            for k in range(samples + 1)
        ]
        sphere_curve(
            c,
            proj,
            pts,
            color="sphere_wire",
            width=0.8,
            back_color="sphere_wire_back",
            back_width=0.65,
            back_opacity=0.75,
            back_dash="3,3.5",
        )

    # Minimalist coordinate axes
    if axes:
        ox, oy, _ = proj.project(0.0, 0.0, 0.0)
        c.circle(ox, oy, 2.2, fill="axis")
        axis_defs = (
            ((1.0, 0.0, 0.0), (1.22, 0.0, 0.0), axis_labels[0] if axis_labels else None),
            ((0.0, 1.0, 0.0), (0.0, 1.22, 0.0), axis_labels[1] if axis_labels else None),
            ((0.0, 0.0, 1.0), (0.0, 0.0, 1.22), axis_labels[2] if axis_labels else None),
        )
        m_ax = c.marker_url("axis", size="sm")
        for surface_pt, tip_pt, lbl in axis_defs:
            sx1, sy1, _ = proj.project(*surface_pt)
            sx2, sy2, _ = proj.project(*tip_pt)
            c.line(ox, oy, sx1, sy1, stroke="sphere_wire", stroke_width=0.9, dash="3,3", opacity=0.75)
            c.line(sx1, sy1, sx2, sy2, stroke="axis", stroke_width=1.2, marker_end=m_ax)
            if lbl:
                dx = sx2 - ox
                dy = sy2 - oy
                norm = math.hypot(dx, dy) or 1.0
                lx = sx2 + 11.0 * dx / norm
                ly = sy2 + 11.0 * dy / norm + 3.5
                c.math_text(lx, ly, lbl, fill="ink_muted", size=11.5, anchor="middle")

    return proj


def sphere_vector(
    c: SvgCanvas,
    proj: OrthoProj,
    start_3d: Sequence[float],
    end_3d: Sequence[float],
    *,
    color: str = "m",
    width: float = 2.4,
    size: str = "md",
    dash: str | None = None,
    tip_dot: bool = False,
    opacity: float | None = None,
) -> tuple[float, float]:
    """Draw a 3D projected vector on ``OrthoProj`` and return projected tip ``(sx, sy)``."""
    x1, y1, _ = proj.project(start_3d[0], start_3d[1], start_3d[2])
    x2, y2, _ = proj.project(end_3d[0], end_3d[1], end_3d[2])
    c.line(
        x1,
        y1,
        x2,
        y2,
        stroke=color,
        stroke_width=width,
        dash=dash,
        opacity=opacity,
        marker_end=c.marker_url(color, size=size),
    )
    if tip_dot:
        c.circle(x2, y2, max(2.8, width * 1.25), fill=color, stroke="surface_ref", stroke_width=1.0)
    return (x2, y2)


def tangent_plane_patch(
    c: SvgCanvas,
    proj: OrthoProj,
    m_3d: Sequence[float],
    *,
    half_size: float = 0.34,
    fill: str = "surface_subtle",
    fill_opacity: float = 0.55,
    stroke: str = "hairline",
    dash: str | None = "3,2.5",
) -> None:
    """Draw the geometrically exact tangent plane patch ``T_m S^2`` at unit vector ``m_3d``."""
    mx, my, mz = m_3d[0], m_3d[1], m_3d[2]
    norm = math.sqrt(mx * mx + my * my + mz * mz) or 1.0
    mx, my, mz = mx / norm, my / norm, mz / norm
    # Pick orthonormal tangent basis (e1, e2) in T_m S^2
    ref = (0.0, 0.0, 1.0) if abs(mz) < 0.9 else (1.0, 0.0, 0.0)
    e1 = (
        ref[1] * mz - ref[2] * my,
        ref[2] * mx - ref[0] * mz,
        ref[0] * my - ref[1] * mx,
    )
    n1 = math.sqrt(e1[0] ** 2 + e1[1] ** 2 + e1[2] ** 2) or 1.0
    e1 = (e1[0] / n1, e1[1] / n1, e1[2] / n1)
    e2 = (
        my * e1[2] - mz * e1[1],
        mz * e1[0] - mx * e1[2],
        mx * e1[1] - my * e1[0],
    )
    corners_2d: list[tuple[float, float]] = []
    for s1, s2 in ((-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)):
        px = mx + half_size * (s1 * e1[0] + s2 * e2[0])
        py = my + half_size * (s1 * e1[1] + s2 * e2[1])
        pz = mz + half_size * (s1 * e1[2] + s2 * e2[2])
        sx, sy, _ = proj.project(px, py, pz)
        corners_2d.append((sx, sy))
    c.polygon(
        corners_2d,
        fill=fill,
        fill_opacity=fill_opacity,
        stroke=stroke,
        stroke_width=0.9,
        dash=dash,
    )


def rk4_integrate(
    rhs: Callable[[float, tuple[float, ...]], Sequence[float]],
    y0: Sequence[float],
    t_span: tuple[float, float],
    dt: float,
    *,
    normalize: bool = False,
) -> tuple[list[float], list[tuple[float, ...]]]:
    """Classical 4th-order Runge-Kutta integrator (pure stdlib, exact unit-sphere option)."""
    t0, t1 = float(t_span[0]), float(t_span[1])
    if dt <= 0.0:
        raise ValueError("dt must be positive")
    y = tuple(float(v) for v in y0)
    if normalize:
        nrm = math.sqrt(sum(v * v for v in y)) or 1.0
        y = tuple(v / nrm for v in y)

    ts: list[float] = [t0]
    ys: list[tuple[float, ...]] = [y]
    t = t0
    steps = max(1, int(round((t1 - t0) / dt)))
    h = (t1 - t0) / steps

    for _ in range(steps):
        k1 = rhs(t, y)
        y2 = tuple(yi + 0.5 * h * k1i for yi, k1i in zip(y, k1))
        k2 = rhs(t + 0.5 * h, y2)
        y3 = tuple(yi + 0.5 * h * k2i for yi, k2i in zip(y, k2))
        k3 = rhs(t + 0.5 * h, y3)
        y4 = tuple(yi + h * k3i for yi, k3i in zip(y, k3))
        k4 = rhs(t + h, y4)
        y_next = tuple(
            yi + (h / 6.0) * (k1i + 2.0 * k2i + 2.0 * k3i + k4i)
            for yi, k1i, k2i, k3i, k4i in zip(y, k1, k2, k3, k4)
        )
        if normalize:
            nrm = math.sqrt(sum(v * v for v in y_next)) or 1.0
            y_next = tuple(v / nrm for v in y_next)
        t += h
        y = y_next
        ts.append(t)
        ys.append(y)
    return ts, ys


# ---------------------------------------------------------------------------
# Regions, material slabs, dimension callouts, flow nodes, and legends
# ---------------------------------------------------------------------------


def dashed_region(
    c: SvgCanvas,
    x: float,
    y: float,
    w: float,
    h: float,
    *,
    stroke: str = "air_stroke",
    fill: str | None = "air_fill",
    fill_opacity: float = 0.65,
    rx: float = 3.0,
    dash: str = "5,3.5",
    stroke_width: float = 1.1,
    label: str | None = None,
    label_pos: str = "top-left",
    label_color: str | None = None,
    label_markup: bool = False,
) -> None:
    """Draw a clean dashed domain / airbox / boundary region."""
    c.rect(
        x,
        y,
        w,
        h,
        fill=fill,
        fill_opacity=fill_opacity if fill not in (None, "none") else None,
        stroke=stroke,
        stroke_width=stroke_width,
        rx=rx,
        dash=dash,
    )
    if label:
        col = label_color if label_color is not None else stroke
        if label_pos == "top-left":
            lx, ly, anc = x + 9.0, y + 16.5, "start"
        elif label_pos == "top-right":
            lx, ly, anc = x + w - 9.0, y + 16.5, "end"
        elif label_pos == "bottom-left":
            lx, ly, anc = x + 9.0, y + h - 8.5, "start"
        elif label_pos == "bottom-right":
            lx, ly, anc = x + w - 9.0, y + h - 8.5, "end"
        else:
            lx, ly, anc = x + 0.5 * w, y + 16.5, "middle"
        c.text(lx, ly, label, cls="fm-note", fill=col, anchor=anc, raw_markup=label_markup)


def layer_slab(
    c: SvgCanvas,
    x: float,
    y: float,
    w: float,
    h: float,
    *,
    kind: str = "fm",
    label: str | None = None,
    sublabel: str | None = None,
    label_pos: str = "left",
    rx: float = 2.0,
    fill: str | None = None,
    stroke: str | None = None,
    stroke_width: float = 1.2,
    dash: str | None = None,
    hatch: str | None = None,
    label_markup: bool = False,
) -> None:
    """Draw a clean material slab (``kind``: 'fm' | 'hm' | 'spacer' | 'air')."""
    kind_map = {
        "fm": ("fm_fill", "fm_stroke"),
        "hm": ("hm_fill", "hm_stroke"),
        "spacer": ("spacer_fill", "spacer_stroke"),
        "air": ("air_fill", "air_stroke"),
    }
    def_fill, def_stroke = kind_map.get(kind, ("surface_subtle", "node_stroke"))
    f_col = fill if fill is not None else def_fill
    s_col = stroke if stroke is not None else def_stroke
    c.rect(x, y, w, h, fill=f_col, stroke=s_col, stroke_width=stroke_width, rx=rx, dash=dash)
    if hatch:
        c.rect(x, y, w, h, fill=f"url(#{c._pid(hatch)})", stroke="none", rx=rx)

    if label:
        if label_pos == "left":
            lx, anc = x + 10.0, "start"
        elif label_pos == "right":
            lx, anc = x + w - 10.0, "end"
        else:
            lx, anc = x + 0.5 * w, "middle"
        cy = y + 0.5 * h + (4.0 if not sublabel else -2.5)
        c.text(lx, cy, label, cls="fm-label-bold", fill=s_col, anchor=anc, raw_markup=label_markup)
        if sublabel:
            c.text(lx, cy + 14.5, sublabel, cls="fm-note", fill="ink_secondary", anchor=anc, raw_markup="<tspan" in sublabel)


def iso_slab(
    c: SvgCanvas,
    x: float,
    y: float,
    w: float,
    h: float,
    depth_dx: float = 24.0,
    depth_dy: float = -14.0,
    *,
    kind: str = "fm",
    label: str | None = None,
    stroke_width: float = 1.1,
    label_markup: bool = False,
) -> None:
    """Draw a crisp isometric 3D thin-film slab (front, top, and right faces)."""
    kind_map = {
        "fm": ("fm_fill", "fm_top", "fm_side", "fm_stroke"),
        "hm": ("hm_fill", "hm_top", "hm_side", "hm_stroke"),
        "spacer": ("spacer_fill", "spacer_top", "spacer_side", "spacer_stroke"),
    }
    f_front, f_top, f_side, stroke = kind_map.get(kind, ("surface_subtle", "node_fill", "grid", "node_stroke"))
    # Top face
    top_pts = [
        (x, y),
        (x + depth_dx, y + depth_dy),
        (x + w + depth_dx, y + depth_dy),
        (x + w, y),
    ]
    # Right side face
    side_pts = [
        (x + w, y),
        (x + w + depth_dx, y + depth_dy),
        (x + w + depth_dx, y + h + depth_dy),
        (x + w, y + h),
    ]
    c.polygon(top_pts, fill=f_top, stroke=stroke, stroke_width=stroke_width)
    c.polygon(side_pts, fill=f_side, stroke=stroke, stroke_width=stroke_width)
    c.rect(x, y, w, h, fill=f_front, stroke=stroke, stroke_width=stroke_width)
    if label:
        c.text(
            x + 10.0,
            y + 0.5 * h + 4.0,
            label,
            cls="fm-label-bold",
            fill=stroke,
            raw_markup=label_markup,
        )


def bracket_dim(
    c: SvgCanvas,
    x1: float,
    y1: float,
    x2: float,
    y2: float,
    *,
    label: str | None = None,
    offset: float = 10.0,
    tick: float = 5.0,
    color: str = "ink_muted",
    math_label: bool = True,
    arrow: bool = True,
    halo: bool = False,
    label_offset: float = 11.0,
) -> None:
    """Draw a clean scientific dimension callout between ``(x1, y1)`` and ``(x2, y2)``.

    ``offset`` shifts the dimension bar perpendicular to the segment (positive
    shifts to the right-hand normal of the vector from p1 -> p2; flip sign to
    move to the opposite side).
    """
    dx, dy = x2 - x1, y2 - y1
    length = math.hypot(dx, dy)
    if length < 1e-6:
        return
    # Unit normal (rotated +90° in screen coords)
    nx, ny = -dy / length, dx / length
    bx1, by1 = x1 + offset * nx, y1 + offset * ny
    bx2, by2 = x2 + offset * nx, y2 + offset * ny

    # Witness ticks
    half_t = 0.5 * tick
    c.line(bx1 - half_t * nx, by1 - half_t * ny, bx1 + half_t * nx, by1 + half_t * ny, stroke=color, stroke_width=0.9)
    c.line(bx2 - half_t * nx, by2 - half_t * ny, bx2 + half_t * nx, by2 + half_t * ny, stroke=color, stroke_width=0.9)

    m_url = c.marker_url(color, size="sm") if arrow else None
    c.line(
        bx1,
        by1,
        bx2,
        by2,
        stroke=color,
        stroke_width=0.95,
        marker_start=m_url,
        marker_end=m_url,
    )
    if label:
        sign = 1.0 if offset >= 0 else -1.0
        mx = 0.5 * (bx1 + bx2) + sign * label_offset * nx
        my = 0.5 * (by1 + by2) + sign * label_offset * ny + 3.5
        anchor = "middle"
        if abs(nx) > 0.65:
            anchor = "start" if (sign * nx) > 0 else "end"
        if math_label:
            c.math_text(mx, my, label, fill=color, size=11.0, anchor=anchor, halo=halo)
        else:
            c.text(mx, my, label, cls="fm-note", fill=color, anchor=anchor, halo=halo, raw_markup="<tspan" in label)


def flow_node(
    c: SvgCanvas,
    x: float,
    y: float,
    w: float,
    h: float,
    title: str,
    *,
    subtitle: str | Sequence[str] | None = None,
    accent: str | None = None,
    fill: str | None = None,
    stroke: str | None = None,
    rx: float = 3.0,
    title_size: float = 11.6,
    sub_size: float = 10.3,
    align: str = "center",
    accent_bar: str | None = "left",
    title_markup: bool = False,
    sub_markup: bool = False,
) -> None:
    """Minimalist scientific schematic block (hairline border, rx=3, ZERO drop shadow)."""
    bg = fill if fill is not None else "node_fill"
    bd = stroke if stroke is not None else (accent if accent is not None else "node_stroke")
    c.rect(x, y, w, h, fill=bg, stroke=bd, stroke_width=1.05, rx=rx)

    # Optional crisp subtle accent edge (never heavy gradients or card headers)
    if accent and accent_bar == "left":
        c.line(x + 1.4, y + 3.0, x + 1.4, y + h - 3.0, stroke=accent, stroke_width=2.6, linecap="round")
    elif accent and accent_bar == "top":
        c.line(x + 3.0, y + 1.4, x + w - 3.0, y + 1.4, stroke=accent, stroke_width=2.4, linecap="round")

    if subtitle is None:
        sub_lines: list[str] = []
    elif isinstance(subtitle, str):
        sub_lines = [subtitle] if subtitle else []
    else:
        sub_lines = list(subtitle)

    if align == "left":
        tx = x + (11.0 if (accent and accent_bar == "left") else 9.0)
        anc = "start"
    else:
        tx = x + 0.5 * w
        anc = "middle"

    total_text_h = title_size + (len(sub_lines) * (sub_size + 4.0) + (3.0 if sub_lines else 0.0))
    first_y = y + 0.5 * (h - total_text_h) + title_size * 0.85

    c.text(
        tx,
        first_y,
        title,
        cls="fm-label-bold",
        fill=accent if (accent and stroke is None and fill is None and not accent_bar) else "ink",
        size=title_size,
        anchor=anc,
        raw_markup=title_markup or ("<tspan" in title),
    )
    for idx, line in enumerate(sub_lines):
        ly = first_y + 14.5 + idx * (sub_size + 3.8)
        c.text(
            tx,
            ly,
            line,
            cls="fm-note",
            fill="ink_secondary",
            size=sub_size,
            anchor=anc,
            raw_markup=sub_markup or ("<tspan" in line),
        )


def legend_strip(
    c: SvgCanvas,
    x: float,
    y: float,
    items: Sequence[tuple[str, str, str]],
    *,
    horizontal: bool = True,
    gap: float = 18.0,
    line_len: float = 18.0,
    row_gap: float = 16.0,
    item_widths: Sequence[float] | None = None,
) -> None:
    """Minimalist borderless scientific legend strip.

    ``items`` is a sequence of ``(label_markup, color_or_token, style)`` where
    ``style`` is one of ``"solid"``, ``"dashed"``, ``"dotted"``, ``"dot"``,
    ``"swatch"``, or ``"arrow"``.
    """
    cur_x = x
    cur_y = y
    for idx, (label, color, style) in enumerate(items):
        cy = cur_y - 3.5
        if style == "solid":
            c.line(cur_x, cy, cur_x + line_len, cy, stroke=color, stroke_width=2.1)
        elif style == "dashed":
            c.line(cur_x, cy, cur_x + line_len, cy, stroke=color, stroke_width=2.0, dash="5,3")
        elif style == "dotted":
            c.line(cur_x, cy, cur_x + line_len, cy, stroke=color, stroke_width=2.0, dash="2,3")
        elif style == "arrow":
            c.line(cur_x, cy, cur_x + line_len, cy, stroke=color, stroke_width=1.9, marker_end=c.marker_url(color, size="sm"))
        elif style == "dot":
            c.circle(cur_x + 0.5 * line_len, cy, 3.6, fill=color)
        elif style == "swatch":
            c.rect(cur_x + 2.0, cy - 4.5, line_len - 4.0, 9.0, fill=color, stroke="node_stroke", stroke_width=0.7, rx=1.5)
        else:
            c.line(cur_x, cy, cur_x + line_len, cy, stroke=color, stroke_width=2.0)

        c.text(
            cur_x + line_len + 6.0,
            cur_y,
            label,
            cls="fm-sub",
            size=10.8,
            raw_markup="<tspan" in label,
        )
        if horizontal:
            if item_widths is not None and idx < len(item_widths):
                cur_x += item_widths[idx]
            else:
                plain_len = len(re.sub(r"<[^>]+>", "", label))
                cur_x += line_len + 6.0 + max(42.0, plain_len * 6.2) + gap
        else:
            cur_y += row_gap


# ---------------------------------------------------------------------------
# Dual-theme SVG writer (Light + Dark paired generation with XML validation)
# ---------------------------------------------------------------------------


def write_themed_svg(
    slug: str,
    draw_fn: Callable[[SvgCanvas, Theme], None],
    *,
    width: float,
    height: float,
    title: str,
    desc: str,
    out_dir: Path | str = DEFAULT_DIAGRAMS_DIR,
) -> tuple[Path, Path]:
    """Render both ``<slug>.svg`` (light) and ``<slug>-dark.svg`` (dark) cleanly.

    Guarantees valid XML, identical ``viewBox``, ``role="img"``, ``<title>``,
    and ``<desc>`` before writing both files deterministically.
    """
    out_path = Path(out_dir)
    out_path.mkdir(parents=True, exist_ok=True)
    clean_slug = slug.removesuffix(".svg")

    rendered: dict[str, str] = {}
    view_boxes: dict[str, str] = {}

    for theme_name in ("light", "dark"):
        theme = THEMES[theme_name]
        canvas = SvgCanvas(width=width, height=height, theme=theme, title=title, desc=desc)
        draw_fn(canvas, theme)
        svg_text = canvas.to_svg()
        root = ET.fromstring(svg_text)
        view_boxes[theme_name] = (root.attrib.get("viewBox") or "").strip()
        rendered[theme_name] = svg_text

    if view_boxes["light"] != view_boxes["dark"]:
        raise ValueError(
            f"viewBox mismatch for {clean_slug!r}: light={view_boxes['light']!r} vs dark={view_boxes['dark']!r}"
        )

    light_path = out_path / f"{clean_slug}.svg"
    dark_path = out_path / f"{clean_slug}-dark.svg"
    light_path.write_text(rendered["light"], encoding="utf-8")
    dark_path.write_text(rendered["dark"], encoding="utf-8")
    return light_path, dark_path
