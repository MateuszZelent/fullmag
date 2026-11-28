"""Publication-grade dual-theme (Light + Dark) spintronics & spin-transport diagrams.

Generates 6 paired SVG figures (12 files) in minimalist Nature / Physical Review B / AIP style:
  1. stt-slonczewski-vs-zhang-li
  2. sot-models-comparison-local-m1-m2
  3. sot-unit-sphere-torques-and-drives
  4. sot-switching-and-calibration-regimes
  5. spin-hall-hm-fm
  6. drift-diffusion-reactions-and-interface
"""

from __future__ import annotations

import cmath
import math
from pathlib import Path
from typing import Sequence

from .primitives import (
    DEFAULT_DIAGRAMS_DIR,
    OrthoProj,
    SvgCanvas,
    arc_arrow,
    axes_2d,
    bracket_dim,
    curve_path,
    curved_arrow,
    dashed_region,
    flow_node,
    format_math,
    iso_slab,
    layer_slab,
    legend_strip,
    math_span,
    out_of_plane_symbol,
    panel_divider,
    panel_label,
    rk4_integrate,
    sphere_curve,
    sphere_vector,
    spin_arrow,
    tangent_plane_patch,
    unit_sphere,
    vector_arrow,
    write_themed_svg,
)
from .theme import FONT_MONO, Theme


# XML-safe TeX-to-Unicode + <tspan> math helper (zero raw underscores or backslashes)
_TEX_REPLACEMENTS: tuple[tuple[str, str], ...] = (
    (r"\leftrightarrow", "↔"),
    (r"\Rightarrow", "⇒"),
    (r"\rightarrow", "→"),
    (r"\parallel", "∥"),
    (r"\lesssim", "≲"),
    (r"\downarrow", "↓"),
    (r"\uparrow", "↑"),
    (r"\partial", "∂"),
    (r"\epsilon", "ε"),
    (r"\propto", "∝"),
    (r"\approx", "≈"),
    (r"\Lambda", "Λ"),
    (r"\lambda", "λ"),
    (r"\infty", "∞"),
    (r"\Delta", "Δ"),
    (r"\Omega", "Ω"),
    (r"\sigma", "σ"),
    (r"\theta", "θ"),
    (r"\alpha", "α"),
    (r"\gamma", "γ"),
    (r"\nabla", "∇"),
    (r"\times", "×"),
    (r"\lVert", "‖"),
    (r"\rVert", "‖"),
    (r"\hbar", "ℏ"),
    (r"\beta", "β"),
    (r"\cdot", "·"),
    (r"\perp", "⊥"),
    (r"\quad", "  "),
    (r"\qquad", "   "),
    (r"\cos", "cos"),
    (r"\sin", "sin"),
    (r"\neq", "≠"),
    (r"\phi", "ϕ"),
    (r"\pm", "±"),
    (r"\mu", "μ"),
    (r"\xi", "ξ"),
    (r"\to", "→"),
    (r"\,", " "),
    (r"\;", " "),
)


def M(expr: str) -> str:
    """Convert TeX math shorthand into crisp Unicode + SVG <tspan> markup."""
    s = expr
    # Support \boldsymbol{...} as bold upright vector symbol (identical to \mathbf{...})
    s = s.replace(r"\boldsymbol{", r"\mathbf{").replace(r"\mathcal{J}", "𝒥")
    # Convert \mathcal{J} to italic J cleanly (avoid missing glyph fallback in Linux fonts)
    s = s.replace("𝒥", "J")
    for tex, uni in _TEX_REPLACEMENTS:
        s = s.replace(tex, uni)
    # Use proper mathematical minus sign for standalone binary/unary minus outside tags
    s = (
        s.replace(" - ", " − ")
        .replace("= -", "= −")
        .replace("⇒ -", "⇒ −")
        .replace("→ -", "→ −")
        .replace("(-", "(−")
        .replace("=-", "=−")
        .replace("[-", "[−")
        .replace(" -", " −")
    )
    if s.startswith("-"):
        s = "−" + s[1:]
    out = format_math(s)
    if "\\" in out:
        raise ValueError(f"Unresolved TeX command in math markup: {expr!r} -> {out!r}")
    return out


def _cross(a: Sequence[float], b: Sequence[float]) -> tuple[float, float, float]:
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def _dot(a: Sequence[float], b: Sequence[float]) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _norm(v: Sequence[float]) -> tuple[float, float, float]:
    n = math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) or 1.0
    return (v[0] / n, v[1] / n, v[2] / n)


def _add(a: Sequence[float], b: Sequence[float], scale_b: float = 1.0) -> tuple[float, float, float]:
    return (a[0] + scale_b * b[0], a[1] + scale_b * b[1], a[2] + scale_b * b[2])


# ===========================================================================
# 1. stt-slonczewski-vs-zhang-li
# ===========================================================================


def _draw_stt_slonczewski_vs_zhang_li(c: SvgCanvas, t: Theme) -> None:
    # -----------------------------------------------------------------------
    # Panel a: Slonczewski CPP / MTJ trilayer + exact epsilon_DL(theta) plot
    # -----------------------------------------------------------------------
    panel_label(c, 16, 22, "a", "Slonczewski CPP / MTJ torque")

    # Isometric CPP nanopillar stack (bottom -> top: Pinned -> Spacer -> Free FM)
    sx, sw = 44.0, 126.0
    dx, dy = 20.0, -11.0
    y_pin, h_pin = 212.0, 42.0
    y_sp, h_sp = 192.0, 20.0
    y_free, h_free = 132.0, 60.0

    # Vertical charge current entering bottom & exiting top along n_stack = +z
    jx = sx + 0.5 * sw + 4.0
    c.line(jx, 294.0, jx, y_pin + h_pin, stroke="H", stroke_width=2.2)
    vector_arrow(c, jx, 294.0, jx, 260.0, color="H", width=2.2, size="md")
    vector_arrow(c, jx, y_free + dy * 0.5, jx, 76.0, color="H", width=2.2, size="md")

    # Draw slabs bottom-to-top so upper slabs cleanly occlude lower top faces
    # Pinned polarizer (hm-tinted slab for clear visual contrast against free FM)
    iso_slab(c, sx, y_pin, sw, h_pin, dx, dy, kind="hm")
    iso_slab(c, sx, y_sp, sw, h_sp, dx, dy, kind="spacer")
    iso_slab(c, sx, y_free, sw, h_free, dx, dy, kind="fm")

    # Faint dashed current path inside the trilayer
    c.line(jx, y_pin + h_pin, jx, y_free, stroke="H", stroke_width=1.4, dash="3.5,3", opacity=0.55)

    # Layer labels inside front faces (left aligned, clean breathing room)
    c.text(sx + 8.0, y_pin + 17.0, "Pinned", cls="fm-label-bold", fill="hm_stroke", size=11.0)
    c.math_text(sx + 8.0, y_pin + 32.0, M("\\hat{p}"), fill="accent_violet", size=11.5)
    c.text(sx + 8.0, y_sp + 13.5, "Spacer", cls="fm-note", fill="spacer_stroke", size=10.2)
    c.text(sx + 8.0, y_free + 17.0, "Free FM", cls="fm-label-bold", fill="fm_stroke", size=11.0)

    # Thickness dimension t_F cleanly OUTSIDE left edge of Free FM
    bracket_dim(
        c,
        sx - 3.0,
        y_free,
        sx - 3.0,
        y_free + h_free,
        label=M("t_F"),
        offset=10.0,
        color="ink_muted",
        label_offset=8.0,
    )

    # Stack normal n_stack arrow on right side of pillar
    nx_pos = sx + sw + dx + 14.0
    vector_arrow(
        c,
        nx_pos,
        y_sp + h_sp + 6.0,
        nx_pos,
        y_free + 10.0,
        color="axis",
        width=1.4,
        size="sm",
    )
    c.math_text(nx_pos + 6.0, y_sp + 4.0, M("\\hat{n}_{stack}"), fill="ink_secondary", size=11.0)

    # Polarizer vector p_hat in pinned layer (pointing horizontally right)
    vector_arrow(c, sx + 64.0, y_pin + 24.0, sx + 114.0, y_pin + 24.0, color="accent_violet", width=2.4, size="md")

    # Free layer magnetization m tilted at theta = 52 deg from p_hat (+x)
    m_ox, m_oy = sx + 56.0, y_free + 50.0
    theta_deg = 52.0
    m_len = 34.0
    m_tx = m_ox + m_len * math.cos(math.radians(theta_deg))
    m_ty = m_oy - m_len * math.sin(math.radians(theta_deg))

    # Dashed reference parallel to p_hat and angle arc theta
    c.line(m_ox, m_oy, m_ox + 36.0, m_oy, stroke="accent_violet", stroke_width=1.0, dash="3,2.5", opacity=0.75)
    c.path(
        f"M {m_ox + 15.0:.1f} {m_oy:.1f} A 15 15 0 0 0 "
        f"{m_ox + 15.0 * math.cos(math.radians(theta_deg)):.1f} "
        f"{m_oy - 15.0 * math.sin(math.radians(theta_deg)):.1f}",
        stroke="ink_muted",
        stroke_width=1.0,
    )
    c.math_text(m_ox + 18.0, m_oy - 4.0, M("\\theta"), fill="ink_secondary", size=10.5)

    # Magnetization arrow m
    vector_arrow(c, m_ox, m_oy, m_tx, m_ty, color="m", width=2.5, size="md")
    c.math_text(m_ox + 1.0, m_oy - 21.0, M("\\mathbf{m}"), fill="m", size=11.6, bold=True)

    # Orthogonal Slonczewski DL & FL torque arrows at tip of m
    dl_angle = math.radians(theta_deg - 90.0)
    dl_x2 = m_tx + 24.0 * math.cos(dl_angle)
    dl_y2 = m_ty - 24.0 * math.sin(dl_angle)
    vector_arrow(c, m_tx, m_ty, dl_x2, dl_y2, color="accent_warm", width=2.0, size="sm")
    c.math_text(dl_x2 + 4.0, dl_y2 + 6.0, M("\\mathbf{T}_{DL}"), fill="accent_warm", size=10.6, bold=True)

    # FL direction: out of (m, p_hat) plane (receding along isometric +y)
    fl_x2 = m_tx + 16.0
    fl_y2 = m_ty - 12.0
    vector_arrow(c, m_tx, m_ty, fl_x2, fl_y2, color="flux", width=2.0, size="sm")
    c.math_text(fl_x2 + 4.0, fl_y2 - 1.0, M("\\mathbf{T}_{FL}"), fill="flux", size=10.6, bold=True)

    # Current labels below and above pillar
    c.math_text(jx + 10.0, 82.0, M("\\mathbf{J}_c"), fill="H", size=12.0, bold=True)
    c.math_text(sx + 68.0, 310.0, M("J_{\\perp} = \\mathbf{J}_c \\cdot \\hat{n}_{stack}"), fill="H", size=11.5, anchor="middle")

    # Right half of Panel a: exact computed epsilon_DL(theta) plot
    pf = axes_2d(
        c,
        270.0,
        66.0,
        204.0,
        186.0,
        xlim=(0.0, 180.0),
        ylim=(0.0, 0.86),
        xlabel=M("\\theta \\mathrm{ (deg)}"),
        ylabel=M("\\epsilon_{DL}(\\theta)"),
        xticks=(0.0, 45.0, 90.0, 135.0, 180.0),
        xtick_labels=("0°", "45°", "90°", "135°", "180°"),
        yticks=(0.0, 0.2, 0.4, 0.6, 0.8),
        ytick_labels=("0.0", "0.2", "0.4", "0.6", "0.8"),
        grid=True,
        xlabel_offset=29.0,
        ylabel_offset=33.0,
    )
    c.math_text(
        372.0,
        55.0,
        M("P = 0.40:\\; \\epsilon_{DL} = P\\Lambda^2/[(\\Lambda^2+1)+(\\Lambda^2-1)\\cos\\theta]"),
        fill="ink_secondary",
        size=9.7,
        anchor="middle",
    )

    thetas = [180.0 * k / 120.0 for k in range(121)]
    p_val = 0.40

    def eps_dl(th_deg: float, lam: float) -> float:
        l2 = lam * lam
        return (p_val * l2) / ((l2 + 1.0) + (l2 - 1.0) * math.cos(math.radians(th_deg)))

    pf.plot_curve(thetas, [eps_dl(th, 1.0) for th in thetas], color="ink_muted", width=1.8, dash="4.5,3")
    pf.plot_curve(thetas, [eps_dl(th, 1.5) for th in thetas], color="H", width=2.2)
    pf.plot_curve(thetas, [eps_dl(th, 2.0) for th in thetas], color="accent_violet", width=2.4)

    # Direct curve labels cleanly separated from curves
    c.math_text(*pf.pt(124.0, 0.72), M("\\Lambda = 2.0"), fill="accent_violet", size=10.8, anchor="end", halo=True)
    c.math_text(*pf.pt(164.0, 0.34), M("\\Lambda = 1.5"), fill="H", size=10.8, anchor="end", halo=True)
    c.math_text(*pf.pt(108.0, 0.12), M("\\Lambda = 1.0\\; (P/2)"), fill="ink_muted", size=10.4, anchor="middle", halo=True)

    # Compact Slonczewski equations under Panel a
    c.math_text(
        26.0,
        342.0,
        M("\\mathbf{T}_{SL,G} = \\Omega_{DL}\\,\\mathbf{m}\\times(\\hat{p}\\times\\mathbf{m}) + \\Omega_{FL}\\,\\mathbf{m}\\times\\hat{p}"),
        fill="ink",
        size=11.8,
    )
    c.math_text(
        26.0,
        366.0,
        M("\\Omega_J = \\gamma_e \\hbar J_{\\perp} / (e M_s t_F),\\quad \\Omega_{DL} = -\\Omega_J\\,\\epsilon_{DL}(\\theta),\\quad \\Omega_{FL} = \\Omega_J\\,\\epsilon'"),
        fill="ink_secondary",
        size=10.8,
    )

    # -----------------------------------------------------------------------
    # Vertical hairline divider
    # -----------------------------------------------------------------------
    panel_divider(c, 496.0, 18.0, 496.0, 378.0)

    # -----------------------------------------------------------------------
    # Panel b: Zhang-Li CIP domain-wall gradient torque
    # -----------------------------------------------------------------------
    panel_label(c, 514, 22, "b", "Zhang–Li CIP domain-wall torque")

    # Nanowire strip showing exact 1D Neel wall profile m(x) = (sech(x/Delta), 0, -tanh(x/Delta))
    wx, wy, ww, wh = 528.0, 108.0, 404.0, 88.0
    layer_slab(c, wx, wy, ww, wh, kind="fm", stroke_width=1.25)

    # Subtle vertical dashed guide at domain-wall center (below text label so zero strike-through)
    w_mid = wx + 0.5 * ww
    c.line(w_mid, wy + 38.0, w_mid, wy + wh + 6.0, stroke="hairline", stroke_width=0.9, dash="3,3")

    # Domain region labels cleanly in upper corners of strip
    c.math_text(wx + 12.0, wy + 18.0, M("+m_z"), fill="fm_stroke", size=11.2, bold=True)
    c.math_text(wx + ww - 12.0, wy + 18.0, M("-m_z"), fill="fm_stroke", size=11.2, bold=True, anchor="end")
    c.text(w_mid, wy + 17.0, "Domain wall", cls="fm-note", fill="accent_warm", anchor="middle")
    c.math_text(w_mid, wy + 31.0, M("(\\nabla\\mathbf{m} \\neq 0)"), fill="accent_warm", size=10.2, anchor="middle")

    # 11 analytically computed Neel wall spin arrows along the nanowire
    spin_y = wy + 60.0
    n_spins = 11
    for i in range(n_spins):
        u_coord = -3.4 + 6.8 * (i / (n_spins - 1))  # x / Delta
        sx_i = wx + 24.0 + (ww - 48.0) * (i / (n_spins - 1))
        mx_i = 1.0 / math.cosh(u_coord)
        mz_i = -math.tanh(u_coord)
        # Cartesian angle: 0=+x (right), +90=+z (up), -90=-z (down)
        ang = math.degrees(math.atan2(mz_i, mx_i))
        is_wall = abs(u_coord) <= 0.8
        spin_arrow(
            c,
            sx_i,
            spin_y,
            ang,
            length=28.0,
            color="accent_warm" if is_wall else "m",
            width=2.1 if is_wall else 1.85,
            size="sm",
        )

    # Adiabatic wall-displacement arrow above wall (wall translates along electron drift -x)
    vector_arrow(c, w_mid + 34.0, wy - 20.0, w_mid - 34.0, wy - 20.0, color="accent_warm", width=2.3, size="md")
    c.text(w_mid, wy - 44.0, "Adiabatic wall drag", cls="fm-label-bold", fill="accent_warm", anchor="middle", size=11.0)
    c.math_text(w_mid, wy - 29.0, M("-(\\mathbf{u}\\cdot\\nabla)\\mathbf{m}"), fill="accent_warm", size=11.2, anchor="middle")

    # Non-adiabatic out-of-plane canting symbol at wall center (just below strip)
    out_of_plane_symbol(c, w_mid, wy + wh + 24.0, direction="out", r=7.5, color="flux", width=1.5)
    c.text(w_mid + 14.0, wy + wh + 20.5, "Non-adiabatic canting", cls="fm-label-bold", fill="flux", size=10.8)
    c.math_text(w_mid + 14.0, wy + wh + 35.0, M("+\\beta\\,\\mathbf{m}\\times[(\\mathbf{u}\\cdot\\nabla)\\mathbf{m}]"), fill="flux", size=11.0)

    # Separated conventional current J_c (+x) vs electron drift (-x) arrows below
    y_curr = 266.0
    vector_arrow(c, wx + 10.0, y_curr, wx + 178.0, y_curr, color="H", width=2.5, size="md")
    c.math_text(wx + 94.0, y_curr + 18.0, M("\\mathbf{J}_c,\\; \\mathbf{u} \\; (+\\hat{x},\\; e > 0)"), fill="H", size=11.3, anchor="middle")

    vector_arrow(c, wx + ww - 10.0, y_curr, wx + ww - 178.0, y_curr, color="ink_muted", width=2.0, size="md", dash="5,3")
    c.text(wx + ww - 94.0, y_curr + 18.0, "Electron drift (−x)", cls="fm-sub", fill="ink_muted", anchor="middle", size=11.0)

    # Clean Zhang-Li governing equations under Panel b
    c.math_text(
        526.0,
        322.0,
        M("\\mathbf{u} = \\frac{g\\,\\mu_B\\,P}{2\\,e\\,M_s}\\,\\mathbf{J}_c"
          .replace("\\frac{g\\,\\mu_B\\,P}{2\\,e\\,M_s}", "[g\\,\\mu_B\\,P / (2\\,e\\,M_s)]")),
        fill="ink_secondary",
        size=11.5,
    )
    c.math_text(
        526.0,
        346.0,
        M("\\mathbf{T}_{ZL,G} = -(\\mathbf{u}\\cdot\\nabla)\\mathbf{m} + \\beta\\,\\mathbf{m}\\times[(\\mathbf{u}\\cdot\\nabla)\\mathbf{m}]"),
        fill="ink",
        size=11.8,
    )
    c.text(
        526.0,
        367.0,
        "Sign anchored to conventional charge current (e > 0) across FDM & FEM.",
        cls="fm-note",
        fill="ink_muted",
    )

    # -----------------------------------------------------------------------
    # Minimalist bottom Gilbert-to-explicit single-conversion invariant
    # -----------------------------------------------------------------------
    panel_divider(c, 16.0, 392.0, 944.0, 392.0)
    c.line(20.0, 404.0, 20.0, 434.0, stroke="ok", stroke_width=3.0)
    c.text(32.0, 417.0, "Single Gilbert-to-explicit RHS conversion", cls="fm-label-bold", fill="ok", size=11.4)
    c.math_text(
        294.0,
        417.0,
        M("\\mathbf{T}_{explicit} = (\\mathbf{T}_G + \\alpha\\,\\mathbf{m}\\times\\mathbf{T}_G) / (1 + \\alpha^2)"),
        fill="ink",
        size=12.2,
    )
    c.text(
        32.0,
        435.0,
        "Evaluated exactly once by backends before LLG integration; never pre-converted in Python authoring.",
        cls="fm-note",
        fill="ink_muted",
    )


# ===========================================================================
# 2. sot-models-comparison-local-m1-m2
# ===========================================================================


def _draw_sot_models_comparison_clean(c: SvgCanvas, t: Theme) -> None:
    panel_divider(c, 320.0, 18.0, 320.0, 380.0)
    panel_divider(c, 640.0, 18.0, 640.0, 380.0)

    y_t1, h_t1 = 70.0, 62.0
    y_t2, h_t2 = 172.0, 74.0
    y_t3, h_t3 = 290.0, 72.0
    nw = 264.0

    # --- Column a: Prescribed Local SOT ---
    panel_label(c, 16, 22, "a", "Prescribed local SOT", subtitle="Reduced algebraic law · no HM mesh")
    cx_a, nx_a = 160.0, 28.0

    flow_node(
        c,
        nx_a,
        y_t1,
        nw,
        h_t1,
        "Authored drive input",
        subtitle=[
            math_span(M("J_{signed},\\; \\hat{\\sigma},\\; t_F"))
            + " (scalar or vector drive)"
        ],
        accent="H",
        align="left",
        sub_markup=True,
    )
    vector_arrow(c, cx_a, y_t1 + h_t1, cx_a, y_t2 - 2.0, color="H", width=1.8, size="sm", dash="4,3")
    c.text(cx_a + 10.0, y_t1 + h_t1 + 23.0, "no transport PDE", cls="fm-note", fill="ink_muted")

    dashed_region(
        c,
        nx_a,
        y_t2,
        nw,
        h_t2,
        stroke="hairline",
        fill="surface_subtle",
        fill_opacity=0.45,
        dash="4.5,3.5",
    )
    c.text(cx_a, y_t2 + 21.0, "Effective reduced parameters", cls="fm-label-bold", fill="ink_secondary", anchor="middle", size=11.2)
    c.math_text(cx_a, y_t2 + 40.0, M("\\xi_{DL},\\; \\xi_{FL}\\; \\mathrm{calibrated\\; per\\; stack}"), fill="accent_warm", size=11.1, anchor="middle")
    c.text(
        cx_a,
        y_t2 + 58.0,
        "No " + math_span(M("V,\\; \\boldsymbol{\\mu}_s,\\; Q_{ia}")) + ", backflow, or iSHE",
        cls="fm-note",
        fill="ink_muted",
        anchor="middle",
        raw_markup=True,
    )

    vector_arrow(c, cx_a, y_t2 + h_t2, cx_a, y_t3 - 2.0, color="accent_warm", width=1.9, size="sm")
    c.text(cx_a + 10.0, y_t2 + h_t2 + 23.0, "local algebraic rate", cls="fm-note", fill="accent_warm")

    # Helper for crisp two-line math nodes with generous vertical clearance between sub/superscripts
    def _math_flow_node(
        x: float,
        y: float,
        w: float,
        h: float,
        title: str,
        line1: str,
        line2: str,
        *,
        accent: str,
        fill: str | None = None,
        stroke: str | None = None,
        title_markup: bool = False,
        line1_size: float = 10.2,
    ) -> None:
        bg = fill if fill is not None else "node_fill"
        bd = stroke if stroke is not None else accent
        c.rect(x, y, w, h, fill=bg, stroke=bd, stroke_width=1.05, rx=3.0)
        c.line(x + 1.4, y + 3.0, x + 1.4, y + h - 3.0, stroke=accent, stroke_width=2.6, linecap="round")
        tx = x + 11.0
        c.text(tx, y + 20.0, title, cls="fm-label-bold", fill="ink", size=11.5, raw_markup=title_markup)
        c.text(tx, y + 39.0, line1, cls="fm-note", fill="ink_secondary", size=line1_size, raw_markup=True)
        c.text(tx, y + 59.0, line2, cls="fm-note", fill="ink_secondary", size=10.2, raw_markup=True)

    _math_flow_node(
        nx_a,
        y_t3,
        nw,
        h_t3,
        "PrescribedSpinOrbitTorque",
        math_span(M("\\mathbf{T}_{SOT}=C_{DL}\\mathbf{m}\\times(\\hat{\\sigma}\\times\\mathbf{m})+C_{FL}\\mathbf{m}\\times\\hat{\\sigma}")),
        "Local LLG RHS on target mask",
        accent="m",
        fill="fm_fill",
        stroke="fm_stroke",
        line1_size=9.7,
    )

    # --- Column b: M1 One-Way Transport ---
    panel_label(c, 338, 22, "b", "M1: One-way transport", subtitle="Forward chain charge → spin → torque")
    cx_b, nx_b = 480.0, 348.0

    flow_node(
        c,
        nx_b,
        y_t1,
        nw,
        h_t1,
        "CurrentTransport (one-way)",
        subtitle=[
            math_span(M("\\nabla\\cdot(\\sigma\\mathbf{E}) = 0 \\;\\Rightarrow\\; (V,\\, \\mathbf{J}_c)")),
            "Conducting HM + FM mesh &amp; contacts",
        ],
        accent="H",
        fill="hm_fill",
        stroke="hm_stroke",
        align="left",
        sub_markup=True,
    )
    vector_arrow(c, cx_b, y_t1 + h_t1, cx_b, y_t2 - 2.0, color="H", width=2.0, size="md")
    c.text(cx_b + 10.0, y_t1 + h_t1 + 17.0, "fixed " + math_span(M("\\mathbf{J}_c")) + " field", cls="fm-note", fill="H", raw_markup=True)
    c.text(cx_b + 10.0, y_t1 + h_t1 + 31.0, "(no spin feedback)", cls="fm-note", fill="ink_muted")

    _math_flow_node(
        nx_b,
        y_t2,
        nw,
        h_t2,
        "SpinDriftDiffusion",
        math_span(M("\\partial_i Q_{ia} + R_{sf,a} + R_{J,a} + R_{\\phi,a} = 0")),
        "Direct SHE + HM/FM interface (" + math_span(M("G^{\\uparrow\\downarrow}")) + ")",
        accent="accent_warm",
    )
    vector_arrow(c, cx_b, y_t2 + h_t2, cx_b, y_t3 - 2.0, color="accent_warm", width=2.0, size="md")
    c.math_text(cx_b + 10.0, y_t2 + h_t2 + 23.0, M("\\mathbf{q}_{abs,\\perp} + \\mathbf{R}_J + \\mathbf{R}_{\\phi}"), fill="accent_warm", size=10.8)

    _math_flow_node(
        nx_b,
        y_t3,
        nw,
        h_t3,
        "DriftDiffusionSpinTorque",
        math_span(M("\\mathbf{T}_{tr,G} = -(\\gamma_e/M_s)(\\hbar/2e)\\,\\mathbf{R}_{abs}")),
        "Resolves " + math_span(M("t_{HM},\\; \\lambda_{sf}")) + ", crowding &amp; backflow",
        accent="m",
        fill="fm_fill",
        stroke="fm_stroke",
    )

    # --- Column c: M2 Reciprocal Onsager ---
    panel_label(
        c,
        658,
        22,
        "c",
        "M2: Reciprocal Onsager",
        subtitle="Coupled (" + math_span(M("V,\\; \\boldsymbol{\\mu}_s")) + ") steady block",
        subtitle_markup=True,
    )
    cx_c, nx_c = 800.0, 668.0

    dashed_region(
        c,
        nx_c - 8.0,
        y_t1 - 16.0,
        nw + 16.0,
        (y_t2 + h_t2) - (y_t1 - 16.0) + 10.0,
        stroke="accent_violet",
        fill="accent_violet_soft",
        fill_opacity=0.30,
        dash="4.5,3",
        label="Bidirectional (" + math_span(M("V,\\, \\boldsymbol{\\mu}_s")) + ")",
        label_pos="top-right",
        label_color="accent_violet",
        label_markup=True,
    )

    flow_node(
        c,
        nx_c,
        y_t1 + 12.0,
        nw,
        54.0,
        "Charge block (" + math_span(M("V,\\, \\mathbf{J}_c")) + ")",
        subtitle=[math_span(M("\\mathrm{AMR / PHE / AHE} + \\theta_{SH}\\sigma_s\\epsilon_{ija}G_{ja}"))],
        accent="H",
        align="left",
        sub_size=9.8,
        title_markup=True,
        sub_markup=True,
    )

    arr_down_x = cx_c - 44.0
    arr_up_x = cx_c + 44.0
    y_m2_top = y_t1 + 66.0
    y_m2_bot = y_t2 + 12.0
    vector_arrow(c, arr_down_x, y_m2_top + 2.0, arr_down_x, y_m2_bot - 2.0, color="H", width=2.0, size="md")
    c.text(arr_down_x - 8.0, 0.5 * (y_m2_top + y_m2_bot) + 4.0, "Direct SHE", cls="fm-note", fill="H", anchor="end")

    vector_arrow(c, arr_up_x, y_m2_bot - 2.0, arr_up_x, y_m2_top + 2.0, color="accent_violet", width=2.0, size="md")
    c.text(arr_up_x + 8.0, 0.5 * (y_m2_top + y_m2_bot) + 4.0, "iSHE + MR", cls="fm-note", fill="accent_violet", anchor="start")

    flow_node(
        c,
        nx_c,
        y_m2_bot,
        nw,
        62.0,
        "Spin block (" + math_span(M("\\boldsymbol{\\mu}_s,\\, Q_{ia}")) + ")",
        subtitle=[math_span(M("Q_{ia} = \\sigma_s G_{ia} + P\\sigma_s E_i m_a + \\theta_{SH}\\sigma_s\\epsilon_{ika}E_k"))],
        accent="accent_violet",
        align="left",
        sub_size=9.8,
        title_markup=True,
        sub_markup=True,
    )

    vector_arrow(c, cx_c, y_t2 + h_t2 + 10.0, cx_c, y_t3 - 2.0, color="accent_warm", width=2.0, size="md")
    c.text(cx_c + 10.0, y_t2 + h_t2 + 27.0, "self-consistent flux", cls="fm-note", fill="accent_warm")

    _math_flow_node(
        nx_c,
        y_t3,
        nw,
        h_t3,
        "Torque &amp; reciprocal observables",
        math_span(M("V,\\; \\mathbf{J}_c,\\; \\boldsymbol{\\mu}_s,\\; Q_{ia},\\; \\mathbf{T}_{tr,G}")),
        "SMR, iSHE voltage &amp; MR redistribution",
        accent="m",
        fill="fm_fill",
        stroke="fm_stroke",
        title_markup=True,
    )

    # --- Minimalist bottom double-counting guard ---
    panel_divider(c, 16.0, 392.0, 944.0, 392.0)
    c.line(20.0, 404.0, 20.0, 438.0, stroke="warn", stroke_width=3.0)
    c.text(
        32.0,
        417.0,
        f'<tspan font-weight="600" fill="{t.warn}">Additive RHS guard:</tspan> '
        "Adding both PrescribedSpinOrbitTorque and DriftDiffusionSpinTorque on the same RegionRef sums both terms.",
        cls="fm-sub",
        fill="ink",
        size=10.9,
        raw_markup=True,
    )
    c.text(
        32.0,
        436.0,
        "Setting "
        + math_span(M("\\xi_{DL} = \\theta_{SH}"))
        + " does not make local SOT equivalent to M1 or M2; compare models in separate studies or stages.",
        cls="fm-note",
        fill="ink_muted",
        raw_markup=True,
    )


# ===========================================================================
# 3. sot-unit-sphere-torques-and-drives
# ===========================================================================


def _draw_sot_unit_sphere_and_drives(c: SvgCanvas, t: Theme) -> None:
    # -----------------------------------------------------------------------
    # Panel a: Exact 3D unit sphere S^2 + tangent basis + Gilbert-to-explicit
    # -----------------------------------------------------------------------
    panel_label(
        c,
        16,
        22,
        "a",
        "Unit sphere " + math_span(M("S^2")) + " torques &amp; RHS mixing",
        title_markup=True,
    )

    # 3D orthographic unit sphere
    proj = unit_sphere(
        c,
        164.0,
        164.0,
        104.0,
        azim_deg=30.0,
        elev_deg=20.0,
        meridians_deg=(0.0, 90.0),
        latitudes_deg=(0.0,),
        axes=True,
        axis_labels=("x", "y", "z"),
    )

    # Exact unit vectors in 3D right-handed coordinates:
    #   sigma_hat = +y, H_eff = +z (PMA easy axis), m on upper-front hemisphere
    sigma = (0.0, 1.0, 0.0)
    th_m = math.radians(48.0)
    ph_m = math.radians(-26.0)
    m3 = (
        math.sin(th_m) * math.cos(ph_m),
        math.sin(th_m) * math.sin(ph_m),
        math.cos(th_m),
    )

    # Orthogonal tangent basis at m in T_m S^2:
    #   e_DL = norm(m x (sigma x m)) = norm(sigma - (m.sigma) m)
    #   e_FL = norm(m x sigma)
    e_dl = _norm(_cross(m3, _cross(sigma, m3)))
    e_fl = _norm(_cross(m3, sigma))

    # Meridian arc on S^2 from m toward +sigma (DL damping trajectory)
    dl_arc = []
    for k in range(36):
        frac = k / 35.0
        ang = frac * math.acos(max(-1.0, min(1.0, _dot(m3, sigma))))
        dl_arc.append(_norm(_add((m3[0] * math.cos(ang), m3[1] * math.cos(ang), m3[2] * math.cos(ang)), e_dl, math.sin(ang))))
    sphere_curve(c, proj, dl_arc, color="accent_warm", width=1.6, front_dash="4,3", back_opacity=0.25)

    # Precession circle around sigma passing through m (FL trajectory)
    my_val = _dot(m3, sigma)
    r_perp = math.sqrt(max(0.0, 1.0 - my_val * my_val))
    u1 = _norm((m3[0], 0.0, m3[2]))
    u2 = _cross(sigma, u1)
    fl_ring = []
    for k in range(73):
        psi = 2.0 * math.pi * k / 72.0
        pt = (
            r_perp * (math.cos(psi) * u1[0] + math.sin(psi) * u2[0]),
            my_val,
            r_perp * (math.cos(psi) * u1[2] + math.sin(psi) * u2[2]),
        )
        fl_ring.append(pt)
    sphere_curve(c, proj, fl_ring, color="flux", width=1.4, front_dash="3.5,3", back_opacity=0.22)

    # Exact tangent plane patch T_m S^2 spanned by (e_DL, e_FL)
    tangent_plane_patch(c, proj, m3, half_size=0.38, fill="surface_subtle", fill_opacity=0.58, stroke="hairline")

    # Right-angle orthogonality square in T_m S^2 between e_DL and e_FL
    sq = 0.12
    p_m = proj.pt2(m3)
    p_a = proj.pt2(_add(m3, e_dl, sq))
    p_ab = proj.pt2(_add(_add(m3, e_dl, sq), e_fl, sq))
    p_b = proj.pt2(_add(m3, e_fl, sq))
    c.polyline([p_a, p_ab, p_b], stroke="ink_muted", stroke_width=0.95)

    # Effective field H_eff along +z (slightly shorter than unit axis to stay crisp)
    h_tip = sphere_vector(c, proj, (0.0, 0.0, 0.0), (0.0, 0.0, 0.74), color="H", width=2.2, size="sm")
    c.math_text(h_tip[0] + 9.0, h_tip[1] + 2.0, M("\\mathbf{H}_{eff}"), fill="H", size=11.4, halo=True)

    # Spin polarization sigma_hat along +y (nudged cleanly clear of sphere rim)
    sig_tip = sphere_vector(c, proj, (0.0, 0.0, 0.0), sigma, color="accent_violet", width=2.5, size="md")
    c.math_text(sig_tip[0] + 10.0, sig_tip[1] - 6.0, M("\\hat{\\sigma}"), fill="accent_violet", size=12.4, bold=True, halo=True)

    # Unit magnetization vector m
    m_tip = sphere_vector(c, proj, (0.0, 0.0, 0.0), m3, color="m", width=2.8, size="md", tip_dot=True)
    c.math_text(m_tip[0] - 16.0, m_tip[1] + 10.0, M("\\mathbf{m}"), fill="m", size=12.6, bold=True, halo=True)

    # Tangent torque vectors T_DL^G and T_FL^G originating at tip of m
    # Scale DL past the vertical H_eff shaft so T_DL^G sits in crisp open space to the right
    dl_tip = sphere_vector(c, proj, m3, _add(m3, e_dl, 0.90), color="accent_warm", width=2.5, size="md")
    fl_tip = sphere_vector(c, proj, m3, _add(m3, e_fl, 0.46), color="flux", width=2.5, size="md")
    c.math_text(dl_tip[0] + 6.0, dl_tip[1] + 5.0, M("\\mathbf{T}_{DL}^G"), fill="accent_warm", size=11.8, bold=True, halo=True)
    c.math_text(fl_tip[0] - 8.0, fl_tip[1] - 5.0, M("\\mathbf{T}_{FL}^G"), fill="flux", size=11.8, bold=True, anchor="end", halo=True)

    # Tangent plane label T_m S^2 placed cleanly near lower-left corner of patch
    p_tp = proj.pt2(_add(_add(m3, e_dl, -0.34), e_fl, -0.34))
    c.math_text(p_tp[0] - 6.0, p_tp[1] + 8.0, M("T_m S^2"), fill="ink_muted", size=10.5, anchor="end", halo=True)

    # Right of sphere (still Panel a): clean borderless torque definitions
    kx = 304.0
    c.text(kx, 74.0, "Damping-like (DL)", cls="fm-label-bold", fill="accent_warm", size=11.4)
    c.math_text(kx, 93.0, M("\\mathbf{T}_{DL}^G = \\Omega_{DL}\\,\\mathbf{m}\\times(\\hat{\\sigma}\\times\\mathbf{m})"), fill="ink", size=11.5)
    c.text(kx, 109.0, "Rotates m toward/away from σ̂", cls="fm-note", fill="ink_muted")

    c.text(kx, 144.0, "Field-like (FL)", cls="fm-label-bold", fill="flux", size=11.4)
    c.math_text(kx, 163.0, M("\\mathbf{T}_{FL}^G = \\Omega_{FL}\\,\\mathbf{m}\\times\\hat{\\sigma}"), fill="ink", size=11.5)
    c.text(kx, 179.0, "Precesses m around σ̂ (⊥ T_DL)".replace("T_DL", math_span(M("\\mathbf{T}_{DL}"))), cls="fm-note", fill="ink_muted", raw_markup=True)

    panel_divider(c, kx, 198.0, 474.0, 198.0, dashed=True)
    c.text(kx, 218.0, "Base rate & Gilbert rates", cls="fm-label-bold", fill="ink_secondary", size=11.0)
    c.math_text(kx, 238.0, M("\\Omega_0 = \\gamma_e\\,\\hbar\\,J_{signed} / (2\\,e\\,M_s\\,t_F)"), fill="ink", size=11.2)
    c.math_text(kx, 258.0, M("\\Omega_{DL} = \\xi_{DL}\\,\\Omega_0,\\quad \\Omega_{FL} = \\xi_{FL}\\,\\Omega_0"), fill="ink_secondary", size=11.0)

    # Lower Panel a: Minimalist Gilbert-to-explicit RHS mixing diagram
    panel_divider(c, 18.0, 294.0, 474.0, 294.0)
    c.text(
        22.0,
        314.0,
        "Gilbert-to-explicit RHS mixing (applied once by backends)",
        cls="fm-label-bold",
        fill="ink",
        size=11.2,
    )

    lx, lw, nh = 22.0, 108.0, 44.0
    rx, rw = 248.0, 224.0
    y_top, y_bot = 330.0, 392.0

    flow_node(c, lx, y_top, lw, nh, "Authored " + math_span(M("\\xi_{DL}")), subtitle="physical input", accent="accent_warm", title_markup=True)
    flow_node(c, lx, y_bot, lw, nh, "Authored " + math_span(M("\\xi_{FL}")), subtitle="physical input", accent="flux", title_markup=True)

    flow_node(
        c,
        rx,
        y_top,
        rw,
        nh,
        math_span(M("C_{DL} = \\Omega_0(\\xi_{DL} - \\alpha\\xi_{FL})/(1+\\alpha^2)")),
        subtitle="explicit DL coefficient",
        accent="accent_warm",
        title_markup=True,
        title_size=10.8,
    )
    flow_node(
        c,
        rx,
        y_bot,
        rw,
        nh,
        math_span(M("C_{FL} = \\Omega_0(\\xi_{FL} + \\alpha\\xi_{DL})/(1+\\alpha^2)")),
        subtitle="explicit FL coefficient",
        accent="flux",
        title_markup=True,
        title_size=10.8,
    )

    # Straight + crossed mixing arrows
    x_a1, x_a2 = lx + lw + 3.0, rx - 3.0
    ym_top, ym_bot = y_top + 0.5 * nh, y_bot + 0.5 * nh
    vector_arrow(c, x_a1, ym_top, x_a2, ym_top, color="accent_warm", width=1.8, size="sm")
    vector_arrow(c, x_a1, ym_bot, x_a2, ym_bot, color="flux", width=1.8, size="sm")
    vector_arrow(c, x_a1 + 2.0, ym_top + 6.0, x_a2 - 2.0, ym_bot - 6.0, color="accent_warm", width=1.4, size="sm", dash="4,3")
    vector_arrow(c, x_a1 + 2.0, ym_bot - 6.0, x_a2 - 2.0, ym_top + 6.0, color="flux", width=1.4, size="sm", dash="4,3")

    xm_mid = 0.5 * (x_a1 + x_a2)
    c.math_text(xm_mid, ym_top - 7.0, M("+1/(1+\\alpha^2)"), fill="accent_warm", size=10.0, anchor="middle")
    c.math_text(xm_mid, ym_bot + 14.0, M("+1/(1+\\alpha^2)"), fill="flux", size=10.0, anchor="middle")
    c.math_text(xm_mid, 0.5 * (ym_top + ym_bot) - 10.0, M("-\\alpha"), fill="flux", size=10.3, anchor="middle", halo=True)
    c.math_text(xm_mid, 0.5 * (ym_top + ym_bot) + 17.0, M("+\\alpha"), fill="accent_warm", size=10.3, anchor="middle", halo=True)

    c.math_text(
        248.0,
        458.0,
        M("\\mathbf{T}_{SOT} = C_{DL}\\,\\mathbf{m}\\times(\\hat{\\sigma}\\times\\mathbf{m}) + C_{FL}\\,\\mathbf{m}\\times\\hat{\\sigma}"),
        fill="ink",
        size=11.6,
        anchor="middle",
    )

    # -----------------------------------------------------------------------
    # Vertical hairline divider
    # -----------------------------------------------------------------------
    panel_divider(c, 492.0, 18.0, 492.0, 462.0)

    # -----------------------------------------------------------------------
    # Panel b: HM/FM stack convention + SignedScalarDrive vs VectorCurrentDrive
    # -----------------------------------------------------------------------
    panel_label(c, 510, 22, "b", "HM/FM stack &amp; authoring drives", title_markup=True)

    # Right-handed isometric HM/FM bilayer (x = right, y = up-right receding, z = up)
    bx, bw = 556.0, 246.0
    bdx, bdy = 38.0, -22.0
    y_hm, h_hm = 148.0, 48.0
    y_fm, h_fm = 100.0, 48.0

    iso_slab(c, bx, y_hm, bw, h_hm, bdx, bdy, kind="hm")
    iso_slab(c, bx, y_fm, bw, h_fm, bdx, bdy, kind="fm")

    # Labels inside front faces
    c.text(bx + 10.0, y_fm + 20.0, "Ferromagnet (FM)", cls="fm-label-bold", fill="fm_stroke", size=11.2)
    c.text(bx + 10.0, y_fm + 36.0, "RegionRef target", cls="fm-code", fill="ink_secondary", size=9.8)
    c.text(bx + 10.0, y_hm + 20.0, "Heavy metal (HM)", cls="fm-label-bold", fill="hm_stroke", size=11.2)
    c.text(bx + 10.0, y_hm + 36.0, "Unmeshed in local SOT", cls="fm-note", fill="ink_muted", size=9.8)

    # Thickness bracket t_F cleanly OUTSIDE left of FM slab
    bracket_dim(
        c,
        bx - 4.0,
        y_fm,
        bx - 4.0,
        y_fm + h_fm,
        label=M("t_F"),
        offset=10.0,
        color="ink_muted",
        label_offset=8.0,
    )

    # Magnetization vector m in FM
    vector_arrow(c, bx + 170.0, y_fm + 38.0, bx + 216.0, y_fm + 12.0, color="m", width=2.6, size="md")
    c.math_text(bx + 223.0, y_fm + 17.0, M("\\mathbf{m}"), fill="m", size=12.0, bold=True)

    # Current arrow J_c || t_hat along +x in HM
    vector_arrow(c, bx + 148.0, y_hm + 30.0, bx + 230.0, y_hm + 30.0, color="H", width=2.6, size="md")
    c.math_text(bx + 190.0, y_hm + 20.0, M("\\mathbf{J}_c \\parallel \\hat{t}"), fill="H", size=11.0, anchor="middle")

    # Interface normal n_NF pointing +z across HM -> FM cleanly clear of left labels
    vector_arrow(c, bx + 136.0, y_hm + 16.0, bx + 136.0, y_fm + 26.0, color="axis", width=1.8, size="sm")
    c.math_text(bx + 142.0, y_fm + 38.0, M("\\hat{n}_{NF}"), fill="ink_secondary", size=10.6, anchor="start")

    # Right-handed coordinate triad on right of bilayer (x right, y receding up-right, z up)
    tx, ty = 868.0, 166.0
    vector_arrow(c, tx, ty, tx + 40.0, ty, color="H", width=1.8, size="sm")
    c.math_text(tx + 46.0, ty + 4.0, M("\\hat{t} = +\\hat{x}"), fill="H", size=10.5, anchor="start")
    vector_arrow(c, tx, ty, tx, ty - 40.0, color="axis", width=1.8, size="sm")
    c.math_text(tx, ty - 46.0, M("\\hat{n}_{NF} = +\\hat{z}"), fill="ink_secondary", size=10.5, anchor="middle")
    vector_arrow(c, tx, ty, tx + 32.0, ty - 19.0, color="accent_violet", width=2.2, size="sm")
    c.math_text(tx + 36.0, ty - 21.0, M("\\hat{\\sigma} = +\\hat{y}"), fill="accent_violet", size=10.6, bold=True, anchor="start")
    c.math_text(tx + 12.0, ty + 24.0, M("\\hat{\\sigma} = \\hat{n}_{NF}\\times\\hat{t}"), fill="accent_violet", size=10.6, anchor="middle")

    # --- Drive Option 1: SignedScalarDrive ---
    panel_divider(c, 510.0, 218.0, 944.0, 218.0)
    c.text(514.0, 238.0, "1. SignedScalarDrive", cls="fm-label-bold", fill="H", size=11.6)
    c.text(650.0, 238.0, "prescribed amplitude &amp; envelope", cls="fm-note", fill="ink_muted", raw_markup=True)
    c.math_text(514.0, 260.0, M("J_{signed}(t) = J_0\\,f(t),\\qquad \\hat{\\sigma} = \\boldsymbol{\\sigma} / \\lVert\\boldsymbol{\\sigma}\\rVert"), fill="ink", size=11.4)
    c.text(514.0, 281.0, "No CurrentTransport solve; 6 envelopes " + math_span(M("f(t)")) + ":", cls="fm-note", fill="ink_secondary", raw_markup=True)
    c.text(514.0, 300.0, "Constant · Pulse · Sinusoidal · PiecewiseLinear · Sinc · Tabulated", cls="fm-code", fill="ink_muted", size=9.6)

    # Compact sparklines of 3 canonical envelopes (Pulse, Sinusoidal, Sinc) well clear on right
    ex0 = 774.0
    c.polyline(
        [(ex0, 272.0), (ex0 + 10.0, 272.0), (ex0 + 10.0, 250.0), (ex0 + 32.0, 250.0), (ex0 + 32.0, 272.0), (ex0 + 42.0, 272.0)],
        stroke="H",
        stroke_width=1.6,
    )
    c.text(ex0 + 21.0, 284.0, "Pulse", cls="fm-tick", anchor="middle")

    sx0 = ex0 + 54.0
    sin_pts = [(sx0 + 44.0 * k / 32.0, 261.0 - 10.0 * math.sin(2.0 * math.pi * k / 16.0)) for k in range(33)]
    c.path(curve_path(sin_pts), stroke="flux", stroke_width=1.6)
    c.text(sx0 + 22.0, 284.0, "Sinusoidal", cls="fm-tick", anchor="middle")

    scx0 = ex0 + 110.0
    sinc_pts = []
    for k in range(41):
        u = -3.0 + 6.0 * k / 40.0
        val = 1.0 if abs(u) < 1e-6 else math.sin(math.pi * u) / (math.pi * u)
        sinc_pts.append((scx0 + 48.0 * k / 40.0, 268.0 - 18.0 * val))
    c.path(curve_path(sinc_pts), stroke="accent_warm", stroke_width=1.6)
    c.text(scx0 + 24.0, 284.0, "Sinc", cls="fm-tick", anchor="middle")

    # --- Drive Option 2: VectorCurrentDrive ---
    panel_divider(c, 510.0, 316.0, 944.0, 316.0)
    c.text(514.0, 336.0, "2. VectorCurrentDrive", cls="fm-label-bold", fill="accent_violet", size=11.6)
    c.text(656.0, 336.0, "bound to named CurrentTransport source", cls="fm-note", fill="ink_muted")
    c.math_text(
        514.0,
        358.0,
        M("J_{signed} = \\mathbf{J}_c\\cdot\\hat{t},\\qquad \\hat{\\sigma} = (\\hat{n}_{NF}\\times\\hat{t})/\\lVert\\hat{n}_{NF}\\times\\hat{t}\\rVert"),
        fill="ink",
        size=11.4,
    )

    # Current-reversal invariance side-by-side comparison (NO red/green boxes!)
    y_rev = 384.0
    # Forward
    c.text(514.0, y_rev, "Forward current", cls="fm-label-bold", fill="H", size=10.8)
    vector_arrow(c, 514.0, y_rev + 18.0, 582.0, y_rev + 18.0, color="H", width=2.3, size="md")
    c.math_text(590.0, y_rev + 22.0, M("J_{signed} = +J_0 > 0"), fill="ink", size=10.8)
    vector_arrow(c, 526.0, y_rev + 52.0, 558.0, y_rev + 34.0, color="accent_violet", width=2.1, size="sm")
    c.math_text(566.0, y_rev + 48.0, M("\\hat{\\sigma} = +\\hat{y}"), fill="accent_violet", size=10.8)

    panel_divider(c, 718.0, y_rev - 10.0, 718.0, y_rev + 60.0, dashed=True)

    # Reversed
    c.text(732.0, y_rev, "Reversed current", cls="fm-label-bold", fill="ok", size=10.8)
    vector_arrow(c, 798.0, y_rev + 18.0, 732.0, y_rev + 18.0, color="H", width=2.3, size="md")
    c.math_text(806.0, y_rev + 22.0, M("J_{signed} = -J_0 < 0"), fill="ink", size=10.8)
    vector_arrow(c, 742.0, y_rev + 52.0, 774.0, y_rev + 34.0, color="accent_violet", width=2.1, size="sm")
    c.math_text(782.0, y_rev + 48.0, M("\\hat{\\sigma}\\; \\mathrm{fixed}\\; (+\\hat{y}) \\Rightarrow -\\mathbf{T}"), fill="ok", size=10.6)

    c.text(
        514.0,
        460.0,
        "Authored axes (t̂, n̂_NF) never flip with Jc, guaranteeing exact odd scaling under current reversal."
        .replace("t̂, n̂_NF", math_span(M("\\hat{t},\\; \\hat{n}_{NF}")))
        .replace("Jc", math_span(M("\\mathbf{J}_c"))),
        cls="fm-note",
        fill="ink_muted",
        raw_markup=True,
    )


# ===========================================================================
# 4. sot-switching-and-calibration-regimes
# ===========================================================================


def _compute_pma_sot_loop(hx_val: float, alpha: float = 0.25) -> tuple[list[float], list[float], list[float], list[float]]:
    """Compute exact steady-state pulse-and-relax macrospin LLG+SOT switching loop via RK4."""
    inv_a = 1.0 / (1.0 + alpha * alpha)
    sigma = (0.0, 1.0, 0.0)

    def evolve(j_val: float, m0: tuple[float, float, float], dur: float) -> tuple[float, float, float]:
        def rhs(_t: float, m: tuple[float, ...]) -> tuple[float, float, float]:
            heff = (hx_val, 0.0, m[2])  # normalized PMA H_k^eff = 1 along z + assist h_x
            mxh = _cross(m, heff)
            mxmxh = _cross(m, mxh)
            tdl_g = _cross(m, _cross(sigma, m))
            mxtdl = _cross(m, tdl_g)
            return (
                inv_a * (-mxh[0] - alpha * mxmxh[0] + j_val * (tdl_g[0] + alpha * mxtdl[0])),
                inv_a * (-mxh[1] - alpha * mxmxh[1] + j_val * (tdl_g[1] + alpha * mxtdl[1])),
                inv_a * (-mxh[2] - alpha * mxmxh[2] + j_val * (tdl_g[2] + alpha * mxtdl[2])),
            )

        _, ys = rk4_integrate(rhs, m0, (0.0, dur), 0.15, normalize=True)
        return (ys[-1][0], ys[-1][1], ys[-1][2])

    # Pulse-and-readout sweep (Liu et al. 2012 / Garello et al. 2013 protocol):
    # fully damp pulse state (dur=90) then relax to zero-current remanence under constant B_x
    j_max = 0.65
    n_pts = 53
    j_norm_fwd = [-1.0 + 2.0 * k / (n_pts - 1) for k in range(n_pts)]
    j_norm_rev = list(reversed(j_norm_fwd))

    m_cur = evolve(0.0, evolve(-j_max, (0.10, 0.02, 0.994 if hx_val < 0 else -0.994), 90.0), 60.0)
    mz_fwd: list[float] = []
    for jn in j_norm_fwd:
        m_pulse = evolve(jn * j_max, m_cur, 90.0)
        m_cur = evolve(0.0, m_pulse, 60.0)
        mz_fwd.append(m_cur[2])

    mz_rev: list[float] = []
    for jn in j_norm_rev:
        m_pulse = evolve(jn * j_max, m_cur, 90.0)
        m_cur = evolve(0.0, m_pulse, 60.0)
        mz_rev.append(m_cur[2])

    return j_norm_fwd, mz_fwd, j_norm_rev, mz_rev


def _draw_sot_switching_and_calibration(c: SvgCanvas, t: Theme) -> None:
    # -----------------------------------------------------------------------
    # Panel a: Type-z PMA switching (computed loop) vs Type-y field-free
    # -----------------------------------------------------------------------
    panel_label(
        c,
        16,
        22,
        "a",
        "Switching regimes: Type-" + math_span(M("z")) + " vs Type-" + math_span(M("y")),
        title_markup=True,
    )

    # --- Top-left: Type-z PMA stack schematic ---
    c.text(22.0, 52.0, "Type-z PMA (assist field " + math_span(M("B_x \\parallel \\hat{t}")) + ")", cls="fm-label-bold", fill="ink", size=11.0, raw_markup=True)
    # Assist field arrow B_x above FM
    vector_arrow(c, 34.0, 72.0, 120.0, 72.0, color="H", width=2.2, size="md")
    c.math_text(127.0, 76.0, M("\\mathbf{B}_x"), fill="H", size=11.5, bold=True)

    # FM / HM slabs
    layer_slab(c, 26.0, 86.0, 148.0, 50.0, kind="fm")
    c.text(34.0, 105.0, "PMA FM", cls="fm-label-bold", fill="fm_stroke", size=10.8)
    c.math_text(34.0, 123.0, M("\\mathbf{m}_{eq} = \\pm\\hat{z}"), fill="ink_secondary", size=10.5)
    vector_arrow(c, 128.0, 128.0, 128.0, 94.0, color="m", width=2.4, size="sm")
    vector_arrow(c, 152.0, 94.0, 152.0, 128.0, color="m", width=1.9, size="sm", dash="3.5,2.5")

    layer_slab(c, 26.0, 138.0, 148.0, 38.0, kind="hm")
    c.text(34.0, 160.0, "HM", cls="fm-label-bold", fill="hm_stroke", size=10.8)
    vector_arrow(c, 68.0, 157.0, 134.0, 157.0, color="H", width=2.2, size="sm")
    c.math_text(140.0, 161.0, M("J_c"), fill="H", size=10.8)

    c.text(26.0, 198.0, "Deterministic switching:", cls="fm-label-bold", fill="ink_secondary", size=10.4)
    c.math_text(26.0, 216.0, M("\\mathrm{sgn}(J_{signed} \\cdot B_x \\cdot \\xi_{DL})"), fill="ink", size=11.0)
    c.text(26.0, 234.0, "At " + math_span(M("B_x = 0")) + ": canted to equator", cls="fm-note", fill="ink_muted", raw_markup=True)

    # --- Top-right: Computed macrospin LLG+SOT switching loops ---
    pf_sw = axes_2d(
        c,
        228.0,
        66.0,
        236.0,
        162.0,
        xlim=(-1.05, 1.05),
        ylim=(-1.18, 1.18),
        xlabel=M("J_{signed} / J_{c0}"),
        ylabel=M("m_z"),
        xticks=(-1.0, -0.5, 0.0, 0.5, 1.0),
        xtick_labels=("−1", "−0.5", "0", "0.5", "+1"),
        yticks=(-1.0, 0.0, 1.0),
        ytick_labels=("−1", "0", "+1"),
        grid=True,
        zero_lines=True,
        xlabel_offset=27.0,
        ylabel_offset=28.0,
    )

    jf_p, mzf_p, jr_p, mzr_p = _compute_pma_sot_loop(+0.18)
    jf_n, mzf_n, jr_n, mzr_n = _compute_pma_sot_loop(-0.18)

    # Plot -B_x dashed crimson first, then +B_x solid cobalt on top
    pf_sw.plot_curve(jf_n, mzf_n, color="m", width=1.9, dash="4.5,3")
    pf_sw.plot_curve(jr_n, mzr_n, color="m", width=1.9, dash="4.5,3")
    pf_sw.plot_curve(jf_p, mzf_p, color="H", width=2.2)
    pf_sw.plot_curve(jr_p, mzr_p, color="H", width=2.2)

    # Subtle sweep direction arrows on the +B_x loop branches
    x_arr_t, y_arr_t = pf_sw.pt(-0.15, 0.98)
    vector_arrow(c, x_arr_t + 14.0, y_arr_t, x_arr_t - 10.0, y_arr_t, color="H", width=1.4, size="sm")
    x_arr_b, y_arr_b = pf_sw.pt(0.15, -0.98)
    vector_arrow(c, x_arr_b - 14.0, y_arr_b, x_arr_b + 10.0, y_arr_b, color="H", width=1.4, size="sm")

    # Borderless legend above switching plot
    legend_strip(
        c,
        232.0,
        54.0,
        [
            (math_span(M("+B_x")) + " (CCW)", "H", "solid"),
            (math_span(M("-B_x")) + " (CW)", "m", "dashed"),
        ],
        item_widths=(112.0, 108.0),
    )

    # --- Bottom of Panel a: Type-y field-free in-plane switching ---
    panel_divider(c, 20.0, 274.0, 470.0, 274.0, dashed=True)
    c.text(
        22.0,
        296.0,
        "Type-" + math_span(M("y")) + " in-plane (" + math_span(M("\\mathbf{m}_{eq} \\parallel \\pm\\hat{\\sigma} = \\pm\\hat{y}")) + "): field-free (" + math_span(M("B_x = 0")) + ")",
        cls="fm-label-bold",
        fill="ink",
        size=11.0,
        raw_markup=True,
    )

    # Compact FM/HM stack on left
    layer_slab(c, 26.0, 314.0, 148.0, 46.0, kind="fm")
    c.text(34.0, 333.0, "In-plane FM", cls="fm-label-bold", fill="fm_stroke", size=10.6)
    c.math_text(34.0, 349.0, M("\\pm\\hat{y} \\parallel \\pm\\hat{\\sigma}"), fill="ink_secondary", size=10.4)
    # In-plane ±y indicator (dot/cross pair for ±y axis)
    out_of_plane_symbol(c, 134.0, 337.0, direction="out", r=7.5, color="m", width=1.5, fill="fm_fill")
    out_of_plane_symbol(c, 156.0, 337.0, direction="in", r=7.5, color="m", width=1.5, fill="fm_fill")

    layer_slab(c, 26.0, 362.0, 148.0, 34.0, kind="hm")
    c.text(34.0, 382.0, "HM", cls="fm-label-bold", fill="hm_stroke", size=10.6)
    vector_arrow(c, 68.0, 379.0, 134.0, 379.0, color="H", width=2.1, size="sm")
    c.math_text(140.0, 383.0, M("J_c"), fill="H", size=10.6)

    # Collinear anti-damping mechanism on right (clean, borderless)
    c.text(196.0, 326.0, "Collinear anti-damping balance", cls="fm-label-bold", fill="accent_warm", size=11.0)
    # Visual opposing torque arrows
    vector_arrow(c, 200.0, 348.0, 274.0, 348.0, color="accent_warm", width=2.2, size="md")
    c.math_text(282.0, 352.0, M("\\mathbf{T}_{DL}\\; (\\mathrm{anti\\text{-}damping})".replace("\\text{-}", "-")), fill="accent_warm", size=10.8)
    vector_arrow(c, 274.0, 368.0, 200.0, 368.0, color="ink_muted", width=1.9, size="md", dash="4,3")
    c.math_text(282.0, 372.0, M("-\\alpha\\gamma_0\\,\\mathbf{m}\\times(\\mathbf{m}\\times\\mathbf{H}_{eff})"), fill="ink_secondary", size=10.8)

    c.math_text(
        196.0,
        398.0,
        M("J_c \\propto \\alpha\\,(H_k + M_{eff}/2),\\quad \\mathrm{polarity\\; toggles}\\; -\\hat{y} \\leftrightarrow +\\hat{y}"),
        fill="ink_secondary",
        size=10.6,
    )
    c.text(26.0, 426.0, "Macrospin LLG+SOT trajectories computed via RK4 (Liu et al. 2012; Manchon et al. 2019).", cls="fm-note", fill="ink_muted")

    # -----------------------------------------------------------------------
    # Vertical hairline divider
    # -----------------------------------------------------------------------
    panel_divider(c, 490.0, 18.0, 490.0, 434.0)

    # -----------------------------------------------------------------------
    # Panel b: Effective xi_DL(t_HM) vs bulk theta_SH spin-diffusion scaling
    # -----------------------------------------------------------------------
    panel_label(
        c,
        508,
        22,
        "b",
        "Effective " + math_span(M("\\xi_{DL}(t_{HM})")) + " vs bulk " + math_span(M("\\theta_{SH}")),
        title_markup=True,
    )

    pf = axes_2d(
        c,
        566.0,
        62.0,
        366.0,
        256.0,
        xlim=(0.0, 8.0),
        ylim=(0.0, 0.232),
        xlabel=M("t_{HM}\\; \\mathrm{(nm)}"),
        ylabel=M("\\xi_{DL},\\; \\theta_{SH}"),
        xticks=(0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0),
        yticks=(0.0, 0.05, 0.10, 0.15, 0.20),
        ytick_labels=("0.00", "0.05", "0.10", "0.15", "0.20"),
        grid=True,
        xlabel_offset=30.0,
        ylabel_offset=42.0,
    )

    # Shaded Pt optimal thickness window (2.8 - 3.9 nm, Nguyen et al. 2016)
    x_pt1, x_pt2 = pf.px(2.8), pf.px(3.9)
    c.rect(x_pt1, pf.y0, x_pt2 - x_pt1, pf.height, fill="accent_warm_soft", fill_opacity=0.65)
    c.text(0.5 * (x_pt1 + x_pt2), pf.y0 + 14.0, "Pt peak", cls="fm-note", fill="accent_warm", anchor="middle", weight=600)
    c.text(0.5 * (x_pt1 + x_pt2), pf.y0 + 26.5, "2.8–3.9 nm", cls="fm-tick", fill="accent_warm", anchor="middle")

    # Exact spin-diffusion thickness curves: xi_DL(t) = T_int * theta_SH * [1 - sech(t / lam_sf)]
    lam_sf = 1.1
    theta_sh = 0.20
    t_int = 0.66
    ts_nm = [8.0 * k / 160.0 for k in range(161)]
    y_ideal = [theta_sh * (1.0 - 1.0 / math.cosh(z / lam_sf)) for z in ts_nm]
    y_eff = [t_int * theta_sh * (1.0 - 1.0 / math.cosh(z / lam_sf)) for z in ts_nm]

    # Asymptotic reference lines
    pf.hline(theta_sh, color="H", width=1.2, dash="5,3.5")
    pf.hline(t_int * theta_sh, color="accent_warm", width=1.1, dash="3.5,3")

    pf.plot_curve(ts_nm, y_ideal, color="H", width=2.0, dash="6,3.5")
    pf.plot_curve(ts_nm, y_eff, color="accent_warm", width=2.6)

    # Highlighted Pt literature point at t_HM = 3.35 nm -> xi_DL ~ 0.120
    t_pt = 3.35
    xi_pt = t_int * theta_sh * (1.0 - 1.0 / math.cosh(t_pt / lam_sf))
    pf.scatter([t_pt], [xi_pt], r=4.4, fill="accent_warm", stroke="surface_ref", stroke_width=1.4)
    px_pt, py_pt = pf.pt(t_pt, xi_pt)
    c.line(px_pt + 4.0, py_pt + 4.0, px_pt + 18.0, py_pt + 26.0, stroke="accent_warm", stroke_width=1.0)
    c.math_text(px_pt + 21.0, py_pt + 33.0, M("\\xi_{DL} = 0.12\\; \\mathrm{(Pt,\\; 3.35\\,nm)}"), fill="accent_warm", size=10.5, halo=True)

    # Direct curve labels
    c.math_text(
        pf.px(7.92),
        pf.py(theta_sh) - 8.0,
        M("\\mathrm{Bulk\\; } \\theta_{SH} = 0.20\\; (T_{int} = 1)"),
        fill="H",
        size=10.3,
        anchor="end",
        halo=True,
    )
    c.math_text(
        pf.px(7.92),
        pf.py(t_int * theta_sh) + 16.0,
        M("\\mathrm{Effective\\; } \\xi_{DL}^{\\infty} = T_{int}\\theta_{SH}"),
        fill="accent_warm",
        size=10.3,
        anchor="end",
        halo=True,
    )

    # Interface loss double-arrow gap between T_int=1 and T_int=0.66
    gx = pf.px(6.75)
    vector_arrow(c, gx, pf.py(theta_sh) + 4.0, gx, pf.py(t_int * theta_sh) - 4.0, color="m", width=1.6, size="sm", double=True)
    c.text(gx - 8.0, 0.5 * (pf.py(theta_sh) + pf.py(t_int * theta_sh)) - 3.0, "Interface loss", cls="fm-note", fill="m", anchor="end", weight=600, halo=True)
    c.math_text(gx - 8.0, 0.5 * (pf.py(theta_sh) + pf.py(t_int * theta_sh)) + 11.0, M("T_{int} < 1\\; \\mathrm{(backflow)}"), fill="m", size=10.2, anchor="end", halo=True)

    # Thin-film reflection regime note near rising shoulder
    c.math_text(pf.px(1.65), pf.py(0.036), M("t_{HM} \\lesssim \\lambda_{sf}"), fill="ink_secondary", size=10.5, anchor="start", halo=True)
    c.text(pf.px(1.65), pf.py(0.017), "spin reflection", cls="fm-tick", fill="ink_muted", anchor="start", halo=True)

    # Clean bottom equation & calibration note under Panel b
    c.math_text(
        522.0,
        382.0,
        M("\\xi_{DL}(t_{HM}) = T_{int}\\,\\theta_{SH}\\,[1 - \\mathrm{sech}(t_{HM}/\\lambda_{sf})]"),
        fill="ink",
        size=11.8,
    )
    c.text(
        522.0,
        403.0,
        "Illustrative parameters: "
        + math_span(M("\\lambda_{sf} = 1.1\\,\\mathrm{nm},\\; \\theta_{SH} = 0.20,\\; T_{int} = 0.66"))
        + " (Nguyen et al. 2016).",
        cls="fm-note",
        fill="ink_secondary",
        raw_markup=True,
    )
    c.text(
        522.0,
        422.0,
        "Calibrate ("
        + math_span(M("\\xi_{DL},\\, \\xi_{FL}"))
        + ") per stack for local SOT; use M1/M2 to predict thickness &amp; backflow.",
        cls="fm-note",
        fill="ink_muted",
        raw_markup=True,
    )


# ===========================================================================
# 5. spin-hall-hm-fm
# ===========================================================================


def _draw_spin_hall_hm_fm(c: SvgCanvas, t: Theme) -> None:
    # True right-handed isometric HM/FM bilayer:
    #   +x = right (1, 0), +y = receding up-right (+0.62, -0.38), +z = straight up (0, -1)
    #   Check: x_hat x y_hat = z_hat  AND  n_hat x E_hat = z_hat x x_hat = +y_hat!
    bx, bw = 54.0, 488.0
    bdx, bdy = 82.0, -50.0
    y_hm, h_hm = 216.0, 128.0
    y_fm, h_fm = 104.0, 112.0

    # Draw HM bottom slab, then FM top slab cleanly sitting atop HM
    iso_slab(c, bx, y_hm, bw, h_hm, bdx, bdy, kind="hm", stroke_width=1.25)
    iso_slab(c, bx, y_fm, bw, h_fm, bdx, bdy, kind="fm", stroke_width=1.25)

    # Crisp highlighted HM/FM interface plane seam (front + right side edge)
    c.line(bx, y_hm, bx + bw, y_hm, stroke="accent_violet", stroke_width=2.1)
    c.line(bx + bw, y_hm, bx + bw + bdx, y_hm + bdy, stroke="accent_violet", stroke_width=1.8)

    # Layer labels on left side of front faces
    c.text(bx + 16.0, y_fm + 26.0, "Ferromagnet (FM)", cls="fm-label-bold", fill="fm_stroke", size=12.4)
    c.text(bx + 16.0, y_hm + 28.0, "Heavy metal (HM)", cls="fm-label-bold", fill="hm_stroke", size=12.4)
    c.text(bx + 16.0, y_hm - 8.0, "HM / FM interface", cls="fm-note", fill="accent_violet", weight=600)

    # Conventional charge current J_c, E = -grad V along +x inside HM
    vector_arrow(c, bx + 44.0, y_hm + 78.0, bx + 206.0, y_hm + 78.0, color="H", width=3.2, size="lg")
    c.math_text(bx + 125.0, y_hm + 64.0, M("\\mathbf{J}_c,\\; \\mathbf{E} = -\\nabla V"), fill="H", size=12.6, bold=True, anchor="middle")
    c.text(bx + 125.0, y_hm + 98.0, "conventional charge current (+x)", cls="fm-note", fill="H", anchor="middle")

    # Spin Hall scattering: spin-up (+y) deflects UP (+z) to interface; spin-down (-y) deflects DOWN (-z)
    # Upward curved deflection trajectory
    curved_arrow(c, bx + 220.0, y_hm + 76.0, bx + 268.0, y_hm + 72.0, bx + 284.0, y_hm + 16.0, color="accent_warm", width=2.0, size="sm")
    # Downward curved deflection trajectory (opposite spin -y)
    curved_arrow(c, bx + 220.0, y_hm + 82.0, bx + 264.0, y_hm + 88.0, bx + 278.0, y_hm + 116.0, color="accent_warm", width=1.6, size="sm", dash="4,3", opacity=0.8)

    # Spin polarization arrows on deflected carriers (+y receding up-right at top, -y down-left at bottom)
    uy_x, uy_y = 22.0, -13.5
    vector_arrow(c, bx + 258.0, y_hm + 50.0, bx + 258.0 + uy_x, y_hm + 50.0 + uy_y, color="accent_violet", width=2.2, size="sm")
    c.math_text(bx + 286.0, y_hm + 36.0, M("+\\hat{y}"), fill="accent_violet", size=11.0, bold=True)

    vector_arrow(c, bx + 262.0, y_hm + 104.0, bx + 262.0 - uy_x, y_hm + 104.0 - uy_y, color="accent_violet", width=1.8, size="sm", opacity=0.85)
    c.math_text(bx + 290.0, y_hm + 112.0, M("-\\hat{y}"), fill="accent_violet", size=10.6)

    # Main transverse spin current Q_s flowing straight UP (+z) across HM/FM interface
    qx = bx + 332.0
    vector_arrow(c, qx, y_hm + 104.0, qx, y_fm + 44.0, color="accent_warm", width=3.4, size="lg")
    c.math_text(qx - 12.0, y_hm + 72.0, M("Q_{za}"), fill="accent_warm", size=13.0, bold=True, anchor="end")
    c.text(qx - 12.0, y_hm + 88.0, "spin flow (+z)", cls="fm-note", fill="accent_warm", anchor="end")

    # Interface normal n_hat (HM -> FM) cleanly raised above the HM/FM seam
    nx = bx + 236.0
    vector_arrow(c, nx, y_hm + 24.0, nx, y_hm - 42.0, color="axis", width=2.0, size="md")
    c.math_text(nx - 10.0, y_hm - 28.0, M("\\hat{n}"), fill="ink", size=12.0, bold=True, anchor="end")
    c.text(nx - 10.0, y_hm - 13.0, "HM → FM", cls="fm-tick", fill="ink_secondary", anchor="end")

    # Interfacial spin accumulation mu_s along the HM/FM seam (dots + +y polarization ticks)
    for k in range(4):
        ax = qx + 28.0 + k * 24.0
        ay = y_hm
        c.circle(ax, ay, 3.8, fill="accent_violet", stroke="surface_ref", stroke_width=0.9)
        c.line(ax, ay, ax + 13.0, ay - 8.0, stroke="accent_violet", stroke_width=1.6, marker_end=c.marker_url("accent_violet", size="sm"))
    c.math_text(qx + 64.0, y_hm + 22.0, M("\\boldsymbol{\\mu}_s\\; (\\hat{\\sigma} = +\\hat{y})"), fill="accent_violet", size=11.4, anchor="middle")

    # Magnetization m in FM + absorbed transverse spin torque curved arrow (zero text/shaft overlap)
    mx1, my1 = qx + 36.0, y_fm + 76.0
    mx2, my2 = qx + 96.0, y_fm + 22.0
    vector_arrow(c, mx1, my1, mx2, my2, color="m", width=3.4, size="lg")
    c.math_text(mx2 + 8.0, my2 + 4.0, M("\\mathbf{m}"), fill="m", size=13.4, bold=True)

    # Torque transfer arc from interface spin flux onto m
    curved_arrow(c, qx + 18.0, y_fm + 56.0, qx + 42.0, y_fm + 22.0, qx + 70.0, y_fm + 34.0, color="accent_warm", width=2.3, size="md")
    c.text(qx + 104.0, y_fm + 72.0, "absorbed ⊥ spin", cls="fm-note", fill="accent_warm", anchor="middle", weight=600)
    c.math_text(qx + 104.0, y_fm + 88.0, M("\\rightarrow\\; \\mathbf{T}_{tr}^G"), fill="accent_warm", size=12.0, bold=True, anchor="middle")

    # -----------------------------------------------------------------------
    # Vertical hairline divider
    # -----------------------------------------------------------------------
    panel_divider(c, 668.0, 24.0, 668.0, 384.0)

    # -----------------------------------------------------------------------
    # Right reference column: Right-handed convention & tensor definition
    # -----------------------------------------------------------------------
    c.text(692.0, 40.0, "Fullmag convention", cls="fm-panel-title", fill="ink", size=12.6)

    # Crisp right-handed 3D coordinate triad matching the isometric bilayer
    ox, oy = 744.0, 140.0
    vector_arrow(c, ox, oy, ox + 78.0, oy, color="H", width=2.2, size="md")
    c.math_text(ox + 86.0, oy + 4.0, M("+\\hat{x}"), fill="H", size=12.0, bold=True)

    vector_arrow(c, ox, oy, ox, oy - 58.0, color="accent_warm", width=2.2, size="md")
    c.math_text(ox, oy - 66.0, M("+\\hat{z}"), fill="accent_warm", size=12.0, bold=True, anchor="middle")

    vector_arrow(c, ox, oy, ox + 52.0, oy - 32.0, color="accent_violet", width=2.2, size="md")
    c.math_text(ox + 58.0, oy - 34.0, M("+\\hat{y}"), fill="accent_violet", size=12.0, bold=True)
    c.circle(ox, oy, 2.8, fill="ink")

    # Compact aligned mapping table (borderless)
    rows = [
        ("Charge current, " + math_span(M("\\mathbf{E}")), M("+\\hat{x}"), "H"),
        ("Normal " + math_span(M("\\hat{n}")) + ", spin flow", M("+\\hat{z}"), "accent_warm"),
        ("Spin polarization " + math_span(M("\\hat{\\sigma}")), M("+\\hat{y}"), "accent_violet"),
    ]
    ry0 = 172.0
    for idx, (lbl, vec_m, col) in enumerate(rows):
        ry = ry0 + idx * 24.0
        c.text(692.0, ry, lbl, cls="fm-sub", fill="ink_secondary", raw_markup="<tspan" in lbl)
        c.math_text(934.0, ry, vec_m, fill=col, size=12.0, bold=True, anchor="end")

    panel_divider(c, 692.0, 240.0, 938.0, 240.0)

    # Spin-current tensor & direct-SHE law
    c.text(692.0, 264.0, "Rank-2 spin-current tensor", cls="fm-label-bold", fill="ink", size=11.4)
    c.math_text(692.0, 286.0, M("Q_{ia}\\; :\\; \\mathrm{first\\; index}\\; i\\; (\\mathrm{flow}),\\; a\\; (\\mathrm{spin})"), fill="ink_secondary", size=11.0)
    c.math_text(692.0, 310.0, M("\\mathcal{J}^s_{ia} = (\\hbar / 2e)\\,Q_{ia}"), fill="ink", size=11.8)
    c.math_text(692.0, 336.0, M("\\mathbf{Q}_n^{SHE} = \\theta_{SH}\\,\\sigma\\,(\\hat{n}\\times\\mathbf{E})"), fill="accent_warm", size=12.0, bold=True)

    c.text(
        692.0,
        366.0,
        math_span(M("e > 0")) + " · conventional " + math_span(M("\\mathbf{J}_c")) + " · right-handed " + math_span(M("(\\hat{x},\\hat{y},\\hat{z})")),
        cls="fm-note",
        fill="ink_muted",
        raw_markup=True,
    )


# ===========================================================================
# 6. drift-diffusion-reactions-and-interface
# ===========================================================================


def _draw_drift_diffusion_reactions_and_interface(c: SvgCanvas, t: Theme) -> None:
    # -----------------------------------------------------------------------
    # Panel a: Spin-channel potential splitting V ± mu_s/2 & FV face flux Q_i
    # -----------------------------------------------------------------------
    panel_label(
        c,
        16,
        22,
        "a",
        "Spin-channel splitting &amp; face flux " + math_span(M("\\mathbf{Q}_i")),
        title_markup=True,
    )

    # Two adjacent FV cells L and R separated by Face f
    y_cell, h_cell = 50.0, 120.0
    layer_slab(c, 26.0, y_cell, 198.0, h_cell, kind="hm", stroke_width=1.1)
    layer_slab(c, 240.0, y_cell, 198.0, h_cell, kind="fm", stroke_width=1.1)

    c.text(36.0, y_cell + 17.0, "Cell L (" + math_span(M("h_L,\\, \\sigma_{s,L}")) + ")", cls="fm-label-bold", fill="hm_stroke", size=10.6, raw_markup=True)
    c.text(252.0, y_cell + 17.0, "Cell R (" + math_span(M("h_R,\\, \\sigma_{s,R}")) + ")", cls="fm-label-bold", fill="fm_stroke", size=10.6, raw_markup=True)

    # Vertical dashed Face f divider
    fx = 232.0
    c.line(fx, y_cell - 3.0, fx, y_cell + h_cell + 3.0, stroke="ink", stroke_width=1.6, dash="4,3")
    c.text(fx, y_cell - 7.0, "Face f", cls="fm-note", fill="ink", anchor="middle", weight=600)

    # Cell L spin channels: V_L midline + V + mu_s/2 (up, H) and V - mu_s/2 (down, m)
    y_vl = y_cell + 69.0
    c.line(40.0, y_vl, 208.0, y_vl, stroke="hairline", stroke_width=1.0, dash="3,2.5")
    c.math_text(40.0, y_vl - 4.0, M("V_L"), fill="ink_muted", size=10.0)
    c.line(66.0, y_vl - 27.0, 196.0, y_vl - 27.0, stroke="H", stroke_width=2.1)
    c.math_text(68.0, y_vl - 36.0, M("V + \\mu_s/2\\; (\\uparrow)"), fill="H", size=10.2)
    c.line(66.0, y_vl + 27.0, 196.0, y_vl + 27.0, stroke="m", stroke_width=2.1)
    c.math_text(68.0, y_vl + 42.0, M("V - \\mu_s/2\\; (\\downarrow)"), fill="m", size=10.2)
    vector_arrow(c, 180.0, y_vl - 23.0, 180.0, y_vl + 23.0, color="accent_violet", width=1.4, size="sm", double=True)
    c.math_text(186.0, y_vl + 4.0, M("\\mu_{s,L}"), fill="accent_violet", size=10.4, bold=True)

    # Cell R spin channels (smaller splitting)
    y_vr = y_cell + 73.0
    c.line(256.0, y_vr, 424.0, y_vr, stroke="hairline", stroke_width=1.0, dash="3,2.5")
    c.math_text(422.0, y_vr - 5.0, M("V_R"), fill="ink_muted", size=10.0, anchor="end")
    c.line(268.0, y_vr - 16.0, 396.0, y_vr - 16.0, stroke="H", stroke_width=2.1)
    c.line(268.0, y_vr + 16.0, 396.0, y_vr + 16.0, stroke="m", stroke_width=2.1)
    vector_arrow(c, 286.0, y_vr - 13.0, 286.0, y_vr + 13.0, color="accent_violet", width=1.4, size="sm", double=True)
    c.math_text(294.0, y_vr + 4.0, M("\\mu_{s,R}"), fill="accent_violet", size=10.4, bold=True)

    # Face flux arrow Q_i crossing Face f (label cleanly offset into open Cell R space)
    vector_arrow(c, 198.0, y_cell + 53.0, 266.0, y_cell + 53.0, color="accent_warm", width=2.8, size="md")
    c.math_text(fx + 18.0, y_cell + 42.0, M("\\mathbf{Q}_i"), fill="accent_warm", size=11.6, bold=True, anchor="start")

    # Exact three-term M1 face-flux law beneath Panel a
    c.math_text(
        24.0,
        192.0,
        M("\\mathbf{Q}_i = P_f\\mathbf{m}_{up}J_{c,i} + \\theta_{SH,f}\\sigma_f(\\mathbf{e}_i\\times\\mathbf{E}_f) - \\Delta\\boldsymbol{\\mu}_s / (R_L + R_R)"),
        fill="ink",
        size=11.1,
    )
    c.text(
        24.0,
        210.0,
        "Additive drift + direct SHE + harmonic diffusion ("
        + math_span(M("R_L = h_L/(2\\sigma_{s,L})"))
        + "); "
        + math_span(M("\\mathcal{J}^s_{ia} = (\\hbar/2e)Q_{ia}")),
        cls="fm-note",
        fill="ink_muted",
        raw_markup=True,
    )

    # -----------------------------------------------------------------------
    # Vertical hairline divider (top row)
    # -----------------------------------------------------------------------
    panel_divider(c, 476.0, 18.0, 476.0, 222.0)

    # -----------------------------------------------------------------------
    # Panel b: MixingConductanceSpinInterface (longitudinal vs transverse)
    # -----------------------------------------------------------------------
    panel_label(c, 494, 22, "b", "Mixing-conductance HM | FM interface")

    # HM (left) and FM cell K (right) separated by sharp violet mixing interface
    ix = 684.0
    layer_slab(c, 504.0, y_cell, 174.0, h_cell, kind="hm", stroke_width=1.1)
    layer_slab(c, 690.0, y_cell, 250.0, h_cell, kind="fm", stroke_width=1.1)
    c.line(ix, y_cell - 2.0, ix, y_cell + h_cell + 3.0, stroke="accent_violet", stroke_width=2.6)

    c.text(514.0, y_cell + 17.0, "HM (" + math_span(M("V_N,\\, \\boldsymbol{\\mu}_{s,N}")) + ")", cls="fm-label-bold", fill="hm_stroke", size=10.6, raw_markup=True)
    c.text(702.0, y_cell + 17.0, "FM cell K (" + math_span(M("V_F,\\, \\boldsymbol{\\mu}_{s,F},\\, \\mathbf{m}")) + ")", cls="fm-label-bold", fill="fm_stroke", size=10.6, raw_markup=True)
    c.math_text(ix, y_cell - 11.0, M("\\Delta\\boldsymbol{\\mu}_s = \\boldsymbol{\\mu}_{s,N} - \\boldsymbol{\\mu}_{s,F}"), fill="accent_violet", size=10.4, anchor="middle")

    # Longitudinal spin (|| m): transmitted into FM + backflow into HM
    y_lon = y_cell + 51.0
    vector_arrow(c, 586.0, y_lon, 766.0, y_lon, color="H", width=2.4, size="md")
    c.text(584.0, y_lon - 8.0, "Longitudinal (" + math_span(M("\\parallel\\mathbf{m}")) + ")", cls="fm-note", fill="H", weight=600, raw_markup=True)
    c.text(772.0, y_lon + 4.0, "Transmitted (" + math_span(M("G_{\\uparrow},\\, G_{\\downarrow}")) + ")", cls="fm-note", fill="H", raw_markup=True)

    # Backflow U-turn loop on HM side
    c.path(
        f"M {ix - 10.0:.1f} {y_lon + 8.0:.1f} C {ix - 48.0:.1f} {y_lon + 8.0:.1f}, "
        f"{ix - 48.0:.1f} {y_lon + 25.0:.1f}, {ix - 12.0:.1f} {y_lon + 25.0:.1f}",
        stroke="H",
        stroke_width=1.4,
        dash="3.5,2.5",
        marker_end=c.marker_url("H", size="sm"),
    )
    c.text(514.0, y_lon + 23.0, "Backflow", cls="fm-tick", fill="H")

    # Transverse spin (perp m): fully absorbed at interface -> torque T_f,K
    y_trn = y_cell + 96.0
    vector_arrow(c, 586.0, y_trn, ix - 7.0, y_trn, color="accent_warm", width=2.6, size="md")
    c.text(584.0, y_trn - 9.0, "Transverse (" + math_span(M("\\perp\\mathbf{m}")) + ")", cls="fm-note", fill="accent_warm", weight=600, raw_markup=True)
    c.circle(ix, y_trn, 5.5, fill="accent_warm", stroke="surface_ref", stroke_width=1.3)
    curved_arrow(c, ix + 6.0, y_trn, ix + 44.0, y_trn - 15.0, ix + 74.0, y_trn - 3.0, color="accent_warm", width=2.1, size="sm")
    c.text(
        ix + 82.0,
        y_trn - 4.0,
        "Full absorption (" + math_span(M("G_r,\\, G_i")) + ") → " + math_span(M("\\mathbf{T}_{f,K}")),
        cls="fm-note",
        fill="accent_warm",
        weight=600,
        raw_markup=True,
    )
    c.text(ix + 82.0, y_trn + 11.0, "Zero transverse flux transmitted", cls="fm-tick", fill="ink_muted")

    # Compact mixing-conductance laws beneath Panel b
    c.math_text(
        504.0,
        191.0,
        M("\\mathbf{q}_{abs,\\perp} = G_r\\,\\mathbf{m}\\times(\\Delta\\boldsymbol{\\mu}_s\\times\\mathbf{m}) + G_i\\,(\\Delta\\boldsymbol{\\mu}_s\\times\\mathbf{m})"),
        fill="ink",
        size=11.0,
    )
    c.math_text(
        504.0,
        211.0,
        M("\\mathbf{T}_{f,K} = -(\\gamma_e/M_s)(\\hbar/2e)(A_f/V_K)\\,\\mathbf{q}_{abs,\\perp}"),
        fill="m",
        size=10.9,
    )

    # -----------------------------------------------------------------------
    # Horizontal hairline divider between top row and Panel c
    # -----------------------------------------------------------------------
    panel_divider(c, 16.0, 232.0, 944.0, 232.0)

    # -----------------------------------------------------------------------
    # Panel c: Volumetric FM reaction triad + exact HM | FM spatial z-profile
    # -----------------------------------------------------------------------
    panel_label(
        c,
        16,
        254,
        "c",
        "HM | FM spatial spin-accumulation profile & FM reaction triad",
    )

    # --- Left side of Panel c: Vector decomposition around m + reaction formulas ---
    vx, vy = 66.0, 396.0
    vector_arrow(c, vx, vy, vx, vy - 94.0, color="m", width=2.8, size="md")
    c.math_text(vx - 19.0, vy - 84.0, M("\\mathbf{m}"), fill="m", size=12.4, bold=True)

    mx_end, my_end = vx + 72.0, vy - 58.0
    vector_arrow(c, vx, vy, mx_end, my_end, color="accent_violet", width=2.5, size="md")
    c.math_text(mx_end + 6.0, my_end - 2.0, M("\\boldsymbol{\\mu}_s"), fill="accent_violet", size=11.8, bold=True)

    c.line(vx, my_end, mx_end, my_end, stroke="hairline", stroke_width=0.9, dash="3,2.5")
    c.line(mx_end, vy, mx_end, my_end, stroke="hairline", stroke_width=0.9, dash="3,2.5")

    vector_arrow(c, vx, vy, mx_end, vy, color="accent_warm", width=1.9, size="sm", dash="4,2.5")
    c.math_text(vx + 38.0, vy - 12.0, M("\\boldsymbol{\\mu}_{s,\\perp}"), fill="accent_warm", size=10.5, anchor="middle", halo=True)

    vector_arrow(c, mx_end, vy, mx_end + 30.0, vy + 24.0, color="flux", width=2.1, size="sm")
    c.math_text(mx_end + 34.0, vy + 31.0, M("\\mathbf{R}_J"), fill="flux", size=10.8, bold=True)

    vector_arrow(c, mx_end, vy, mx_end - 34.0, vy + 26.0, color="accent_warm", width=2.1, size="sm")
    c.math_text(mx_end - 39.0, vy + 33.0, M("\\mathbf{R}_{\\phi}"), fill="accent_warm", size=10.8, bold=True, anchor="end")

    vector_arrow(c, vx + 30.0, vy - 24.0, vx + 58.0, vy - 46.5, color="ink_muted", width=1.5, size="sm", dash="3,2.5")
    c.math_text(vx + 28.0, vy - 44.0, M("\\mathbf{R}_{sf}"), fill="ink_muted", size=10.2)

    # Compact borderless reaction equations beside vector triad (well separated from plot y-axis)
    rx0 = 204.0
    c.text(rx0, 290.0, "1. Spin-flip (zero torque)", cls="fm-label-bold", fill="ink_secondary", size=10.6)
    c.math_text(rx0, 308.0, M("\\mathbf{R}_{sf} = [\\sigma_s/(2\\lambda_{sf}^2)]\\,\\boldsymbol{\\mu}_s"), fill="ink_secondary", size=10.6)

    c.text(rx0, 336.0, "2. Exchange precession", cls="fm-label-bold", fill="flux", size=10.6)
    c.math_text(rx0, 354.0, M("\\mathbf{R}_J = [\\sigma_s/(2\\lambda_J^2)]\\,(\\boldsymbol{\\mu}_s\\times\\mathbf{m})"), fill="ink", size=10.6)

    c.text(rx0, 382.0, "3. Transverse dephasing", cls="fm-label-bold", fill="accent_warm", size=10.6)
    c.math_text(rx0, 400.0, M("\\mathbf{R}_{\\phi} = [\\sigma_s/(2\\lambda_{\\phi}^2)]\\,\\mathbf{m}\\times(\\boldsymbol{\\mu}_s\\times\\mathbf{m})"), fill="ink", size=10.6)

    panel_divider(c, rx0, 416.0, 424.0, 416.0, dashed=True)
    c.math_text(rx0, 437.0, M("\\mathbf{T}_{tr,G} = -(\\gamma_e/M_s)(\\hbar/2e)(\\mathbf{R}_J + \\mathbf{R}_{\\phi})"), fill="m", size=10.8, bold=True)
    c.text(
        rx0,
        456.0,
        "Only " + math_span(M("\\mathbf{R}_J + \\mathbf{R}_{\\phi}")) + " transfer torque to " + math_span(M("\\mathbf{m}")) + ".",
        cls="fm-note",
        fill="ink_muted",
        raw_markup=True,
    )

    # --- Right side of Panel c: Exact analytical 1D z-profile across HM | FM interface ---
    pf = axes_2d(
        c,
        494.0,
        278.0,
        440.0,
        168.0,
        xlim=(-4.0, 10.0),
        ylim=(-0.22, 1.14),
        xlabel=M("z\\; \\mathrm{(nm)}\\; [\\mathrm{HM}\\; (z < 0)\\; |\\; \\mathrm{FM}\\; (z > 0)]"),
        ylabel=M("\\mu_s(z) / \\mu_s(0^-)"),
        xticks=(-4.0, -2.0, 0.0, 2.0, 4.0, 6.0, 8.0, 10.0),
        yticks=(0.0, 0.5, 1.0),
        ytick_labels=("0.0", "0.5", "1.0"),
        grid=True,
        zero_lines=True,
        xlabel_offset=29.0,
        ylabel_offset=36.0,
    )

    # Subtle background domain shading: HM (z < 0), FM absorption zone (0 < z < 2.6 nm)
    x_hm0, x_int = pf.px(-4.0), pf.px(0.0)
    x_abs = pf.px(2.6)
    c.rect(x_hm0, pf.y0, x_int - x_hm0, pf.height, fill="hm_fill", fill_opacity=0.45)
    c.rect(x_int, pf.y0, x_abs - x_int, pf.height, fill="accent_warm_soft", fill_opacity=0.42)

    # Interface line z = 0 in violet
    c.line(x_int, pf.y0, x_int, pf.y0 + pf.height, stroke="accent_violet", stroke_width=1.8)

    # Domain labels at top of plot
    c.text(0.5 * (x_hm0 + x_int), pf.y0 + 13.0, "HM", cls="fm-label-bold", fill="hm_stroke", anchor="middle", size=10.6)
    c.text(0.5 * (x_int + x_abs), pf.y0 + 13.0, "Torque zone", cls="fm-note", fill="accent_warm", anchor="middle", weight=600)
    c.text(pf.px(6.4), pf.y0 + 13.0, "FM bulk", cls="fm-label-bold", fill="fm_stroke", anchor="middle", size=10.6)

    # Exact 1D HM spin-diffusion profile on z in [-4, 0] nm with lambda_sf^HM = 1.5 nm:
    # normalized to mu_s(0^-) = 1.0 with sinh((z + t_HM)/lam) / sinh(t_HM/lam)
    lam_hm = 1.5
    t_hm = 4.0
    z_hm = [-t_hm + t_hm * k / 60.0 for k in range(61)]
    mu_hm = [math.sinh((z + t_hm) / lam_hm) / math.sinh(t_hm / lam_hm) for z in z_hm]
    pf.plot_curve(z_hm, mu_hm, color="accent_violet", width=2.3)

    # Exact 1D FM steady reaction-diffusion profiles on z in [0, 10] nm:
    #   lambda_sf = 5.0 nm, lambda_J = 1.0 nm, lambda_phi = 1.4 nm
    #   With finite interface boundary jump Delta mu_s at z = 0:
    #     mu_||(0^+) = 0.80, mu_perp(0^+) = 0.72
    lam_sf_fm, lam_j, lam_phi = 5.0, 1.0, 1.4
    kappa = cmath.sqrt((1.0 / (lam_sf_fm ** 2) + 1.0 / (lam_phi ** 2)) - 1j / (lam_j ** 2))
    kr, ki = kappa.real, -kappa.imag  # kr > 0, ki > 0 so exp(-kappa z) = exp(-kr z)*(cos(ki z) + i sin(ki z))

    mu_par_0 = 0.80
    mu_perp_0 = 0.72
    z_fm = [10.0 * k / 160.0 for k in range(161)]
    mu_par = [mu_par_0 * math.exp(-z / lam_sf_fm) for z in z_fm]
    mu_px = [mu_perp_0 * math.exp(-kr * z) * math.cos(ki * z) for z in z_fm]
    mu_py = [mu_perp_0 * math.exp(-kr * z) * math.sin(ki * z) for z in z_fm]

    pf.plot_curve(z_fm, mu_par, color="H", width=2.3)
    pf.plot_curve(z_fm, mu_px, color="accent_warm", width=2.2)
    pf.plot_curve(z_fm, mu_py, color="flux", width=1.9, dash="4.5,3")

    # Interface boundary jump markers at z = 0^- and z = 0^+
    pf.scatter([0.0], [1.0], r=3.3, fill="accent_violet", stroke="surface_ref", stroke_width=1.0)
    pf.scatter([0.0], [mu_par_0], r=3.0, fill="H", stroke="surface_ref", stroke_width=1.0)
    pf.scatter([0.0], [mu_perp_0], r=3.0, fill="accent_warm", stroke="surface_ref", stroke_width=1.0)
    # Clean jump bracket right of z = 0? No, cleanly above-left of jump in open HM area
    c.line(x_int - 7.0, pf.py(1.0), x_int - 7.0, pf.py(mu_perp_0), stroke="accent_violet", stroke_width=1.1)
    c.line(x_int - 10.0, pf.py(1.0), x_int - 4.0, pf.py(1.0), stroke="accent_violet", stroke_width=1.0)
    c.line(x_int - 10.0, pf.py(mu_perp_0), x_int - 4.0, pf.py(mu_perp_0), stroke="accent_violet", stroke_width=1.0)
    c.math_text(x_int - 15.0, pf.py(0.92), M("\\Delta\\mu_s"), fill="accent_violet", size=10.2, anchor="end", halo=True)
    c.math_text(pf.px(-2.2), pf.py(0.60), M("\\lambda_{sf}^{HM} = 1.5\\,\\mathrm{nm}"), fill="accent_violet", size=9.8, anchor="middle", halo=True)

    # Borderless legend neatly positioned in open upper-right area of FM plot
    legend_strip(
        c,
        pf.px(4.3),
        pf.py(0.88),
        [
            (math_span(M("\\mu_{\\parallel}\\; (\\lambda_{sf} = 5.0\\,\\mathrm{nm})")), "H", "solid"),
            (math_span(M("\\mu_{\\perp,x}\\; (\\lambda_J = 1.0,\\, \\lambda_{\\phi} = 1.4\\,\\mathrm{nm})")), "accent_warm", "solid"),
            (math_span(M("\\mu_{\\perp,y}\\; (\\mathrm{precessing})")), "flux", "dashed"),
        ],
        horizontal=False,
        row_gap=16.5,
        line_len=16.0,
    )


# ===========================================================================
# Public entry point called by scripts/generate_physics_diagrams.py
# ===========================================================================


def generate_all(out_dir: Path | str = DEFAULT_DIAGRAMS_DIR) -> list[tuple[Path, Path]]:
    """Generate all 6 spintronics & spin-transport diagram pairs (12 SVGs)."""
    out_path = Path(out_dir)
    specs = (
        (
            "stt-slonczewski-vs-zhang-li",
            _draw_stt_slonczewski_vs_zhang_li,
            960.0,
            452.0,
            "Slonczewski CPP/MTJ torque versus Zhang-Li CIP domain-wall torque in Fullmag",
            "Two-panel publication diagram comparing (a) Slonczewski CPP/MTJ trilayer geometry and computed angular asymmetry epsilon_DL(theta) at P=0.40 for Lambda in {1.0, 1.5, 2.0}, and (b) Zhang-Li CIP domain-wall spin profile m(x) with conventional current J_c, electron drift, adiabatic drag, and non-adiabatic canting, plus the single Gilbert-to-explicit conversion invariant.",
        ),
        (
            "sot-models-comparison-local-m1-m2",
            _draw_sot_models_comparison_clean,
            960.0,
            454.0,
            "Architecture comparison of Prescribed Local SOT, M1 one-way drift-diffusion, and M2 reciprocal Onsager transport",
            "Three-column scientific architecture comparing (a) local algebraic PrescribedSpinOrbitTorque without transport PDEs, (b) one-way CurrentTransport to SpinDriftDiffusion to DriftDiffusionSpinTorque (M1), and (c) bidirectional coupled charge-spin Onsager block (M2), with an additive RHS guard.",
        ),
        (
            "sot-unit-sphere-torques-and-drives",
            _draw_sot_unit_sphere_and_drives,
            960.0,
            474.0,
            "Unit-sphere spin-orbit torque geometry, Gilbert-to-explicit mixing, and HM/FM drive conventions",
            "Two-panel diagram showing (a) exact 3D orthographic unit sphere S^2 with magnetization m, effective field H_eff, polarization sigma_hat, tangent plane T_m S^2, orthogonal damping-like and field-like Gilbert torques, and single Gilbert-to-explicit RHS mixing, and (b) right-handed HM/FM bilayer geometry comparing SignedScalarDrive and VectorCurrentDrive current-reversal invariance.",
        ),
        (
            "sot-switching-and-calibration-regimes",
            _draw_sot_switching_and_calibration,
            960.0,
            446.0,
            "SOT switching regimes (Type-z PMA vs Type-y in-plane) and spin-diffusion efficiency scaling",
            "Two-panel figure comparing (a) Type-z perpendicular switching with symmetry-breaking assist field B_x and computed macrospin LLG+SOT hysteresis loops versus field-free Type-y in-plane collinear anti-damping switching, and (b) analytical spin-diffusion thickness scaling xi_DL(t_HM) = T_int theta_SH [1 - sech(t_HM / lambda_sf)] relative to bulk theta_SH.",
        ),
        (
            "spin-hall-hm-fm",
            _draw_spin_hall_hm_fm,
            960.0,
            406.0,
            "Right-handed spin Hall transport geometry across a heavy-metal/ferromagnet bilayer",
            "Isometric 3D heavy-metal/ferromagnet bilayer illustrating Fullmag's right-handed spin Hall convention: conventional charge current J_c and E along +x, transverse spin current Q_za along +z across interface normal n_hat with spin polarization +y, opposite-spin deflection -y downward, interfacial spin accumulation mu_s, and absorbed transverse torque T_tr^G on magnetization m.",
        ),
        (
            "drift-diffusion-reactions-and-interface",
            _draw_drift_diffusion_reactions_and_interface,
            960.0,
            492.0,
            "Finite-volume spin-channel splitting, mixing-conductance interface, and HM/FM spin-accumulation profile",
            "Three-panel transport diagram showing (a) spin-channel voltage splitting V +/- mu_s/2 and additive face flux Q_i, (b) MixingConductanceSpinInterface separating longitudinal transmission and backflow (G_up, G_down) from full transverse absorption (G_r, G_i), and (c) FM spin-reaction vector triad (R_sf, R_J, R_phi) alongside the analytical 1D spatial spin-accumulation profile across the HM/FM interface.",
        ),
    )

    generated: list[tuple[Path, Path]] = []
    for slug, draw_fn, w, h, title, desc in specs:
        generated.append(
            write_themed_svg(
                slug,
                draw_fn,
                width=w,
                height=h,
                title=title,
                desc=desc,
                out_dir=out_path,
            )
        )
    return generated


if __name__ == "__main__":
    pairs = generate_all()
    print(f"Generated {len(pairs)} spintronics diagram pairs ({len(pairs) * 2} SVGs).")
