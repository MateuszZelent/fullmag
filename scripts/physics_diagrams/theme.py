"""WCAG AA scientific color palettes and typography tokens for FullMag physics diagrams.

Two calibrated themes — ``THEMES["light"]`` (harmonized with Catppuccin Latte
``--fm-docs-bg-surface: #f7f8fb``) and ``THEMES["dark"]`` (harmonized with
Catppuccin Mocha ``--fm-docs-bg-surface: #242438``) — designed for minimalist,
publication-grade scientific figures (Nature / Physical Review B / AIP) on a
transparent SVG root canvas.
"""

from __future__ import annotations

from dataclasses import dataclass, fields


FONT_SANS = "'Inter', 'Helvetica Neue', 'Liberation Sans', Arial, sans-serif"
FONT_MATH = "'STIX Two Math', 'Cambria Math', 'Times New Roman', Georgia, serif"
FONT_MONO = "'JetBrains Mono', 'Fira Code', 'Liberation Mono', 'DejaVu Sans Mono', monospace"


@dataclass(frozen=True, slots=True)
class Theme:
    """Semantic color palette for a single diagram theme (light or dark)."""

    name: str
    # Reference page surface color (root <svg> stays transparent; used for text halos & subtle blends)
    surface_ref: str

    # Neutral ink & structural lines
    ink: str
    ink_secondary: str
    ink_muted: str
    axis: str
    hairline: str
    grid: str

    # Minimalist 3D sphere shading & wireframe tokens
    sphere_wire: str
    sphere_wire_back: str
    sphere_grad_0: str
    sphere_grad_1: str
    sphere_grad_2: str
    sphere_stroke: str

    # Subtle regions & minimalist architectural nodes (no shadows, hairline border)
    surface_subtle: str
    node_fill: str
    node_stroke: str

    # Semantic physics vectors & operators (all >= 4.5:1 WCAG AA on surface_ref & node_fill)
    m: str                # Magnetization m (crimson / coral)
    m_soft: str
    H: str                # Effective / external / demag fields H, potentials phi (cobalt / sky)
    H_soft: str
    flux: str             # Flux, field-like torque, FEM/BEM operators (teal / mint)
    flux_soft: str
    accent_warm: str      # Damping, anisotropy, energy barriers, spin current Q_s (ochre / gold)
    accent_warm_soft: str
    accent_violet: str    # DMI, chirality, spin accumulation, spin current (plum / lavender)
    accent_violet_soft: str

    # Physical material domains & isometric face shades
    fm_fill: str
    fm_stroke: str
    fm_top: str
    fm_side: str

    hm_fill: str
    hm_stroke: str
    hm_top: str
    hm_side: str

    spacer_fill: str
    spacer_stroke: str
    spacer_top: str
    spacer_side: str

    air_fill: str
    air_stroke: str

    # Status / diagnostic accents
    ok: str
    ok_soft: str
    warn: str
    warn_soft: str
    err: str
    err_soft: str

    def __getitem__(self, key: str) -> str:
        try:
            return getattr(self, key)
        except AttributeError as exc:
            raise KeyError(key) from exc

    def get(self, key: str, default: str | None = None) -> str | None:
        return getattr(self, key, default)

    def keys(self) -> tuple[str, ...]:
        return tuple(f.name for f in fields(self))


LIGHT_THEME = Theme(
    name="light",
    surface_ref="#f7f8fb",
    ink="#1c2030",
    ink_secondary="#3b4058",
    ink_muted="#575e78",
    axis="#4a5168",
    hairline="#aeb5c9",
    grid="#dde2ec",
    sphere_wire="#9fa8be",
    sphere_wire_back="#cdd4e3",
    sphere_grad_0="#ffffff",
    sphere_grad_1="#f0f3fa",
    sphere_grad_2="#dde3f0",
    sphere_stroke="#8590aa",
    surface_subtle="#eceff6",
    node_fill="#ffffff",
    node_stroke="#7c859e",
    m="#b82e24",
    m_soft="#fae7e5",
    H="#1857a8",
    H_soft="#e4eefb",
    flux="#0e746c",
    flux_soft="#dff2ef",
    accent_warm="#9c5409",
    accent_warm_soft="#faf0df",
    accent_violet="#6b38b5",
    accent_violet_soft="#efe8fa",
    fm_fill="#f5e8df",
    fm_stroke="#945630",
    fm_top="#faf1ea",
    fm_side="#e6d2c3",
    hm_fill="#e2eef4",
    hm_stroke="#316580",
    hm_top="#eef5f9",
    hm_side="#cddfe9",
    spacer_fill="#eaedf3",
    spacer_stroke="#636c82",
    spacer_top="#f3f5f9",
    spacer_side="#d9dde7",
    air_fill="#eff2f8",
    air_stroke="#636d85",
    ok="#1d6f30",
    ok_soft="#e3f4e7",
    warn="#965608",
    warn_soft="#fbf0da",
    err="#b51b32",
    err_soft="#fce5e8",
)


DARK_THEME = Theme(
    name="dark",
    surface_ref="#242438",
    ink="#e6ecff",
    ink_secondary="#c3cbe6",
    ink_muted="#9ca6c7",
    axis="#a7b0ce",
    hairline="#525874",
    grid="#34374f",
    sphere_wire="#6c7394",
    sphere_wire_back="#464b66",
    sphere_grad_0="#363956",
    sphere_grad_1="#2b2d46",
    sphere_grad_2="#1f2135",
    sphere_stroke="#7881a3",
    surface_subtle="#2c2e46",
    node_fill="#2b2d45",
    node_stroke="#6f7796",
    m="#f38388",
    m_soft="#422a38",
    H="#7eb6ff",
    H_soft="#263452",
    flux="#5ee0cc",
    flux_soft="#223c42",
    accent_warm="#f0b86e",
    accent_warm_soft="#3f342c",
    accent_violet="#c5a3ff",
    accent_violet_soft="#362c50",
    fm_fill="#3b2d31",
    fm_stroke="#d89a78",
    fm_top="#49383c",
    fm_side="#2f2328",
    hm_fill="#263849",
    hm_stroke="#7bb8d4",
    hm_top="#31465a",
    hm_side="#1f2e3d",
    spacer_fill="#31334c",
    spacer_stroke="#8f97b5",
    spacer_top="#3c3f5c",
    spacer_side="#282a3f",
    air_fill="#292b41",
    air_stroke="#8f98b8",
    ok="#8ce099",
    ok_soft="#253d34",
    warn="#f2c478",
    warn_soft="#3f352b",
    err="#f5889c",
    err_soft="#442937",
)


THEMES: dict[str, Theme] = {
    "light": LIGHT_THEME,
    "dark": DARK_THEME,
}

# Semantic color tokens guaranteed to pass >= 4.5:1 text contrast on surface_ref & node_fill.
TEXT_CONTRAST_TOKENS: tuple[str, ...] = (
    "ink",
    "ink_secondary",
    "ink_muted",
    "axis",
    "m",
    "H",
    "flux",
    "accent_warm",
    "accent_violet",
    "fm_stroke",
    "hm_stroke",
    "spacer_stroke",
    "air_stroke",
    "ok",
    "warn",
    "err",
)

# Structural stroke tokens guaranteed to pass >= 3.0:1 non-text graphical contrast.
STROKE_CONTRAST_TOKENS: tuple[str, ...] = (
    "node_stroke",
    "sphere_stroke",
)

# Tokens for which standard arrowhead markers are pre-registered in SvgCanvas.
ARROW_TOKENS: tuple[str, ...] = (
    "ink",
    "ink_secondary",
    "ink_muted",
    "axis",
    "m",
    "H",
    "flux",
    "accent_warm",
    "accent_violet",
    "fm_stroke",
    "hm_stroke",
    "spacer_stroke",
    "air_stroke",
    "ok",
    "warn",
    "err",
)


def get_theme(theme: Theme | str) -> Theme:
    """Resolve a theme name ('light' or 'dark') or Theme instance."""
    if isinstance(theme, Theme):
        return theme
    key = theme.strip().lower()
    if key not in THEMES:
        raise ValueError(f"Unknown theme {theme!r}; expected one of {tuple(THEMES)}")
    return THEMES[key]


def relative_luminance(hex_color: str) -> float:
    """Compute WCAG 2.1 relative luminance for a #rrggbb color."""
    cleaned = hex_color.strip().lstrip("#")
    if len(cleaned) != 6:
        raise ValueError(f"Expected 6-digit hex color, got {hex_color!r}")
    r, g, b = (int(cleaned[idx : idx + 2], 16) / 255.0 for idx in (0, 2, 4))

    def _linearize(channel: float) -> float:
        return channel / 12.92 if channel <= 0.03928 else ((channel + 0.055) / 1.055) ** 2.4

    return 0.2126 * _linearize(r) + 0.7152 * _linearize(g) + 0.0722 * _linearize(b)


def contrast_ratio(hex_a: str, hex_b: str) -> float:
    """Compute WCAG 2.1 contrast ratio between two #rrggbb colors."""
    l1, l2 = sorted((relative_luminance(hex_a), relative_luminance(hex_b)), reverse=True)
    return (l1 + 0.05) / (l2 + 0.05)
