"""Six publication-grade dual-theme (Light + Dark) SVGs for exchange, coupling, and demagnetization.

Generates 12 self-contained transparent-canvas SVGs (6 light + 6 dark):
1. ``exchange-fdm-stencil-vs-fem-weak``
2. ``inter-region-couplings-exchange-rkky``
3. ``demag-solver-families-comparison``
4. ``demag-fdm-newell-and-multilayer``
5. ``demag-fem-poisson-airbox-closures``
6. ``demag-fem-bem-fredkin-koehler-pipeline``
"""

from __future__ import annotations

import math
from pathlib import Path

from .primitives import (
    DEFAULT_DIAGRAMS_DIR,
    SvgCanvas,
    arc_arrow,
    axes_2d,
    bracket_dim,
    curve_path,
    dashed_region,
    esc,
    hat,
    iso_slab,
    layer_slab,
    legend_strip,
    math_span,
    panel_divider,
    panel_label,
    roman,
    spin_arrow,
    sub,
    sup,
    vec,
    vector_arrow,
    write_themed_svg,
)
from .theme import FONT_MONO, Theme


# ---------------------------------------------------------------------------
# Exact analytical physics helpers
# ---------------------------------------------------------------------------


def _newell_f(x: float, y: float, z: float) -> float:
    """Newell et al. (1993) diagonal demagnetization primitive f(x, y, z)."""
    ax, ay, az = abs(x), abs(y), abs(z)
    x2, y2, z2 = ax * ax, ay * ay, az * az
    r2 = x2 + y2 + z2
    r = math.sqrt(r2)
    if r == 0.0:
        return 0.0

    val = (2.0 * x2 - y2 - z2) * r / 6.0
    if ay > 0.0 and (x2 + z2) > 0.0:
        val += 0.5 * ay * (z2 - x2) * math.asinh(ay / math.sqrt(x2 + z2))
    if az > 0.0 and (x2 + y2) > 0.0:
        val += 0.5 * az * (y2 - x2) * math.asinh(az / math.sqrt(x2 + y2))
    if ax > 0.0 and ay > 0.0 and az > 0.0:
        val -= ax * ay * az * math.atan((ay * az) / (ax * r))
    return val


def _newell_diag_tensor(
    dx: float,
    dy: float,
    dz: float,
    hx: float,
    hy: float,
    hz: float,
) -> float:
    """Exact 27-point cell-averaged Newell diagonal component N_xx(dx, dy, dz)."""
    acc = 0.0
    for ix in (-1, 0, 1):
        wx = 2.0 if ix == 0 else -1.0
        for iy in (-1, 0, 1):
            wy = 2.0 if iy == 0 else -1.0
            for iz in (-1, 0, 1):
                wz = 2.0 if iz == 0 else -1.0
                acc += (wx * wy * wz) * _newell_f(dx + ix * hx, dy + iy * hy, dz + iz * hz)
    return acc / (4.0 * math.pi * hx * hy * hz)


def _periodic_film_demag_factors(
    lx: float,
    ly: float,
    lz: float,
    image_counts: tuple[int, ...],
) -> tuple[list[float], list[float]]:
    """Exact uniform-mode N_xx(I) and N_zz(I) for a 2D periodic rectangular film."""
    nxx_vals: list[float] = []
    nzz_vals: list[float] = []
    nxx_self = _newell_diag_tensor(0.0, 0.0, 0.0, lx, ly, lz)
    nzz_self = _newell_diag_tensor(0.0, 0.0, 0.0, lz, lx, ly)
    max_i = max(image_counts)
    ring_xx = [0.0] * (max_i + 1)
    ring_zz = [0.0] * (max_i + 1)
    ring_xx[0] = nxx_self
    ring_zz[0] = nzz_self
    v_cell = lx * ly * lz
    cutoff2 = (40.0 * max(lx, ly, lz)) ** 2

    for nx in range(-max_i, max_i + 1):
        for ny in range(-max_i, max_i + 1):
            shell = max(abs(nx), abs(ny))
            if shell == 0:
                continue
            rx = nx * lx
            ry = ny * ly
            r2 = rx * rx + ry * ry
            if r2 >= cutoff2:
                r = math.sqrt(r2)
                r3 = r2 * r
                ring_xx[shell] += (v_cell / (4.0 * math.pi * r3)) * (1.0 - 3.0 * rx * rx / r2)
                ring_zz[shell] += v_cell / (4.0 * math.pi * r3)
            else:
                ring_xx[shell] += _newell_diag_tensor(rx, ry, 0.0, lx, ly, lz)
                ring_zz[shell] += _newell_diag_tensor(0.0, rx, ry, lz, lx, ly)

    cum_xx = 0.0
    cum_zz = 0.0
    by_shell_xx: dict[int, float] = {}
    by_shell_zz: dict[int, float] = {}
    for s in range(max_i + 1):
        cum_xx += ring_xx[s]
        cum_zz += ring_zz[s]
        by_shell_xx[s] = cum_xx
        by_shell_zz[s] = cum_zz

    for count in image_counts:
        nxx_vals.append(by_shell_xx[count])
        nzz_vals.append(by_shell_zz[count])
    return nxx_vals, nzz_vals


def _sphere_potential(r_over_a: float, r_box_over_a: float, robin_c: float | None) -> float:
    """Analytical scalar potential u(r)/(M_s a) along magnetization axis for a uniform sphere."""
    if robin_c is None:
        coeff = 0.0
    elif math.isinf(robin_c):
        coeff = -1.0
    else:
        coeff = (2.0 - robin_c) / (1.0 + robin_c)
    inv_r3 = 1.0 / (r_box_over_a ** 3)
    if r_over_a <= 1.0:
        return (1.0 / 3.0) * (1.0 + coeff * inv_r3) * r_over_a
    return (1.0 / 3.0) * (1.0 / (r_over_a * r_over_a) + coeff * inv_r3 * r_over_a)


def _code_span(text: str) -> str:
    return f'<tspan font-family="{esc(FONT_MONO)}" font-size="9.8">{esc(text)}</tspan>'


# ---------------------------------------------------------------------------
# 1. exchange-fdm-stencil-vs-fem-weak
# ---------------------------------------------------------------------------


def _draw_exchange_fdm_vs_fem(c: SvgCanvas, t: Theme) -> None:
    panel_divider(c, 322, 16, 322, 378)
    panel_divider(c, 656, 16, 656, 378)

    # ---- Panel a: Continuum variational model ----
    panel_label(
        c,
        16,
        24,
        "a",
        "Continuum model",
        subtitle="Bulk stiffness & free-surface Neumann BC",
    )

    dom_x, dom_y, dom_w, dom_h = 26.0, 68.0, 232.0, 140.0
    c.rect(dom_x, dom_y, dom_w, dom_h, fill="fm_fill", stroke="fm_stroke", stroke_width=1.4, rx=3)
    c.line(dom_x + dom_w, dom_y, dom_x + dom_w, dom_y + dom_h, stroke="ink", stroke_width=2.1)

    c.math_text(dom_x + 10, dom_y + 18, "Ω" + sub("m"), fill="fm_stroke", size=12.0, italic=False)
    c.math_text(
        dom_x + dom_w - 8,
        dom_y + 18,
        "∂Ω" + sub("m"),
        fill="ink",
        size=11.8,
        italic=False,
        anchor="end",
    )

    # Smooth 2-row spin texture whose normal derivative vanishes at right boundary ∂Ω_m
    for row_y in (122.0, 174.0):
        for k in range(7):
            s = k / 6.0
            sx = dom_x + 22.0 + s * (dom_w - 44.0)
            angle = 152.0 - 134.0 * (2.0 * s - s * s)
            spin_arrow(c, sx, row_y, angle, length=21.0, color="m", width=1.8, size="sm", center_dot=True)

    vector_arrow(
        c,
        dom_x + dom_w,
        dom_y + 0.5 * dom_h,
        dom_x + dom_w + 38.0,
        dom_y + 0.5 * dom_h,
        color="H",
        width=2.0,
        size="md",
        label=vec("n"),
        label_pos=(dom_x + dom_w + 22.0, dom_y + 0.5 * dom_h - 10.0),
    )

    c.math_text(
        dom_x + 0.5 * dom_w,
        dom_y + dom_h + 21.0,
        "A ∂" + sub("n", upright=False) + vec("m") + " = " + vec("0") + "  " + roman("on ∂Ω") + sub("m"),
        fill="H",
        size=12.0,
        anchor="middle",
    )

    c.math_text(
        26,
        266,
        "E" + sub("ex") + "[" + vec("m") + "] = ∫" + sub("Ωm") + " A(" + vec("x") + ") ∇" + vec("m") + " : ∇" + vec("m") + " " + roman("d") + "V",
        fill="ink",
        size=12.0,
    )
    c.math_text(
        26,
        298,
        vec("H", sub_text="ex") + " = (2 / μ" + sub("0") + "M" + sub("s") + ") ∇·(A ∇" + vec("m") + ")",
        fill="H",
        size=12.0,
    )
    c.math_text(
        26,
        330,
        "δE" + sub("ex") + "[" + vec("m") + "; " + vec("η") + "] = 2 ∫" + sub("Ωm") + " A ∇" + vec("m") + " : ∇" + vec("η") + " " + roman("d") + "V",
        fill="flux",
        size=11.6,
    )
    c.text(
        26,
        362,
        "Conforming bulk domains only; RKKY & pinned BCs separate.",
        cls="fm-note",
    )

    # ---- Panel b: FDM 6-neighbor stencil ----
    panel_label(
        c,
        338,
        24,
        "b",
        "FDM 6-neighbor stencil",
        subtitle="Zero-flux void clamping & FP64 T0/T1 sub-cell",
    )

    cx, cy = 486.0, 152.0
    cw, ch = 46.0, 38.0

    vector_arrow(c, cx - 25, cy, cx - 59, cy, color="H", width=1.6, size="sm", double=True)
    vector_arrow(c, cx + 25, cy, cx + 59, cy, color="H", width=1.6, size="sm", double=True)
    vector_arrow(c, cx, cy + 21, cx, cy + 45, color="H", width=1.6, size="sm", double=True)
    c.line(cx, cy - 21, cx, cy - 46, stroke="air_stroke", stroke_width=1.4, dash="3,3")
    vector_arrow(c, cx + 21, cy - 16, cx + 64, cy - 42, color="H", width=1.4, size="sm")
    vector_arrow(c, cx - 21, cy + 16, cx - 64, cy + 42, color="H", width=1.4, size="sm")

    c.math_text(cx - 42, cy - 7, "Δx", fill="ink_muted", size=10.5, anchor="middle")
    c.math_text(cx + 15, cy + 36, "Δy", fill="ink_muted", size=10.5, anchor="start")

    def _fdm_cell(x_c: float, y_c: float, label_markup: str, angle: float, *, bold_border: bool = False) -> None:
        c.rect(
            x_c - cw * 0.5,
            y_c - ch * 0.5,
            cw,
            ch,
            fill="fm_fill",
            stroke="fm_stroke",
            stroke_width=1.8 if bold_border else 1.2,
            rx=3,
        )
        c.math_text(x_c, y_c - 5.5, label_markup, fill="ink", size=10.6, anchor="middle")
        spin_arrow(c, x_c, y_c + 8.5, angle, length=15.0, color="m", width=1.6, size="sm")

    _fdm_cell(cx, cy, "i", 68.0, bold_border=True)
    _fdm_cell(cx - 84, cy, "i − " + hat("x"), 82.0)
    _fdm_cell(cx + 84, cy, "i + " + hat("x"), 54.0)
    _fdm_cell(cx, cy + 66, "i − " + hat("y"), 72.0)

    for zx, zy, zlbl in ((cx + 84, cy - 52, "i + " + hat("z")), (cx - 84, cy + 54, "i − " + hat("z"))):
        c.rect(zx - 22, zy - 13, 44, 26, fill="fm_fill", stroke="fm_stroke", stroke_width=1.1, rx=3)
        c.math_text(zx, zy + 4, zlbl, fill="ink", size=10.5, anchor="middle")

    vx, vy = cx, cy - 66
    vw, vh = 62.0, 40.0
    c.rect(vx - vw * 0.5, vy - vh * 0.5, vw, vh, fill="air_fill", stroke="air_stroke", stroke_width=1.2, rx=3, dash="4,3")
    c.text(vx, vy - 4.0, "void", cls="fm-note", fill="air_stroke", anchor="middle")
    c.math_text(vx, vy + 11.5, vec("m", sub_text="j") + " → " + vec("m", sub_text="i"), fill="air_stroke", size=9.8, anchor="middle")

    c.text(vx - vw * 0.5 - 7, vy - 3, "Open / inactive:", cls="fm-note", anchor="end")
    c.math_text(
        vx - vw * 0.5 - 7,
        vy + 11,
        vec("m", sub_text="j") + " − " + vec("m", sub_text="i") + " = " + vec("0"),
        fill="H",
        size=10.4,
        anchor="end",
    )

    c.math_text(
        340,
        266,
        "H" + sub("ex,i") + sup("q") + " = (2 / μ" + sub("0") + "M" + sub("s") + ") "
        "Σ" + sub("j∈N6(i)") + " A" + sub("rᵢrⱼ") + " (m" + sub("j") + sup("q") + " − m" + sub("i") + sup("q") + ") / Δ" + sub("ij") + sup("2"),
        fill="ink",
        size=11.4,
    )
    c.math_text(
        340,
        298,
        roman("T0: ") + vec("H", sub_text="i", sup_text="T0") + " = "
        "(2 / μ" + sub("0") + "M" + sub("s") + "φ" + sub("eff") + ") Σ" + sub("j") + " A" + sub("ij") + " f" + sub("i→j") + " "
        "(" + vec("m", sub_text="j") + " − " + vec("m", sub_text="i") + ") / Δ" + sub("ij") + sup("2"),
        fill="accent_warm",
        size=11.0,
    )
    c.math_text(
        340,
        330,
        roman("T1: ") + vec("H", sub_text="i←j", sup_text="T1") + " = "
        "4 A" + sub("ij") + "(" + vec("m", sub_text="j") + " − " + vec("m", sub_text="i") + ") / "
        "[μ" + sub("0") + "M" + sub("s") + "φ" + sub("eff") + " Δd (Δd + δ" + sub("eff") + ")]",
        fill="accent_warm",
        size=10.8,
    )
    c.text(
        340,
        362,
        "Standard: CPU SoA & CUDA FP64/32 · T0/T1: FP64 open BC.",
        cls="fm-note",
        size=10.0,
    )

    # ---- Panel c: FEM H^1(Omega_m) weak form ----
    fem_title = "FEM " + math_span("H" + sup("1") + "(Ω" + sub("m") + ")", italic=False) + " weak form"
    panel_label(
        c,
        672,
        24,
        "c",
        fem_title,
        subtitle="Conforming P1 stiffness & mass projections",
        title_markup=True,
    )

    cols_x = [682.0, 744.0, 806.0, 868.0, 915.0, 962.0]
    rows_y = [76.0, 118.0, 162.0, 206.0]
    pts: list[list[tuple[float, float]]] = []
    offsets = {
        (1, 1): (-4.0, 4.0),
        (1, 2): (5.0, -5.0),
        (2, 1): (4.0, 5.0),
        (2, 2): (-5.0, 3.0),
        (1, 4): (3.0, 4.0),
        (2, 4): (-3.0, -4.0),
    }
    for r_idx, ry in enumerate(rows_y):
        row_pts: list[tuple[float, float]] = []
        for c_idx, rx in enumerate(cols_x):
            dx, dy = offsets.get((r_idx, c_idx), (0.0, 0.0))
            row_pts.append((rx + dx, ry + dy))
        pts.append(row_pts)

    node_i = (1, 1)
    for r in range(len(rows_y) - 1):
        for col in range(len(cols_x) - 1):
            p00 = pts[r][col]
            p10 = pts[r][col + 1]
            p01 = pts[r + 1][col]
            p11 = pts[r + 1][col + 1]
            is_air = col >= 3
            tris = [
                ((r, col), (r, col + 1), (r + 1, col + 1), [p00, p10, p11]),
                ((r, col), (r + 1, col + 1), (r + 1, col), [p00, p11, p01]),
            ]
            for v1, v2, v3, poly in tris:
                in_patch = (not is_air) and (node_i in (v1, v2, v3))
                if is_air:
                    c.polygon(poly, fill="air_fill", stroke="air_stroke", stroke_width=0.9, dash="3,2.5")
                elif in_patch:
                    c.polygon(poly, fill="flux_soft", stroke="flux", stroke_width=1.45)
                else:
                    c.polygon(poly, fill="fm_fill", stroke="fm_stroke", stroke_width=0.95)

    c.line(868.0, 76.0, 868.0, 206.0, stroke="ink", stroke_width=2.1)
    c.math_text(868.0, 68.0, "∂Ω" + sub("m"), fill="ink", size=11.4, italic=False, anchor="middle")

    nix, niy = pts[node_i[0]][node_i[1]]
    c.circle(nix, niy, 4.8, fill="flux", stroke="surface_ref", stroke_width=1.5)
    c.math_text(
        nix + 34.0,
        niy + 20.0,
        roman("node ") + "i" + roman(" (") + "ϕ" + sub("i") + roman(")"),
        fill="flux",
        size=10.3,
        anchor="middle",
        halo=True,
    )

    c.math_text(775.0, 226.0, "Ω" + sub("m") + " " + roman("(active P1 patch)"), fill="fm_stroke", size=11.2, italic=False, anchor="middle")
    c.math_text(915.0, 226.0, "Ω" + sub("air") + " " + roman("(zeroed)"), fill="air_stroke", size=11.2, italic=False, anchor="middle")

    c.math_text(
        676,
        266,
        "(K" + sub("A") + ")" + sub("ij") + " = ∫" + sub("Ωm") + " A ∇ϕ" + sub("i") + " · ∇ϕ" + sub("j") + " " + roman("d") + "V",
        fill="flux",
        size=11.8,
    )
    c.math_text(
        676,
        298,
        roman("Lumped: ") + "H" + sub("ex,i") + sup("q") + " = −2 (K" + sub("A") + " m" + sub("q") + ")" + sub("i") + " / "
        "(μ" + sub("0") + " M" + sub("s,i") + " V" + sub("i") + sup("lump") + ")",
        fill="H",
        size=11.2,
    )
    c.math_text(
        676,
        330,
        roman("Consistent (CPU CG): ") + "M" + sub("Ms") + " " + vec("q", sub_text="q") + " = K" + sub("A") + " " + vec("m", sub_text="q"),
        fill="ink",
        size=11.2,
    )
    c.text(
        676,
        362,
        "GPU CSR: RK FMA / relax DD + PGBB " + _code_span("bb_exchange_mass") + ".",
        cls="fm-note",
        raw_markup=True,
    )


# ---------------------------------------------------------------------------
# 2. inter-region-couplings-exchange-rkky
# ---------------------------------------------------------------------------


def _draw_inter_region_couplings(c: SvgCanvas, t: Theme) -> None:
    panel_divider(c, 490, 16, 490, 464)

    # ---- Panel a: Cell-link region exchange ----
    panel_label(
        c,
        16,
        24,
        "a",
        "Cell-link region exchange",
        subtitle="Adjacent ObjectRegion faces · FDM single-layer executable",
    )

    gx, gy = 26.0, 76.0
    cw, ch = 36.0, 33.0
    for r in range(2):
        for col in range(2):
            c.rect(gx + col * (cw + 2), gy + r * (ch + 2), cw, ch, fill="fm_fill", stroke="fm_stroke", stroke_width=1.2, rx=2.5)
        for col in range(2):
            bx = gx + 2 * (cw + 2) + 4 + col * (cw + 2)
            c.rect(bx, gy + r * (ch + 2), cw, ch, fill="hm_fill", stroke="hm_stroke", stroke_width=1.2, rx=2.5)

    iface_x = gx + 2 * (cw + 2) + 1.0
    c.line(iface_x, gy - 3, iface_x, gy + 2 * ch + 5, stroke="accent_violet", stroke_width=2.8)

    spin_arrow(c, gx + cw + 2 + cw * 0.5, gy + 24.0, 24.0, length=16.0, color="m", width=1.7, size="sm")
    spin_arrow(c, iface_x + 3 + cw * 0.5, gy + 24.0, -18.0, length=16.0, color="m", width=1.7, size="sm")
    c.math_text(gx + cw + 2 + cw * 0.5, gy + 11.5, vec("m", sub_text="i"), fill="ink", size=10.0, anchor="middle")
    c.math_text(iface_x + 3 + cw * 0.5, gy + 11.5, vec("m", sub_text="j"), fill="ink", size=10.0, anchor="middle")

    c.math_text(gx + cw, gy + 2 * ch + 18, roman("Region ") + "a (A" + sub("a") + ")", fill="fm_stroke", size=10.8, anchor="middle")
    c.math_text(iface_x + 3 + cw, gy + 2 * ch + 18, roman("Region ") + "b (A" + sub("b") + ")", fill="hm_stroke", size=10.8, anchor="middle")
    c.math_text(iface_x, gy - 13, "A" + sub("ab"), fill="accent_violet", size=11.5, bold=True, anchor="middle")

    mx = 204.0
    c.text(mx, 78, _code_span("harmonic_mean") + " (default, s ≥ 0):", cls="fm-sub", fill="H", raw_markup=True)
    c.math_text(mx + 8, 98, "A" + sub("ab") + " = s · 2 A" + sub("a") + " A" + sub("b") + " / (A" + sub("a") + " + A" + sub("b") + ")", fill="ink", size=11.6)
    explicit_math = math_span("A" + sub("ab") + " = " + roman("authored [J m") + sup("−1") + roman("]"))
    c.text(mx, 121, _code_span("explicit") + ":  " + explicit_math, cls="fm-sub", fill="flux", raw_markup=True)
    disabled_math = math_span("A" + sub("ab") + " = 0")
    c.text(mx, 143, _code_span("disabled") + ":  " + disabled_math + "  (DMI fails closed)", cls="fm-sub", fill="m", raw_markup=True)

    pf_a = axes_2d(
        c,
        66,
        192,
        396,
        212,
        xlim=(0.0, 5.0),
        ylim=(0.0, 3.0),
        xticks=(0, 1, 2, 3, 4, 5),
        yticks=(0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0),
        ytick_labels=("0.0", "0.5", "1.0", "1.5", "2.0", "2.5", "3.0"),
        grid=True,
        xlabel=roman("Stiffness ratio ") + "A" + sub("b") + " / A" + sub("a"),
        ylabel=roman("Effective link ") + "A" + sub("ab") + " / A" + sub("a"),
        xlabel_offset=30.0,
        ylabel_offset=38.0,
    )

    rs = [5.0 * k / 160.0 for k in range(161)]
    y_arith = [0.5 * (1.0 + r) for r in rs]
    y_h15 = [1.5 * 2.0 * r / (1.0 + r) for r in rs]
    y_h10 = [2.0 * r / (1.0 + r) for r in rs]
    y_h05 = [0.5 * 2.0 * r / (1.0 + r) for r in rs]

    pf_a.plot_curve(rs, y_arith, color="ink_muted", width=1.4, dash="4,3")
    pf_a.plot_curve(rs, y_h15, color="accent_violet", width=2.0)
    pf_a.plot_curve(rs, y_h10, color="H", width=2.4)
    pf_a.plot_curve(rs, y_h05, color="flux", width=2.0)
    pf_a.hline(0.4, color="accent_warm", width=1.8, dash="6,3.5")

    c.math_text(*pf_a.pt(2.58, 2.52), "½(A" + sub("a") + " + A" + sub("b") + ")", fill="ink_muted", size=10.5, anchor="middle", halo=True)
    c.math_text(*pf_a.pt(4.85, 2.24), roman("harmonic ") + "s = 1.5", fill="accent_violet", size=10.6, anchor="end", halo=True)
    c.math_text(*pf_a.pt(4.85, 1.80), roman("harmonic ") + "s = 1.0", fill="H", size=10.8, bold=True, anchor="end", halo=True)
    c.math_text(*pf_a.pt(4.85, 0.99), roman("harmonic ") + "s = 0.5", fill="flux", size=10.6, anchor="end", halo=True)
    c.math_text(*pf_a.pt(4.85, 0.50), roman("explicit ") + "A" + sub("ab") + " = " + roman("const"), fill="accent_warm", size=10.4, anchor="end", halo=True)

    c.text(
        24,
        458,
        "Executable: FDM GPU CUDA & CPU AoS · Unsupported: FEM & FDM multilayer.",
        cls="fm-note",
    )

    # ---- Panel b: Surface RKKY & interlayer exchange ----
    panel_label(
        c,
        508,
        24,
        "b",
        "Surface RKKY & interlayer exchange",
        subtitle="Bilayer spacer oscillation & surface energy · authored_only IR",
    )

    sx0, sw = 518.0, 162.0
    layer_slab(c, sx0, 66, sw, 28, kind="hm", label="FM2 (Γ" + sub("b") + ")", label_pos="left", label_markup=True)
    layer_slab(c, sx0, 96, sw, 18, kind="spacer", dash="4,2.5", stroke_width=1.0)
    layer_slab(c, sx0, 116, sw, 28, kind="fm", label="FM1 (Γ" + sub("a") + ")", label_pos="left", label_markup=True)
    c.text(sx0 + 0.5 * sw, 108.5, "spacer", cls="fm-note", fill="spacer_stroke", anchor="middle")

    spin_arrow(c, sx0 + 110, 80, 38.0, length=20.0, color="H", width=1.9, size="sm")
    c.math_text(sx0 + 128, 83, vec("m", sub_text="b"), fill="H", size=10.8)
    spin_arrow(c, sx0 + 110, 130, 0.0, length=20.0, color="m", width=1.9, size="sm")
    c.math_text(sx0 + 128, 134, vec("m", sub_text="a"), fill="m", size=10.8)

    bracket_dim(c, sx0 + sw, 96, sx0 + sw, 114, label="t", offset=-11.0, color="ink_muted", arrow=False, label_offset=8.0)

    rx = 708.0
    c.math_text(
        rx,
        78,
        "σ" + sub("surf") + "(Δθ) = −J" + sub("1") + "(" + vec("m", sub_text="a") + "·" + vec("m", sub_text="b") + ") "
        "− J" + sub("2") + "(" + vec("m", sub_text="a") + "·" + vec("m", sub_text="b") + ")" + sup("2"),
        fill="accent_violet",
        size=11.3,
    )
    c.math_text(
        rx,
        101,
        "E" + sub("surf") + " = ∫" + sub("Γab") + " σ" + sub("surf") + " " + roman("d") + "S,   "
        + vec("m", sub_text="a") + "·" + vec("m", sub_text="b") + " = " + roman("cos") + " Δθ",
        fill="ink",
        size=11.0,
    )
    c.math_text(
        rx,
        124,
        "J" + sub("1") + " &gt; 0" + roman(": FM (0°)") + "  ·  J" + sub("1") + " &lt; 0" + roman(": AFM (180°)"),
        fill="ink_secondary",
        size=10.8,
    )
    c.math_text(
        rx,
        145,
        "J" + sub("2") + " &lt; 0" + roman(": canted ") + roman("cos") + " Δθ" + sup("*") + " = −J" + sub("1") + " / (2J" + sub("2") + ")",
        fill="accent_warm",
        size=10.8,
    )

    pf_b = axes_2d(
        c,
        560,
        192,
        394,
        212,
        xlim=(0.45, 2.55),
        ylim=(-1.15, 0.72),
        xticks=(0.5, 1.0, 1.5, 2.0, 2.5),
        yticks=(-1.0, -0.5, 0.0, 0.5),
        ytick_labels=("−1.0", "−0.5", "0.0", "+0.5"),
        grid=True,
        zero_lines=True,
        xlabel=roman("Spacer thickness ") + "t" + roman(" [nm]"),
        ylabel="J" + sub("RKKY") + "(t)" + roman(" [arb. u.]"),
        xlabel_offset=30.0,
        ylabel_offset=40.0,
    )

    ts = [0.45 + (2.55 - 0.45) * k / 240.0 for k in range(241)]
    t0 = 0.70
    phi0 = -0.40 * math.pi
    j_vals = [0.95 * math.cos(2.0 * math.pi * tv + phi0) / ((tv / t0) ** 2) for tv in ts]
    j_pos = [max(0.0, jv) for jv in j_vals]
    j_neg = [min(0.0, jv) for jv in j_vals]
    env_pos = [0.95 / ((tv / t0) ** 2) for tv in ts]
    env_neg = [-0.95 / ((tv / t0) ** 2) for tv in ts]

    pf_b.fill_between(ts, j_pos, 0.0, fill="H_soft", opacity=0.72)
    pf_b.fill_between(ts, j_neg, 0.0, fill="m_soft", opacity=0.72)
    pf_b.plot_curve(ts, env_pos, color="hairline", width=1.1, dash="3,3")
    pf_b.plot_curve(ts, env_neg, color="hairline", width=1.1, dash="3,3")
    pf_b.plot_curve(ts, j_vals, color="accent_violet", width=2.2)
    c.line(pf_b.px(0.45), pf_b.py(0.0), pf_b.px(2.55), pf_b.py(0.0), stroke="axis", stroke_width=1.0)

    afm_t = 0.70
    afm_j = 0.95 * math.cos(2.0 * math.pi * afm_t + phi0) / ((afm_t / t0) ** 2)
    pf_b.scatter([afm_t], [afm_j], r=3.6, fill="m")
    ax_p, ay_p = pf_b.pt(0.92, -0.82)
    c.math_text(ax_p, ay_p, roman("AFM (") + "J" + sub("1") + " &lt; 0" + roman(")"), fill="m", size=10.8, bold=True, halo=True)
    spin_arrow(c, ax_p + 14, ay_p + 13, 0.0, length=16.0, color="m", width=1.5, size="sm")
    spin_arrow(c, ax_p + 14, ay_p + 23, 180.0, length=16.0, color="H", width=1.5, size="sm")

    fm_t = 1.20
    fm_j = 0.95 * math.cos(2.0 * math.pi * fm_t + phi0) / ((fm_t / t0) ** 2)
    pf_b.scatter([fm_t], [fm_j], r=3.6, fill="H")
    fx_p, fy_p = pf_b.pt(1.12, 0.56)
    c.math_text(fx_p, fy_p, roman("FM (") + "J" + sub("1") + " &gt; 0" + roman(")"), fill="H", size=10.8, bold=True, anchor="start", halo=True)
    spin_arrow(c, fx_p + 76, fy_p - 6, 0.0, length=15.0, color="m", width=1.5, size="sm")
    spin_arrow(c, fx_p + 76, fy_p + 3, 0.0, length=15.0, color="H", width=1.5, size="sm")

    c.math_text(
        *pf_b.pt(2.50, 0.30),
        "J" + sub("RKKY") + "(t) ∝ " + roman("cos") + "(2k" + sub("F") + "t + φ" + sub("0") + ") / t" + sup("2"),
        fill="accent_violet",
        size=10.6,
        anchor="end",
        halo=True,
    )

    c.text(
        516,
        458,
        _code_span("authored_only") + " ProblemIR · rejected fail-closed in strict runtime on all 4 lanes.",
        cls="fm-note",
        raw_markup=True,
    )


# ---------------------------------------------------------------------------
# 3. demag-solver-families-comparison
# ---------------------------------------------------------------------------


def _draw_demag_solver_families(c: SvgCanvas, t: Theme) -> None:
    # ---- Top continuum physics strip (borderless) ----
    bx, by, bw, bh = 38.0, 30.0, 142.0, 56.0
    c.rect(bx, by, bw, bh, fill="fm_fill", stroke="fm_stroke", stroke_width=1.5, rx=3)
    vector_arrow(c, bx + 20, by + 16, bx + 62, by + 12, color="m", width=1.8, size="sm")
    vector_arrow(c, bx + 84, by + 12, bx + 124, by + 16, color="m", width=1.8, size="sm")
    vector_arrow(c, bx + 20, by + 40, bx + 62, by + 44, color="m", width=1.8, size="sm")
    vector_arrow(c, bx + 84, by + 44, bx + 124, by + 40, color="m", width=1.8, size="sm")
    c.math_text(bx + 71, by + 32, "Ω" + sub("m"), fill="ink", size=12.0, bold=True, italic=False, anchor="middle", halo=True)

    for dy in (12.0, 28.0, 44.0):
        c.circle(bx, by + dy, 5.2, fill="H")
        c.text(bx, by + dy + 3.4, "−", cls="fm-note", fill="surface_ref", weight=700, anchor="middle")
        c.circle(bx + bw, by + dy, 5.2, fill="accent_warm")
        c.text(bx + bw, by + dy + 3.4, "+", cls="fm-note", fill="surface_ref", weight=700, anchor="middle")

    c.path(
        f"M {bx + bw + 4} {by + 8} C {bx + bw + 34} {by - 20}, {bx - 34} {by - 20}, {bx - 4} {by + 8}",
        stroke="H",
        stroke_width=1.4,
        dash="4,3",
        marker_end=c.marker_url("H", size="sm"),
    )
    c.path(
        f"M {bx + bw + 4} {by + bh - 8} C {bx + bw + 34} {by + bh + 20}, {bx - 34} {by + bh + 20}, {bx - 4} {by + bh - 8}",
        stroke="H",
        stroke_width=1.4,
        dash="4,3",
        marker_end=c.marker_url("H", size="sm"),
    )
    c.math_text(bx + bw + 18, by + 32, vec("H", sub_text="d"), fill="H", size=11.4, anchor="start")

    c.text(248, 28, "Continuum magnetostatic problem", cls="fm-label-bold")
    c.math_text(
        248,
        51,
        "∇×" + vec("H", sub_text="d") + " = " + vec("0") + ",   ∇·(" + vec("H", sub_text="d") + " + " + vec("M") + ") = 0,   " + vec("H", sub_text="d") + " = −∇u",
        fill="H",
        size=11.8,
    )
    c.math_text(
        248,
        74,
        "ρ" + sub("m") + " = −∇·" + vec("M") + " " + roman("(in Ω") + sub("m") + roman(")") + ",   "
        "σ" + sub("m") + " = " + vec("M") + "·" + vec("n") + " " + roman("(on Γ") + sub("m") + roman(")"),
        fill="m",
        size=11.5,
    )
    c.text(248, 95, "Open exterior decay: " + math_span("u(" + vec("x") + ") → 0") + " as " + math_span("|" + vec("x") + "| → ∞"), cls="fm-note", raw_markup=True)

    panel_divider(c, 586, 18, 586, 98)

    c.text(606, 28, "Potential & energy equivalence", cls="fm-label-bold")
    c.math_text(606, 51, "Δu = ∇·" + vec("M") + "  " + roman("(distributional)"), fill="ink", size=11.8)
    c.math_text(
        606,
        74,
        "E" + sub("d") + " = −(μ" + sub("0") + "/2) ∫" + sub("Ωm") + " " + vec("M") + "·" + vec("H", sub_text="d") + " " + roman("d") + "V "
        "= (μ" + sub("0") + "/2) ∫" + sub("ℝ³") + " |" + vec("H", sub_text="d") + "|" + sup("2") + " " + roman("d") + "V",
        fill="ink",
        size=11.5,
    )
    c.text(606, 95, "Evaluated on active magnetic support (no surface double-counting).", cls="fm-note")

    panel_divider(c, 16, 112, 964, 112)
    panel_divider(c, 490, 122, 490, 598)
    panel_divider(c, 16, 360, 964, 360)

    # ---- Panel a: FDM open FFT convolution ----
    panel_label(c, 16, 134, "a", "FDM open FFT convolution", subtitle="Cell-averaged Newell tensor · no airbox mesh")

    dashed_region(
        c,
        24,
        166,
        178,
        142,
        stroke="air_stroke",
        fill="air_fill",
        fill_opacity=0.65,
        label="2N" + sub("x") + "×2N" + sub("y") + "×2N" + sub("z") + " pad",
        label_pos="top-right",
        label_markup=True,
    )
    gx0, gy0 = 32.0, 224.0
    for r in range(4):
        for col in range(5):
            c.rect(gx0 + col * 17, gy0 + r * 17, 17, 17, fill="fm_fill", stroke="fm_stroke", stroke_width=0.85)
            if (r + col) % 2 == 0:
                spin_arrow(c, gx0 + col * 17 + 8.5, gy0 + r * 17 + 8.5, 0.0, length=10.0, color="m", width=1.3, size="sm")
    c.math_text(gx0 + 42, gy0 - 7, "Ω" + sub("m") + " (N)", fill="m", size=10.8, italic=False, anchor="middle")
    c.text(158, 250, "M = 0", cls="fm-note", fill="air_stroke", anchor="middle")
    c.text(158, 265, "zero pad", cls="fm-note", fill="air_stroke", anchor="middle")

    tx = 220.0
    c.math_text(tx, 184, vec("H", sub_text="d,p") + " = −Σ" + sub("q") + " N" + sup("cell") + sub("pq") + " " + vec("M", sub_text="q"), fill="H", size=12.0)
    c.math_text(tx, 210, "Ĥ" + sub("d") + "(" + vec("k") + ") = −N̂" + sup("cell") + "(" + vec("k") + ") M̂(" + vec("k") + ")", fill="ink", size=11.8)
    c.text_lines(
        tx,
        238,
        [
            "• 6 symmetric 27-point Newell components",
            "• No scalar potential u or airbox mesh",
            "• Multilayer option skips vacuum gaps",
            "• FDM CPU: FP64 reference + multilayer",
            "• FDM GPU: Hermitian D2Z / R2C cuFFT",
        ],
        line_height=19.0,
        cls="fm-sub",
    )

    # ---- Panel b: FEM Poisson airbox ----
    sub_b = "Conforming shared domain " + math_span("Ω" + sub("m") + " ⊂ Ω" + sub("a"), italic=False)
    panel_label(c, 508, 134, "b", "FEM Poisson airbox", subtitle=sub_b, subtitle_markup=True)

    ax0, ay0, aw, ah = 516.0, 166.0, 174.0, 142.0
    c.rect(ax0, ay0, aw, ah, fill="air_fill", stroke="H", stroke_width=2.0, rx=2)
    ix0, iy0, iw, ih = ax0 + 46, ay0 + 42, 82.0, 58.0
    outer_pts = [
        (ax0, ay0), (ax0 + aw * 0.5, ay0), (ax0 + aw, ay0),
        (ax0 + aw, ay0 + ah * 0.5), (ax0 + aw, ay0 + ah),
        (ax0 + aw * 0.5, ay0 + ah), (ax0, ay0 + ah), (ax0, ay0 + ah * 0.5),
    ]
    inner_pts = [
        (ix0, iy0), (ix0 + iw * 0.5, iy0), (ix0 + iw, iy0),
        (ix0 + iw, iy0 + ih * 0.5), (ix0 + iw, iy0 + ih),
        (ix0 + iw * 0.5, iy0 + ih), (ix0, iy0 + ih), (ix0, iy0 + ih * 0.5),
    ]
    for p_out, p_in in zip(outer_pts, inner_pts):
        c.line(p_out[0], p_out[1], p_in[0], p_in[1], stroke="hairline", stroke_width=0.9)
    c.rect(ax0 + 23, ay0 + 21, aw - 46, ah - 42, fill="none", stroke="hairline", stroke_width=0.85, dash="3,2.5")
    c.rect(ix0, iy0, iw, ih, fill="fm_fill", stroke="fm_stroke", stroke_width=1.6)
    c.line(ix0, iy0, ix0 + iw, iy0 + ih, stroke="fm_stroke", stroke_width=0.75, opacity=0.75)
    c.line(ix0 + iw, iy0, ix0, iy0 + ih, stroke="fm_stroke", stroke_width=0.75, opacity=0.75)
    c.line(ix0 + iw * 0.5, iy0, ix0 + iw * 0.5, iy0 + ih, stroke="fm_stroke", stroke_width=0.75, opacity=0.75)
    c.rect(ix0 + iw * 0.5 - 15, iy0 + ih * 0.5 - 10, 30, 20, fill="fm_fill", rx=3)
    c.math_text(ix0 + iw * 0.5, iy0 + ih * 0.5 + 4, "Ω" + sub("m"), fill="m", size=11.8, bold=True, italic=False, anchor="middle")
    c.math_text(ax0 + 52, ay0 + 15, "Ω" + sub("a"), fill="air_stroke", size=11.0, italic=False, anchor="middle", halo=True)
    c.math_text(ax0 + aw - 52, ay0 + 15, "Γ" + sub("a"), fill="H", size=11.2, bold=True, italic=False, anchor="middle", halo=True)

    tx_b = 708.0
    c.math_text(
        tx_b,
        184,
        "∫" + sub("Ωa") + " ∇u·∇v " + roman("d") + "V + β∫" + sub("Γa") + " uv " + roman("d") + "S = ∫" + sub("Ωm") + " " + vec("M") + "·∇v " + roman("d") + "V",
        fill="H",
        size=11.2,
    )
    c.math_text(tx_b, 210, roman("Robin: ") + "∂" + sub("n") + "u + βu = 0   " + roman("|  Dirichlet: ") + "u = 0", fill="ink", size=11.2)
    c.text(tx_b, 238, "• P2 potential on " + _code_span("tet4") + " &amp; " + _code_span("pure_prism_p2"), cls="fm-sub", raw_markup=True)
    c.text(tx_b, 257, "• P1 potential on " + _code_span("mixed_p1") + " (pyramids)", cls="fm-sub", raw_markup=True)
    c.text(tx_b, 276, "• FEM CPU: MFEM + Hypre CG/AMG", cls="fm-sub")
    c.text(tx_b, 295, "• FEM GPU: " + _code_span("cuDSS") + " Cholesky (" + _code_span("auto") + ") or", cls="fm-sub", raw_markup=True)
    c.text(tx_b, 314, "  device Hypre CG/AMG (coarse relax 18)", cls="fm-sub")

    # ---- Panel c: FEM-BEM Fredkin-Koehler ----
    panel_label(c, 16, 382, "c", "FEM–BEM Fredkin–Koehler", subtitle="Closed body-only tet4 mesh · no airbox")

    fcx, fcy = 112.0, 488.0
    c.circle(fcx, fcy, 68.0, fill="none", stroke="accent_violet", stroke_width=1.1, dash="4,3.5", opacity=0.65)
    c.text(fcx, fcy - 73.0, "open exterior (no airbox)", cls="fm-note", fill="accent_violet", anchor="middle")

    body_r = 50.0
    poly_pts = [
        (fcx + body_r * math.cos(math.radians(a)), fcy + body_r * math.sin(math.radians(a)))
        for a in range(-90, 270, 45)
    ]
    c.polygon(poly_pts, fill="fm_fill", stroke="accent_violet", stroke_width=2.2)
    for pt in poly_pts:
        dx, dy = pt[0] - fcx, pt[1] - fcy
        norm = math.hypot(dx, dy) or 1.0
        c.line(fcx + 17.5 * dx / norm, fcy + 17.5 * dy / norm, pt[0], pt[1], stroke="fm_stroke", stroke_width=0.85, opacity=0.75)
    c.math_text(fcx, fcy + 4, "Ω" + sub("m"), fill="m", size=12.0, bold=True, italic=False, anchor="middle")
    c.math_text(fcx + 48, fcy + 44, "Γ" + sub("m"), fill="accent_violet", size=11.6, bold=True, italic=False)

    tx_c = 220.0
    c.math_text(tx_c, 434, "u = u" + sub("1") + " + u" + sub("2") + ",   g" + sub("2") + " = ℬ γu" + sub("1") + " " + roman("on Γ") + sub("m"), fill="accent_violet", size=11.8)
    c.math_text(tx_c, 460, "Δu" + sub("1") + " = ∇·" + vec("M") + "  →  ℬ  →  Δu" + sub("2") + " = 0", fill="ink", size=11.4)
    c.text(tx_c, 488, "• Closed watertight " + _code_span("tet4") + " P1 body only", cls="fm-sub", raw_markup=True)
    c.text(tx_c, 507, "• FEM CPU: " + math_span("H" + sup("2")) + " near Lindholm + far ACA", cls="fm-sub", raw_markup=True)
    c.text(tx_c, 526, "• FEM GPU: CUDA near CSR + far ACA,", cls="fm-sub")
    c.text(tx_c, 545, "  atomic " + math_span("(u" + sub("1") + ", u" + sub("2") + ")") + " " + _code_span("cuDSS") + " or CG/AMG", cls="fm-sub", raw_markup=True)
    c.text(tx_c, 564, "• Generic " + _code_span("bem") + " / " + _code_span("fmm") + " remain planner-gated", cls="fm-sub", raw_markup=True)

    # ---- Panel d: Periodic demagnetization ----
    panel_label(c, 508, 382, "d", "Periodic demagnetization", subtitle="FDM finite image replicas vs FEM reduced airbox")

    c.text(520, 424, "FDM: " + _code_span("truncated_images"), cls="fm-label-bold", fill="H", raw_markup=True)
    tx0, ty0 = 546.0, 436.0
    tw, th = 34.0, 22.0
    for r in range(3):
        for col in range(3):
            is_c = r == 1 and col == 1
            c.rect(
                tx0 + col * (tw + 4),
                ty0 + r * (th + 4),
                tw,
                th,
                fill="fm_fill" if is_c else "air_fill",
                stroke="m" if is_c else "air_stroke",
                stroke_width=1.6 if is_c else 0.9,
                dash=None if is_c else "3,2",
                rx=2,
            )
            c.text(
                tx0 + col * (tw + 4) + tw * 0.5,
                ty0 + r * (th + 4) + th * 0.5 + 3.5,
                "n=0" if is_c else "img",
                cls="fm-note",
                fill="m" if is_c else "air_stroke",
                weight=600 if is_c else 400,
                anchor="middle",
            )
    c.math_text(602, 528, "N" + sup("P") + " = Σ" + sub("n=−I..I") + " N(" + vec("r") + " + nL" + hat("e") + ")", fill="ink", size=11.0, anchor="middle")
    c.text(520, 548, "• Dipole tail " + math_span("r ≥ 40 h" + sub("max")) + "; P = N on PBC", cls="fm-note", raw_markup=True)
    c.text(520, 566, "• GPU FP64 cuFFT (FP32+PBC rejected)", cls="fm-note")
    c.text(520, 584, "• Rejects " + _code_span("periodic_airbox_k0") + " in FDM", cls="fm-note", raw_markup=True)

    panel_divider(c, 738, 414, 738, 592, dashed=True)

    c.text(752, 424, "FEM: " + _code_span("periodic_airbox_k0"), cls="fm-label-bold", fill="flux", raw_markup=True)
    px0, py0, pw, ph = 786.0, 440.0, 124.0, 68.0
    c.rect(px0, py0, pw, ph, fill="air_fill", stroke="H", stroke_width=1.2)
    c.line(px0, py0, px0, py0 + ph, stroke="flux", stroke_width=3.0)
    c.line(px0 + pw, py0, px0 + pw, py0 + ph, stroke="flux", stroke_width=3.0)
    c.rect(px0 + 18, py0 + 22, pw - 36, 24, fill="fm_fill", stroke="fm_stroke", stroke_width=1.4)
    c.math_text(px0 + pw * 0.5, py0 + 38, "Ω" + sub("m") + " " + roman("(open z)"), fill="m", size=10.6, anchor="middle")
    c.math_text(px0 - 8, py0 + ph * 0.5 + 4, "P", fill="flux", size=11.5, bold=True, anchor="end")
    c.math_text(px0 + pw + 8, py0 + ph * 0.5 + 4, "P", fill="flux", size=11.5, bold=True, anchor="start")

    c.math_text(848, 528, "A" + sub("p") + " = P" + sup("T") + "A" + sub("open") + "P,   b" + sub("p") + " = P" + sup("T") + "b", fill="ink", size=11.0, anchor="middle")
    c.text(752, 548, "• 1D Robin or 2D film (Neumann + pin)", cls="fm-note")
    c.text(752, 566, "• GPU " + _code_span("cuDSS") + " / CG+AMG (≥1 open axis)", cls="fm-note", raw_markup=True)
    c.text(752, 584, "• 3D unpinned & P2 prism fail closed", cls="fm-note")


# ---------------------------------------------------------------------------
# 4. demag-fdm-newell-and-multilayer
# ---------------------------------------------------------------------------


def _draw_demag_fdm_newell_multilayer(c: SvgCanvas, t: Theme) -> None:
    panel_divider(c, 16, 286, 964, 286)
    panel_divider(c, 496, 338, 496, 610)

    # ---- Panel a: Newell tensor, 2N zero-pad, & Hermitian half-spectrum cuFFT ----
    panel_label(
        c,
        16,
        24,
        "a",
        "Newell 27-point cell average, 2N zero-padding, & Hermitian half-spectrum cuFFT",
    )

    c.text(22, 54, "1. Cell-averaged Newell tensor", cls="fm-label-bold")
    iso_slab(c, 34, 128, 58, 38, depth_dx=18, depth_dy=-12, kind="fm")
    c.math_text(63, 146, "q", fill="m", size=12.5, bold=True, anchor="middle")
    c.math_text(63, 160, vec("M", sub_text="q") + ", " + vec("h", sub_text="s"), fill="ink_secondary", size=9.8, anchor="middle")

    iso_slab(c, 166, 86, 58, 38, depth_dx=18, depth_dy=-12, kind="hm")
    c.math_text(195, 104, "p", fill="H", size=12.5, bold=True, anchor="middle")
    c.math_text(195, 118, vec("H", sub_text="d,p") + ", " + vec("h", sub_text="d"), fill="ink_secondary", size=9.8, anchor="middle")

    vector_arrow(
        c,
        106,
        136,
        161,
        112,
        color="ink",
        width=1.7,
        size="sm",
        label=vec("r", sub_text="p") + " − " + vec("r", sub_text="q"),
        label_pos=(126, 108),
    )

    wy = 192.0
    weights = [
        ("m", "+8 center"),
        ("H", "−4 faces (6)"),
        ("accent_warm", "+2 edges (12)"),
        ("accent_violet", "−1 corners (8)"),
    ]
    for idx, (col, lbl) in enumerate(weights):
        wx = 26.0 + (idx % 2) * 120.0
        wy_row = wy + (idx // 2) * 18.0
        c.circle(wx, wy_row - 3.5, 3.6, fill=col)
        c.text(wx + 8, wy_row, lbl, cls="fm-note", fill="ink_secondary")

    c.math_text(
        22,
        242,
        "N" + sub("xx") + " = (8f" + sub("0") + " − 4Σ" + sub("f") + "f + 2Σ" + sub("e") + "f − Σ" + sub("c") + "f) / (4πh" + sub("x") + "h" + sub("y") + "h" + sub("z") + ")",
        fill="ink",
        size=10.8,
    )
    c.text(22, 264, "6 symmetric components · Kahan–Neumaier + log1p", cls="fm-note")

    vector_arrow(c, 266, 134, 290, 134, color="H", width=1.9, size="md")

    # Stage 2: 2N Zero-padded real-space layout
    c.text(302, 54, "2. 2N zero-padded real-space buffers", cls="fm-label-bold")
    bx2 = 304.0
    c.math_text(bx2, 78, roman("Input ") + vec("M") + "(" + vec("r") + ") " + roman("packed into ") + "F = 2N:", fill="ink_secondary", size=10.8)
    c.rect(bx2, 86, 140, 26, fill="fm_fill", stroke="m", stroke_width=1.4, rx=2)
    c.text(bx2 + 70, 103, "[0 .. N−1] active M", cls="fm-note", fill="m", weight=600, anchor="middle")
    c.rect(bx2 + 140, 86, 140, 26, fill="air_fill", stroke="air_stroke", stroke_width=1.1, dash="4,3", rx=2)
    c.text(bx2 + 210, 103, "[N .. 2N−1] M = 0 pad", cls="fm-note", fill="air_stroke", anchor="middle")

    c.math_text(bx2, 134, roman("Wrap-ordered kernel ") + "N" + sup("cell") + roman("(lag) on ") + "2N:", fill="ink_secondary", size=10.8)
    c.rect(bx2, 142, 126, 26, fill="hm_fill", stroke="H", stroke_width=1.3, rx=2)
    c.text(bx2 + 63, 159, "+lags [0 .. N−1]", cls="fm-note", fill="H", weight=600, anchor="middle")
    c.rect(bx2 + 126, 142, 28, 26, fill="surface_subtle", stroke="hairline", stroke_width=1.0)
    c.text(bx2 + 140, 159, "0", cls="fm-note", anchor="middle")
    c.rect(bx2 + 154, 142, 126, 26, fill="accent_violet_soft", stroke="accent_violet", stroke_width=1.3, rx=2)
    c.text(bx2 + 217, 159, "−lags [N+1 .. 2N−1]", cls="fm-note", fill="accent_violet", weight=600, anchor="middle")

    c.text(
        bx2,
        196,
        "• Padding " + math_span("F ≥ n" + sub("src") + " + n" + sub("dst") + " − 1") + " prevents wraparound",
        cls="fm-note",
        raw_markup=True,
    )
    c.text(bx2, 215, "• Crop [0 .. N−1] after iFFT gives linear conv.", cls="fm-note")
    c.text(bx2, 234, "• Near (< 40 cells): exact Newell · Far: dipole", cls="fm-note")

    vector_arrow(c, 594, 134, 622, 134, color="flux", width=1.9, size="md")
    c.text(608, 123, "D2Z", cls="fm-note", fill="flux", weight=600, anchor="middle")
    c.text(608, 150, "R2C", cls="fm-note", fill="flux", anchor="middle")

    # Stage 3: Hermitian half-spectrum cuFFT
    c.text(632, 54, "3. Hermitian half-spectrum cuFFT", cls="fm-label-bold")
    sx3 = 634.0
    c.math_text(
        sx3,
        73,
        roman("Real-valued ") + vec("M") + ", N" + sup("cell") + " ⇒ " + roman("conjugate symmetry along ") + "k" + sub("x") + ":",
        fill="ink_secondary",
        size=10.6,
    )
    c.rect(sx3, 84, 174, 42, fill="flux_soft", stroke="flux", stroke_width=1.6, rx=2)
    c.math_text(sx3 + 87, 100, "F" + sub("x") + sup("half") + " = ⌊F" + sub("x") + "/2⌋ + 1", fill="flux", size=10.8, bold=True, anchor="middle")
    c.text(sx3 + 87, 119, "stored (3 M̂ + 6 N̂ buffers)", cls="fm-note", fill="flux", size=9.8, anchor="middle")

    c.rect(sx3 + 174, 84, 146, 42, fill="air_fill", stroke="air_stroke", stroke_width=1.0, dash="4,3", rx=2, fill_opacity=0.55)
    c.text(sx3 + 247, 101, "conjugate mirror", cls="fm-note", fill="air_stroke", anchor="middle")
    c.text(sx3 + 247, 118, "(not stored)", cls="fm-note", fill="air_stroke", anchor="middle")

    c.math_text(
        sx3 + 160,
        148,
        "Ĥ" + sub("d") + "(" + vec("k") + ") = −N̂" + sup("cell") + "(" + vec("k") + ") M̂(" + vec("k") + ")",
        fill="H",
        size=12.4,
        bold=True,
        anchor="middle",
    )
    c.math_text(
        sx3 + 160,
        171,
        vec("H", sub_text="d") + " = ℱ" + sup("−1") + "[Ĥ" + sub("d") + "] / (F" + sub("x") + "F" + sub("y") + "F" + sub("z") + ")   " + roman("(Z2D / C2R)"),
        fill="ink",
        size=11.2,
        anchor="middle",
    )

    c.text(sx3, 198, "• Zero mathematical approximation (exact Hermitian)", cls="fm-note")
    c.text(
        sx3,
        216,
        "• Shared " + math_span("max(W" + sub("fwd") + ", W" + sub("inv") + ")") + " scratch (−12% to −23% VRAM)",
        cls="fm-note",
        raw_markup=True,
    )
    c.text(
        sx3,
        234,
        "• FP64 parity " + math_span("|ΔE" + sub("d") + "|/|E" + sub("d") + "| ≤ 1.8×10" + sup("−16")) + " vs CPU",
        cls="fm-note",
        raw_markup=True,
    )
    c.text(sx3, 252, "• Exact VRAM preflight before allocation", cls="fm-note")

    # ---- Panel b: Multilayer z-stack (left) & Periodic convergence (right) ----
    panel_label(
        c,
        16,
        310,
        "b",
        "Multilayer z-stack convolution (Lepadatu 2019) vs periodic image truncation",
    )

    c.text(22, 342, "Vacuum-skipping multilayer convolution (open BC)", cls="fm-label-bold", fill="flux")

    lx0, lw = 24.0, 174.0
    l2x, l2y, l2w, l2h = lx0 + 12, 362.0, lw - 24, 46.0
    c.rect(l2x, l2y, l2w, l2h, fill="fm_fill", stroke="m", stroke_width=1.4, rx=2)
    for k in range(1, 5):
        c.line(l2x + k * l2w / 5.0, l2y, l2x + k * l2w / 5.0, l2y + l2h, stroke="fm_stroke", stroke_width=0.6, opacity=0.45)
    c.line(l2x, l2y + l2h * 0.5, l2x + l2w, l2y + l2h * 0.5, stroke="fm_stroke", stroke_width=0.6, opacity=0.45)
    c.rect(l2x + 14, l2y + 5, l2w - 28, 36, fill="fm_fill", fill_opacity=0.92, rx=2)
    c.math_text(l2x + l2w * 0.5, l2y + 18, roman("Layer 2 (native ") + vec("h", sub_text="2") + roman(")"), fill="m", size=10.6, bold=True, anchor="middle")
    c.text(l2x + l2w * 0.5, l2y + 35, "distinct pitch / extent", cls="fm-note", anchor="middle")

    gy_s, gh_s = 414.0, 44.0
    c.rect(lx0, gy_s, lw, gh_s, fill="none", stroke="air_stroke", stroke_width=1.0, dash="4,3", rx=2)
    c.text(lx0 + lw * 0.5, gy_s + 18, "vacuum / spacer (unmeshed)", cls="fm-note", fill="air_stroke", anchor="middle")
    c.math_text(lx0 + lw * 0.5, gy_s + 35, vec("δ", sub_text="2,1") + " = " + vec("o", sub_text="2") + " − " + vec("o", sub_text="1"), fill="ink_secondary", size=10.6, anchor="middle")

    l1y, l1h = 464.0, 42.0
    c.rect(lx0, l1y, lw, l1h, fill="fm_fill", stroke="m", stroke_width=1.4, rx=2)
    for k in range(1, 9):
        c.line(lx0 + k * lw / 9.0, l1y, lx0 + k * lw / 9.0, l1y + l1h, stroke="fm_stroke", stroke_width=0.6, opacity=0.45)
    c.rect(lx0 + 20, l1y + 11, lw - 40, 20, fill="fm_fill", fill_opacity=0.92, rx=2)
    c.math_text(lx0 + lw * 0.5, l1y + 25, roman("Layer 1 (native ") + vec("h", sub_text="1") + roman(")"), fill="m", size=10.6, bold=True, anchor="middle")

    sx_sc = 264.0
    vector_arrow(c, l2x + l2w + 4, l2y + 14, sx_sc - 4, l2y + 14, color="H", width=1.7, size="sm")
    vector_arrow(c, sx_sc - 4, l2y + 32, l2x + l2w + 4, l2y + 32, color="flux", width=1.7, size="sm")
    c.math_text(224, l2y + 10, roman("Push ") + "P", fill="H", size=10.0, anchor="middle")
    c.math_text(224, l2y + 44, roman("Pull ") + "P" + sup("*"), fill="flux", size=10.0, anchor="middle")

    vector_arrow(c, lx0 + lw + 4, l1y + 13, sx_sc - 4, l1y + 13, color="H", width=1.7, size="sm")
    vector_arrow(c, sx_sc - 4, l1y + 30, lx0 + lw + 4, l1y + 30, color="flux", width=1.7, size="sm")
    c.math_text(230, l1y + 9, roman("Push ") + "P", fill="H", size=10.0, anchor="middle")
    c.math_text(230, l1y + 42, roman("Pull ") + "P" + sup("*"), fill="flux", size=10.0, anchor="middle")

    dashed_region(
        c,
        sx_sc,
        360,
        214,
        150,
        stroke="H",
        fill="H_soft",
        fill_opacity=0.30,
        dash="5,3",
    )
    c.text(sx_sc + 107, 379, "Common FFT supercell", cls="fm-label-bold", fill="H", anchor="middle")
    c.text(sx_sc + 107, 394, "computational scratch (not physical)", cls="fm-note", anchor="middle")

    c.math_text(
        sx_sc + 107,
        420,
        "Ĥ" + sub("d") + "(" + vec("k") + ") = −Σ" + sub("s=1..L") + " N̂" + sub("d←s") + "(" + vec("k") + ") M̂" + sub("s") + "(" + vec("k") + ")",
        fill="ink",
        size=11.0,
        anchor="middle",
    )
    c.math_text(
        sx_sc + 107,
        444,
        "⟨P" + vec("M") + ", " + vec("H", sub_text="c") + "⟩" + sub("Vc") + " = ⟨" + vec("M") + ", P" + sup("*") + vec("H", sub_text="c") + "⟩" + sub("Vn"),
        fill="flux",
        size=10.5,
        anchor="middle",
    )
    c.text(sx_sc + 107, 466, "L fwd + L² pair products + L inv FFTs", cls="fm-note", fill="m", weight=600, anchor="middle")
    c.math_text(
        sx_sc + 107,
        488,
        "V" + sub("d") + " N" + sub("d←s") + "(" + vec("q") + ") = V" + sub("s") + " N" + sub("s←d") + sup("T") + "(−" + vec("q") + ")",
        fill="ink_secondary",
        size=10.2,
        anchor="middle",
    )

    c.text(
        24,
        544,
        "• Unequal " + math_span("h" + sub("s,z") + " ≠ h" + sub("d,z")) + ": irregular Newell " + math_span("ℒ[f; " + vec("h", sub_text="s") + ", " + vec("h", sub_text="d") + "]"),
        cls="fm-note",
        raw_markup=True,
    )
    c.text(
        24,
        566,
        "• Open boundaries only (multilayer PBC fails closed; no single-grid fallback).",
        cls="fm-note",
    )

    # Bottom-right: Periodic image tiling & exact Newell uniform-mode convergence
    c.text(514, 342, "Periodic image truncation & k = 0 convergence (20×20×2 nm)", cls="fm-label-bold", fill="accent_warm")

    ry_t = 356.0
    tile_w, tile_h = 42.0, 20.0
    tile_labels = ["−2", "−1", "n = 0", "+1", "+2"]
    tx_start = 532.0
    c.text(tx_start - 12, ry_t + 14, "⋯", cls="fm-label", fill="ink_muted", anchor="middle")
    for idx, tlbl in enumerate(tile_labels):
        tx_i = tx_start + idx * (tile_w + 4)
        is_zero = idx == 2
        c.rect(
            tx_i,
            ry_t,
            tile_w,
            tile_h,
            fill="fm_fill" if is_zero else "air_fill",
            stroke="m" if is_zero else "air_stroke",
            stroke_width=1.5 if is_zero else 0.9,
            dash=None if is_zero else "3,2",
            rx=2,
        )
        c.text(
            tx_i + tile_w * 0.5,
            ry_t + 13.5,
            tlbl,
            cls="fm-note",
            fill="m" if is_zero else "air_stroke",
            weight=600 if is_zero else 400,
            anchor="middle",
        )
    c.text(tx_start + 5 * (tile_w + 4) + 8, ry_t + 14, "⋯", cls="fm-label", fill="ink_muted", anchor="middle")
    c.text(792, ry_t + 13.5, "PBC: P=N · Open: P=2N", cls="fm-note", fill="ink_secondary", anchor="start")

    img_counts = (0, 1, 2, 4, 8, 16, 32)
    nxx_vals, nzz_vals = _periodic_film_demag_factors(20.0, 20.0, 2.0, img_counts)
    xs_idx = list(range(len(img_counts)))

    pf_p = axes_2d(
        c,
        566,
        394,
        382,
        142,
        xlim=(-0.3, 6.3),
        ylim=(-0.03, 1.06),
        xticks=xs_idx,
        xtick_labels=[str(i) for i in img_counts],
        yticks=(0.0, 0.25, 0.50, 0.75, 1.00),
        ytick_labels=("0.00", "0.25", "0.50", "0.75", "1.00"),
        grid=True,
        xlabel=roman("Image half-count ") + "I" + sub("x") + " = I" + sub("y"),
        ylabel=roman("Uniform-mode ") + "N" + sub("ii") + "(I)",
        xlabel_offset=27.0,
        ylabel_offset=40.0,
    )

    pf_p.hline(1.0, color="H", width=0.95, dash="4,3")
    pf_p.hline(0.0, color="m", width=0.95, dash="4,3")
    pf_p.plot_curve(xs_idx, nzz_vals, color="H", width=2.2)
    pf_p.plot_curve(xs_idx, nxx_vals, color="m", width=2.2)
    pf_p.scatter(xs_idx, nzz_vals, r=3.4, fill="H")
    pf_p.scatter(xs_idx, nxx_vals, r=3.4, fill="m")

    c.math_text(*pf_p.pt(3.1, 0.80), "N" + sub("zz") + "(I) → 1.00", fill="H", size=11.0, bold=True, anchor="middle", halo=True)
    c.math_text(*pf_p.pt(3.1, 0.22), "N" + sub("xx") + "(I) → 0.00", fill="m", size=11.0, bold=True, anchor="middle", halo=True)
    c.text(*pf_p.pt(0.28, nzz_vals[0] - 0.14), f"{nzz_vals[0]:.2f}", cls="fm-note", fill="H", halo=True)
    c.text(*pf_p.pt(5.85, nzz_vals[-1] - 0.14), f"{nzz_vals[-1]:.3f}", cls="fm-note", fill="H", anchor="end", halo=True)
    c.text(*pf_p.pt(0.28, nxx_vals[0] + 0.09), f"{nxx_vals[0]:.2f}", cls="fm-note", fill="m", halo=True)
    c.text(*pf_p.pt(5.85, nxx_vals[-1] + 0.10), f"{nxx_vals[-1]:.3f}", cls="fm-note", fill="m", anchor="end", halo=True)

    c.text(
        514,
        586,
        "Distant dipole tail " + math_span("r ≥ 40 h" + sub("max")) + " avoids Newell cancellation · FDM rejects " + _code_span("periodic_airbox_k0") + ".",
        cls="fm-note",
        raw_markup=True,
    )


# ---------------------------------------------------------------------------
# 5. demag-fem-poisson-airbox-closures
# ---------------------------------------------------------------------------


def _draw_demag_fem_poisson_closures(c: SvgCanvas, t: Theme) -> None:
    panel_divider(c, 474, 16, 474, 518)

    # ---- Panel a: Graded conforming mesh + field lines + 3 implemented closures ----
    sub_a = (
        "Conforming "
        + math_span("Ω" + sub("m") + " ⊂ Ω" + sub("a"), italic=False)
        + " (" + _code_span("tet4") + " P2 / " + _code_span("pure_prism_p2") + ") · "
        + math_span(vec("M") + " = " + vec("0")) + " in air"
    )
    panel_label(
        c,
        16,
        24,
        "a",
        "Shared-domain graded mesh & outer closures",
        subtitle=sub_a,
        subtitle_markup=True,
    )

    cx, cy = 240.0, 184.0
    rings = [
        (308.0, 196.0, "air_fill", "H", 2.2),
        (216.0, 140.0, "none", "hairline", 0.9),
        (146.0, 96.0, "none", "hairline", 0.9),
    ]
    for w, h, fl, st, sw in rings:
        c.rect(cx - w * 0.5, cy - h * 0.5, w, h, fill=fl, stroke=st, stroke_width=sw)

    def _ring_verts(w: float, h: float) -> list[tuple[float, float]]:
        hw, hh = w * 0.5, h * 0.5
        return [
            (cx - hw, cy - hh), (cx - hw * 0.45, cy - hh), (cx, cy - hh), (cx + hw * 0.45, cy - hh), (cx + hw, cy - hh),
            (cx + hw, cy - hh * 0.38), (cx + hw, cy + hh * 0.38),
            (cx + hw, cy + hh), (cx + hw * 0.45, cy + hh), (cx, cy + hh), (cx - hw * 0.45, cy + hh), (cx - hw, cy + hh),
            (cx - hw, cy + hh * 0.38), (cx - hw, cy - hh * 0.38),
        ]

    v_outer = _ring_verts(308.0, 196.0)
    v_mid = _ring_verts(216.0, 140.0)
    v_inner = _ring_verts(146.0, 96.0)
    v_body = _ring_verts(84.0, 56.0)

    for va, vb in ((v_outer, v_mid), (v_mid, v_inner), (v_inner, v_body)):
        n = len(va)
        for i in range(n):
            c.line(va[i][0], va[i][1], vb[i][0], vb[i][1], stroke="hairline", stroke_width=0.75, opacity=0.8)
            j = (i + 1) % n
            if i % 2 == 0:
                c.line(va[i][0], va[i][1], vb[j][0], vb[j][1], stroke="grid", stroke_width=0.7, opacity=0.85)

    # Smooth dipolar stray field lines H_d = -∇u clipped inside outer airbox Ω_a
    air_clip = c.add_clip_rect(cx - 153, cy - 97, 306, 194)
    with c.layer(clip_path=air_clip):
        for r_loop in (72.0, 114.0, 160.0):
            for sign in (-1.0, 1.0):
                pts_loop = []
                for k in range(10, 71):
                    th = math.pi * k / 80.0
                    rad = r_loop * (math.sin(th) ** 2)
                    lx = cx + rad * math.cos(th)
                    ly = cy + sign * rad * math.sin(th)
                    pts_loop.append((lx, ly))
                c.path(
                    curve_path(pts_loop),
                    stroke="H",
                    stroke_width=1.15,
                    dash="4,3",
                    opacity=0.62,
                    marker_end=c.marker_url("H", size="sm"),
                )

    bw, bh = 84.0, 56.0
    c.rect(cx - bw * 0.5, cy - bh * 0.5, bw, bh, fill="fm_fill", stroke="m", stroke_width=1.9)
    for k in range(1, 4):
        x_t = cx - bw * 0.5 + k * bw / 4.0
        c.line(x_t, cy - bh * 0.5, x_t, cy + bh * 0.5, stroke="fm_stroke", stroke_width=0.65, opacity=0.65)
    c.line(cx - bw * 0.5, cy, cx + bw * 0.5, cy, stroke="fm_stroke", stroke_width=0.65, opacity=0.65)
    c.line(cx - bw * 0.5, cy - bh * 0.5, cx + bw * 0.5, cy + bh * 0.5, stroke="fm_stroke", stroke_width=0.6, opacity=0.5)
    c.line(cx - bw * 0.5, cy + bh * 0.5, cx + bw * 0.5, cy - bh * 0.5, stroke="fm_stroke", stroke_width=0.6, opacity=0.5)

    vector_arrow(c, cx - 22, cy - 13, cx + 22, cy - 13, color="m", width=1.9, size="sm")
    c.rect(cx - 26, cy + 3, 52, 18, fill="fm_fill", fill_opacity=0.94, rx=2)
    c.math_text(cx, cy + 16, "Ω" + sub("m") + ": " + vec("M"), fill="m", size=11.0, bold=True, anchor="middle")

    c.math_text(cx, 77, "Γ" + sub("a") + " = ∂Ω" + sub("a") + "  " + roman("(outer marker)"), fill="H", size=11.4, bold=True, anchor="middle")
    vector_arrow(c, cx + 154, cy, cx + 188, cy, color="H", width=2.0, size="md", label=vec("n"), label_pos=(cx + 174, cy - 10))
    c.math_text(cx - 118, cy - 80, "Ω" + sub("a"), fill="air_stroke", size=11.2, italic=False, halo=True)
    c.math_text(22, cy - 10, "h" + sub("body"), fill="ink_muted", size=10.4)
    c.text(22, cy + 5, "↓ graded", cls="fm-note")
    c.math_text(22, cy + 20, "h" + sub("air"), fill="ink_muted", size=10.4)
    c.math_text(cx + 145, cy - 72, vec("H", sub_text="d") + " = −∇u", fill="H", size=10.6, anchor="end", halo=True)

    # Bottom: 3 implemented FEM Poisson outer closures
    panel_divider(c, 16, 304, 456, 304, dashed=True)
    col_xs = (16.0, 168.0, 320.0)

    # Closure 1: Open Robin (default)
    x1 = col_xs[0]
    c.text(x1, 324, "Open Robin", cls="fm-label-bold", fill="flux")
    c.text(x1 + 72, 324, "(default)", cls="fm-note", fill="flux")
    c.rect(x1 + 2, 336, 42, 30, fill="air_fill", stroke="flux", stroke_width=1.8, dash="4,2")
    c.rect(x1 + 14, 345, 18, 12, fill="fm_fill", stroke="m", stroke_width=1.1)
    c.math_text(x1 + 50, 349, "∂" + sub("n") + "u + βu = 0", fill="ink", size=10.6)
    c.math_text(x1 + 50, 365, "β = c / R" + sub("★"), fill="flux", size=10.4)
    c.math_text(x1, 392, "A" + sub("R") + " = K + β B" + sub("Γa"), fill="ink_secondary", size=11.0)
    c.text(x1, 412, "Boundary mass on " + math_span("Γ" + sub("a")) + ";", cls="fm-note", raw_markup=True)
    c.text(x1, 427, "seams excluded.", cls="fm-note")

    # Closure 2: Open Dirichlet
    x2 = col_xs[1]
    c.text(x2, 324, "Open Dirichlet", cls="fm-label-bold", fill="m")
    c.rect(x2 + 2, 336, 42, 30, fill="air_fill", stroke="m", stroke_width=2.0)
    c.rect(x2 + 14, 345, 18, 12, fill="fm_fill", stroke="fm_stroke", stroke_width=1.1)
    c.math_text(x2 + 50, 349, "u = 0 " + roman("on Γ") + sub("a"), fill="ink", size=10.6)
    c.text(x2 + 50, 365, "essential BC", cls="fm-note", fill="m")
    c.math_text(x2, 392, "K" + sub("0") + " û = b  " + roman("(no B") + sub("Γa") + roman(")"), fill="ink_secondary", size=11.0)
    c.text(x2, 412, "Eliminates DOFs on " + math_span("Γ" + sub("a")) + ";", cls="fm-note", raw_markup=True)
    c.text(x2, 427, "shrinks " + math_span("|" + vec("H", sub_text="d") + "|") + " at finite R.", cls="fm-note", raw_markup=True)

    # Closure 3: 2D-Periodic film (Neumann + pin)
    x3 = col_xs[2]
    c.text(x3, 324, "2D-Periodic film", cls="fm-label-bold", fill="H")
    c.rect(x3 + 2, 336, 42, 30, fill="air_fill", stroke="H", stroke_width=1.0, dash="3,2")
    c.line(x3 + 2, 336, x3 + 2, 366, stroke="flux", stroke_width=2.2)
    c.line(x3 + 44, 336, x3 + 44, 366, stroke="flux", stroke_width=2.2)
    c.rect(x3 + 11, 346, 24, 10, fill="fm_fill", stroke="m", stroke_width=1.0)
    c.circle(x3 + 23, 336, 2.8, fill="accent_warm")
    c.math_text(x3 + 50, 349, "∂" + sub("n") + "u = 0 " + roman("(±z)"), fill="ink", size=10.6)
    c.text(x3 + 50, 365, "+ gauge pin", cls="fm-note", fill="accent_warm")
    c.math_text(x3, 392, "A" + sub("p") + " = P" + sup("T") + " A" + sub("open") + " P", fill="ink_secondary", size=11.0)
    c.text(x3, 412, "SPD reduced P1 solve;", cls="fm-note")
    c.text(x3, 427, "3D unpinned fails closed.", cls="fm-note")

    c.text(
        20,
        466,
        "Solvers: GPU " + _code_span("cuDSS") + " Cholesky (" + _code_span("auto") + ") or " + _code_span("CG/AMG") + " (" + _code_span("coarse_relax_type=18") + ").",
        cls="fm-note",
        raw_markup=True,
    )
    c.text(
        20,
        486,
        "Mesh order: P2 on " + _code_span("tet4") + " &amp; " + _code_span("pure_prism_p2") + "; P1 on " + _code_span("mixed_p1") + " &amp; periodic meshes.",
        cls="fm-note",
        raw_markup=True,
    )
    c.text(
        20,
        506,
        "Energy: " + math_span("E" + sub("d") + " = −(μ" + sub("0") + "/2)∫" + sub("Ωm") + " " + vec("M") + "·" + vec("H", sub_text="d") + " " + roman("d") + "V") + " (airbox LLG nodes zeroed).",
        cls="fm-note",
        raw_markup=True,
    )

    # ---- Panel b: Analytical sphere potential u(r) & truncation error ----
    sub_b = "Uniformly magnetized sphere of radius " + math_span("a") + " in airbox " + math_span("R" + sub("box") + " = 2.4 a")
    panel_label(
        c,
        492,
        24,
        "b",
        "Analytical sphere potential u(r) & truncation error",
        subtitle=sub_b,
        subtitle_markup=True,
    )

    r_box = 2.4
    pf = axes_2d(
        c,
        548,
        70,
        406,
        310,
        xlim=(0.0, 3.0),
        ylim=(0.0, 0.42),
        xticks=(0.0, 0.5, 1.0, 1.5, 2.0, 2.4, 3.0),
        xtick_labels=("0.0", "0.5", "1.0", "1.5", "2.0", "2.4 (Γ" + sub("a") + ")", "3.0"),
        yticks=(0.0, 0.1, 0.2, 0.3, 0.4),
        ytick_labels=("0.0", "0.1", "0.2", "0.3", "0.4"),
        grid=True,
        xlabel=roman("Normalized radial coordinate ") + "r / a " + roman("(along ") + vec("M") + roman(" axis)"),
        ylabel=roman("Potential ") + "u(r) / (M" + sub("s") + " a)",
        xlabel_offset=31.0,
        ylabel_offset=38.0,
    )

    with c.layer(clip_path=pf.clip_id):
        c.rect(pf.px(0.0), pf.y0, pf.px(1.0) - pf.px(0.0), pf.height, fill="fm_fill", fill_opacity=0.35)
        c.rect(pf.px(1.0), pf.y0, pf.px(r_box) - pf.px(1.0), pf.height, fill="air_fill", fill_opacity=0.45)

    pf.vline(1.0, color="fm_stroke", width=1.2, dash="4,3")
    pf.vline(r_box, color="H", width=1.5, dash="5,3")

    c.math_text(pf.px(0.5), pf.y0 + 16, roman("Sphere Ω") + sub("m"), fill="fm_stroke", size=10.6, bold=True, anchor="middle", halo=True)
    c.math_text(pf.px(1.7), pf.y0 + 16, roman("Airbox Ω") + sub("a") + " \\ Ω" + sub("m"), fill="H", size=10.6, bold=True, anchor="middle", halo=True)
    c.math_text(pf.px(2.72), pf.y0 + 16, roman("Ext."), fill="ink_muted", size=10.2, anchor="middle", halo=True)

    rs_full = [3.0 * k / 180.0 for k in range(181)]
    rs_box = [r_box * k / 150.0 for k in range(151)]

    u_open = [_sphere_potential(r, r_box, None) for r in rs_full]
    u_rob2 = [_sphere_potential(r, r_box, 2.0) for r in rs_box]
    u_rob1 = [_sphere_potential(r, r_box, 1.0) for r in rs_box]
    u_dir = [_sphere_potential(r, r_box, float("inf")) for r in rs_box]

    pf.plot_curve(rs_full, u_open, color="ink", width=2.4)
    pf.plot_curve(rs_box, u_rob2, color="flux", width=2.2, dash="7,4.5")
    pf.plot_curve(rs_box, u_rob1, color="accent_warm", width=2.1)
    pf.plot_curve(rs_box, u_dir, color="m", width=2.1)

    pf.scatter([r_box], [_sphere_potential(r_box, r_box, None)], r=3.8, fill="ink")
    pf.scatter([r_box], [_sphere_potential(r_box, r_box, 1.0)], r=3.8, fill="accent_warm")
    pf.scatter([r_box], [0.0], r=3.8, fill="m")

    legend_strip(
        c,
        694,
        118,
        [
            ("Exact open: " + math_span("u ∝ 1/r" + sup("2")), "ink", "solid"),
            ("Robin c=2 (" + math_span("β=2/R" + sub("★")) + "): exact", "flux", "dashed"),
            ("Robin c=1: " + math_span("+½(a/R)" + sup("3")), "accent_warm", "solid"),
            ("Dirichlet (" + math_span("u=0") + "): " + math_span("−(a/R)" + sup("3")), "m", "solid"),
        ],
        horizontal=False,
        line_len=15.0,
        row_gap=18.5,
    )

    c.text(
        498,
        444,
        "• Internal " + math_span("|" + vec("H", sub_text="d") + "|") + " error at " + math_span("R" + sub("box") + " = 2.4a") + ": Dirichlet −7.2% vs Robin c=1 (+3.6%), c=2 " + math_span("O((a/R)" + sup("5") + ")") + ".",
        cls="fm-note",
        raw_markup=True,
    )
    c.text(
        498,
        465,
        "• Weak energy identity already includes " + math_span("β∫" + sub("Γa") + " u" + sup("2") + " " + roman("d") + "S") + "; never double-count surface energy.",
        cls="fm-note",
        raw_markup=True,
    )
    c.text(
        498,
        486,
        "• Low Krylov " + _code_span("rtol") + " checks algebraic error only — converge " + math_span("R" + sub("box")) + ", " + math_span("h" + sub("air")) + ", and " + math_span("h" + sub("body")) + " independently.",
        cls="fm-note",
        raw_markup=True,
    )


# ---------------------------------------------------------------------------
# 6. demag-fem-bem-fredkin-koehler-pipeline
# ---------------------------------------------------------------------------


def _draw_demag_fem_bem_pipeline(c: SvgCanvas, t: Theme) -> None:
    panel_divider(c, 16, 260, 964, 260)

    # ---- Panel a: 3-stage physical Fredkin-Koehler splitting ----
    title_a = "Three-stage body-only Fredkin–Koehler splitting (" + math_span("u = u" + sub("1") + " + u" + sub("2")) + ", no airbox)"
    panel_label(c, 16, 24, "a", title_a, title_markup=True)

    def _body_polygon(cx: float, cy: float, r: float = 46.0) -> list[tuple[float, float]]:
        angles = (-85, -35, 18, 68, 122, 168, 215)
        radii = (1.0, 0.94, 1.02, 0.92, 0.98, 0.95, 0.96)
        return [
            (cx + r * rf * math.cos(math.radians(a)), cy + r * rf * math.sin(math.radians(a)))
            for a, rf in zip(angles, radii)
        ]

    # Stage 1: Interior Neumann Poisson u_1 on Ω_m only
    s1x, s1y = 148.0, 128.0
    c.text(s1x, 56, "1. Interior Neumann solve (" + math_span("u" + sub("1")) + ")", cls="fm-label-bold", fill="H", anchor="middle", raw_markup=True)
    p1 = _body_polygon(s1x, s1y, 42.0)
    c.polygon(p1, fill="fm_fill", stroke="H", stroke_width=1.8)
    for pt in p1:
        dx, dy = pt[0] - s1x, pt[1] - s1y
        norm = math.hypot(dx, dy) or 1.0
        c.line(s1x + 13.0 * dx / norm, s1y + 13.0 * dy / norm, pt[0], pt[1], stroke="fm_stroke", stroke_width=0.75, opacity=0.65)
    vector_arrow(c, s1x - 20, s1y - 16, s1x + 18, s1y - 18, color="m", width=1.8, size="sm")
    vector_arrow(c, s1x - 18, s1y + 18, s1x + 20, s1y + 16, color="m", width=1.8, size="sm")
    c.math_text(s1x, s1y + 4, "Ω" + sub("m"), fill="m", size=11.4, bold=True, italic=False, anchor="middle")

    gx, gy = p1[3]
    c.circle(gx, gy, 4.4, fill="accent_warm", stroke="surface_ref", stroke_width=1.2)
    c.math_text(gx + 8, gy + 12, roman("pin: ") + "b" + sub("1,0") + " = 0", fill="accent_warm", size=10.2, anchor="start")

    c.math_text(s1x, 198, "Δu" + sub("1") + " = ∇·" + vec("M") + "  " + roman("in Ω") + sub("m"), fill="ink", size=11.6, anchor="middle")
    c.math_text(s1x, 219, "∂" + sub("n") + "u" + sub("1") + " = " + vec("M") + "·" + vec("n") + "  " + roman("on Γ") + sub("m") + "  " + roman("(SPD K") + sub("neumann") + roman(")"), fill="ink_secondary", size=10.6, anchor="middle")
    c.text(s1x, 240, "1 gauge pin / connected component", cls="fm-note", anchor="middle")

    # Arrow 1 -> 2
    vector_arrow(c, 224, s1y, 316, s1y, color="accent_violet", width=2.0, size="md")
    c.math_text(270, s1y - 10, "γu" + sub("1"), fill="accent_violet", size=12.0, bold=True, anchor="middle")
    c.math_text(270, s1y + 15, roman("trace on Γ") + sub("m"), fill="ink_muted", size=10.0, anchor="middle")

    # Stage 2: Surface double-layer BEM operator B on Γ_m (Near CSR + Far ACA)
    s2x, s2y = 490.0, 128.0
    c.text(s2x, 56, "2. Surface double-layer BEM (" + math_span("ℬ") + ")", cls="fm-label-bold", fill="accent_violet", anchor="middle", raw_markup=True)

    bcx = 418.0
    p2 = _body_polygon(bcx, s2y, 40.0)
    c.polygon(p2, fill="none", stroke="accent_violet", stroke_width=2.4)
    for pt in p2:
        c.circle(pt[0], pt[1], 2.8, fill="accent_violet")
    c.math_text(bcx, s2y + 4, "Γ" + sub("m") + " = ∂Ω" + sub("m"), fill="accent_violet", size=10.6, bold=True, italic=False, anchor="middle")
    vector_arrow(c, p2[1][0], p2[1][1], p2[1][0] + 18, p2[1][1] - 12, color="H", width=1.5, size="sm")

    mx, my, msz = 504.0, 86.0, 82.0
    c.rect(mx, my, msz, msz, fill="H_soft", stroke="node_stroke", stroke_width=1.0, fill_opacity=0.65)
    half = msz * 0.5
    qtr = msz * 0.25
    for k in range(4):
        c.rect(mx + k * qtr, my + k * qtr, qtr, qtr, fill="accent_violet_soft", stroke="accent_violet", stroke_width=1.1)
    c.rect(mx + half, my, half, half, fill="H_soft", stroke="H", stroke_width=1.0, fill_opacity=0.8)
    c.rect(mx, my + half, half, half, fill="H_soft", stroke="H", stroke_width=1.0, fill_opacity=0.8)
    c.math_text(mx + half + qtr, my + qtr + 4, "UV" + sup("T"), fill="H", size=10.5, bold=True, anchor="middle")
    c.math_text(mx + qtr, my + half + qtr + 4, "UV" + sup("T"), fill="H", size=10.5, bold=True, anchor="middle")
    c.text(mx + msz * 0.5, my - 6, "Near CSR + Far ACA", cls="fm-note", fill="ink_secondary", anchor="middle")

    c.math_text(s2x, 198, "g" + sub("2") + " = ℬ γu" + sub("1") + "  " + roman("on Γ") + sub("m"), fill="accent_violet", size=11.8, bold=True, anchor="middle")
    c.text(s2x, 219, "Near: exact Lindholm CSR · Far: low-rank ACA", cls="fm-note", fill="ink_secondary", anchor="middle")
    c.text(s2x, 240, "No exterior volume mesh required", cls="fm-note", anchor="middle")

    # Arrow 2 -> 3
    vector_arrow(c, 620, s2y, 712, s2y, color="H", width=2.0, size="md")
    c.math_text(666, s2y - 10, "g" + sub("2"), fill="H", size=12.0, bold=True, anchor="middle")
    c.math_text(666, s2y + 15, roman("Dirichlet BC"), fill="ink_muted", size=10.0, anchor="middle")

    # Stage 3: Interior Dirichlet Laplace u_2 & field recovery
    s3x, s3y = 830.0, 128.0
    c.text(s3x, 56, "3. Laplace (" + math_span("u" + sub("2")) + ") &amp; field recovery", cls="fm-label-bold", fill="flux", anchor="middle", raw_markup=True)
    p3 = _body_polygon(s3x, s3y, 42.0)
    c.polygon(p3, fill="flux_soft", stroke="H", stroke_width=2.3, fill_opacity=0.65)
    for dy_eq in (-18.0, 0.0, 18.0):
        c.line(s3x - 24, s3y + dy_eq, s3x + 24, s3y + dy_eq, stroke="H", stroke_width=0.9, dash="3,2.5", opacity=0.65)
    vector_arrow(c, s3x + 19, s3y - 11, s3x - 17, s3y - 11, color="flux", width=2.0, size="sm")
    vector_arrow(c, s3x + 19, s3y + 5, s3x - 17, s3y + 5, color="flux", width=2.0, size="sm")
    c.math_text(s3x, s3y + 26, vec("H", sub_text="d"), fill="flux", size=11.4, bold=True, anchor="middle", halo=True)
    c.math_text(s3x, s3y - 56, "u" + sub("2") + "|" + sub("Γm") + " = g" + sub("2"), fill="H", size=10.2, anchor="middle")

    c.math_text(s3x, 198, "Δu" + sub("2") + " = 0 " + roman("in Ω") + sub("m") + ",   " + vec("H", sub_text="d") + " = −∇(u" + sub("1") + " + u" + sub("2") + ")", fill="ink", size=11.4, anchor="middle")
    c.math_text(s3x, 219, "E" + sub("d") + " = −(μ" + sub("0") + "/2) ∫" + sub("Ωm") + " " + vec("M") + "·" + vec("H", sub_text="d") + " " + roman("d") + "V", fill="flux", size=11.2, anchor="middle")
    c.text(s3x, 240, "SPD " + math_span("K" + sub("dirichlet")) + " via " + _code_span("DIAG_ONE") + " elimination", cls="fm-note", anchor="middle", raw_markup=True)

    # ---- Panel b: 3 balanced sub-views ----
    panel_label(
        c,
        16,
        284,
        "b",
        "Analytical sphere splitting, solid-angle diagonal, and CPU/GPU CUDA realization",
    )
    panel_divider(c, 338, 304, 338, 522)
    panel_divider(c, 668, 304, 668, 522)

    # Sub-view 1: Exact uniform-sphere splitting u = u_1 + u_2
    c.text(22, 314, "Uniform sphere (" + math_span(vec("M") + " = M" + sub("s") + hat("z")) + ")", cls="fm-label-bold", raw_markup=True)
    pf_s = axes_2d(
        c,
        62,
        328,
        162,
        150,
        xlim=(-1.0, 1.0),
        ylim=(-1.15, 1.15),
        xticks=(-1.0, 0.0, 1.0),
        xtick_labels=("−1", "0", "+1"),
        yticks=(-1.0, 0.0, 1.0),
        ytick_labels=("−1", "0", "+1"),
        zero_lines=True,
        xlabel="z / a  " + roman("(in Ω") + sub("m") + roman(")"),
        ylabel="u / (M" + sub("s") + " a)",
        xlabel_offset=27.0,
        ylabel_offset=34.0,
    )
    pf_s.plot_curve((-1.0, 1.0), (-1.0, 1.0), color="H", width=2.2)
    pf_s.plot_curve((-1.0, 1.0), (2.0 / 3.0, -2.0 / 3.0), color="accent_violet", width=2.2)
    pf_s.plot_curve((-1.0, 1.0), (-1.0 / 3.0, 1.0 / 3.0), color="flux", width=2.7)

    kx = 236.0
    legend_strip(
        c,
        kx,
        348,
        [
            (math_span("u" + sub("1") + " = z"), "H", "solid"),
            (math_span("u" + sub("2") + " = −⅔ z"), "accent_violet", "solid"),
            (math_span("u = ⅓ z"), "flux", "solid"),
        ],
        horizontal=False,
        line_len=14.0,
        row_gap=22.0,
    )
    c.math_text(kx, 424, vec("H", sub_text="d") + " = −∇u", fill="ink_secondary", size=11.0)
    c.math_text(kx, 444, "= −⅓ M" + sub("s") + " " + hat("z"), fill="flux", size=11.4, bold=True)
    c.text(kx, 464, "(N = 1/3 exact)", cls="fm-note")

    # Sub-view 2: Solid angle ω_T(x_i) & diagonal B_ii
    c.text(
        358,
        314,
        "Solid angle " + math_span("ω" + sub("T") + "(x" + sub("i") + ")") + " &amp; diagonal " + math_span("ℬ" + sub("ii")),
        cls="fm-label-bold",
        raw_markup=True,
    )

    vx, vy = 426.0, 396.0
    p_left = (368.0, 426.0)
    p_bot = (420.0, 456.0)
    p_right = (486.0, 428.0)
    p_top1 = (402.0, 358.0)
    p_top2 = (460.0, 360.0)

    c.polygon([(vx, vy), p_left, p_bot, p_right], fill="fm_fill", stroke="fm_stroke", stroke_width=1.2)
    c.polygon([(vx, vy), p_left, p_top1], fill="accent_violet_soft", stroke="accent_violet", stroke_width=1.35, fill_opacity=0.8)
    c.polygon([(vx, vy), p_right, p_top2], fill="H_soft", stroke="H", stroke_width=1.35, fill_opacity=0.8)
    c.line(vx, vy, p_bot[0], p_bot[1], stroke="fm_stroke", stroke_width=1.0, dash="3,2.5")

    arc_arrow(c, vx, vy, 18.0, 35.0, 145.0, color="m", width=1.4, size="sm")
    c.math_text(vx, vy + 38, "Σω" + sub("T"), fill="m", size=10.6, bold=True, anchor="middle", halo=True)

    vector_arrow(c, 456, 396, 476, 364, color="H", width=1.7, size="sm", label=vec("n", sub_text="T"), label_pos=(482, 366), label_anchor="start")

    c.circle(vx, vy, 4.6, fill="m", stroke="surface_ref", stroke_width=1.3)
    c.math_text(vx, vy - 14, vec("x", sub_text="i"), fill="m", size=11.4, bold=True, anchor="middle", halo=True)
    c.math_text(424, 478, roman("Closed surface Γ") + sub("m"), fill="ink_muted", size=10.2, anchor="middle")

    fx2 = 504.0
    c.math_text(fx2, 352, "ℬ" + sub("ii") + " = Σ" + sub("T∋xᵢ") + " ω" + sub("T") + "/(4π) − 1", fill="accent_violet", size=11.6, bold=True)
    c.text(fx2, 380, "• Smooth face: " + math_span("ℬ" + sub("ii") + " = −0.50"), cls="fm-sub", raw_markup=True)
    c.text(fx2, 400, "• 90° corner: " + math_span("ℬ" + sub("ii") + " = −0.875"), cls="fm-sub", raw_markup=True)
    c.text(fx2, 426, "Off-diagonal (i ≠ j):", cls="fm-label-bold", size=10.8)
    c.text(fx2, 444, "Lindholm linear-triangle", cls="fm-note")
    c.text(fx2, 460, "weights + far-field ACA", cls="fm-note")
    c.text(fx2, 480, "Fails closed if " + math_span("Γ" + sub("m")) + " is open.", cls="fm-note", fill="m", raw_markup=True)

    # Sub-view 3: CPU & GPU CUDA realization
    c.text(686, 314, "FEM CPU & GPU CUDA realization", cls="fm-label-bold")

    c.circle(692, 344, 3.8, fill="flux")
    c.text(702, 348, "FEM CPU (implemented)", cls="fm-label-bold", fill="flux", size=11.0)
    c.text(702, 366, math_span("H" + sup("2")) + " BEM (near Lindholm + far ACA) +", cls="fm-note", raw_markup=True)
    c.text(702, 382, "MFEM/Hypre CG/AMG solves; dense oracle.", cls="fm-note")

    c.circle(692, 410, 3.8, fill="H")
    c.text(702, 414, "FEM GPU CUDA (implemented)", cls="fm-label-bold", fill="H", size=11.0)
    c.text(702, 432, "Device near-CSR + far-ACA " + math_span("U(V" + sup("T") + "x)") + " apply.", cls="fm-note", raw_markup=True)
    c.text(
        702,
        449,
        "Atomic " + math_span("(u" + sub("1") + ", u" + sub("2") + ")") + " " + _code_span("cuDSS") + " Cholesky (" + _code_span("auto") + ")",
        cls="fm-note",
        raw_markup=True,
    )
    c.text(
        702,
        466,
        "or device " + _code_span("CG/AMG") + " (" + _code_span("coarse_relax_type=18") + ").",
        cls="fm-note",
        raw_markup=True,
    )

    c.circle(692, 492, 3.8, fill="accent_warm")
    c.text(702, 496, "Scope & fail-closed boundaries", cls="fm-label-bold", fill="accent_warm", size=10.8)
    c.text(
        702,
        513,
        "Closed " + _code_span("tet4") + " P1 only; rejects airbox, P2/prisms, " + _code_span("fmm") + ".",
        cls="fm-note",
        raw_markup=True,
    )


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def generate_all(out_dir: Path | str = DEFAULT_DIAGRAMS_DIR) -> list[tuple[Path, Path]]:
    """Generate all 6 exchange, coupling, and demagnetization SVG pairs (12 files)."""
    specs = [
        (
            "exchange-fdm-stencil-vs-fem-weak",
            _draw_exchange_fdm_vs_fem,
            980,
            390,
            "Bulk Micromagnetic Exchange: Continuum Model, FDM Stencil, and FEM Weak Form",
            "Three-panel comparison of bulk micromagnetic exchange in FullMag: (a) continuum variational energy and natural homogeneous Neumann boundary condition A d_n m = 0, (b) finite-difference 6-neighbor stencil with inactive-cell clamping and FP64 T0/T1 sub-cell corrections, and (c) conforming P1 H1 finite-element weak form with lumped and consistent mass projections.",
        ),
        (
            "inter-region-couplings-exchange-rkky",
            _draw_inter_region_couplings,
            980,
            476,
            "Inter-Region Couplings: Cell-Link Region Exchange vs Surface RKKY",
            "Two-panel comparison of FullMag inter-region couplings: (a) cell-to-cell harmonic, scaled-harmonic, explicit, and disabled exchange A_ab across adjacent ObjectRegion faces (executable on single-layer FDM), and (b) bilayer FM1/spacer/FM2 interfacial geometry with real oscillating RKKY coupling J_RKKY(t) proportional to cos(2 k_F t + phi_0)/t^2 showing FM (J_1 > 0) and AFM (J_1 < 0) thickness zones and bilinear/biquadratic surface energy (authored_only ProblemIR).",
        ),
        (
            "demag-solver-families-comparison",
            _draw_demag_solver_families,
            980,
            612,
            "Magnetostatic Sources and FullMag Demagnetization Solver Families",
            "Continuum magnetostatic volume and surface charges (rho_m = -div M, sigma_m = M . n) and FullMag's four discrete demagnetization operator families across FDM CPU/GPU and FEM CPU/GPU: (a) FDM 2N zero-padded Hermitian FFT convolution, (b) FEM Poisson with graded shared airbox (tet4 P2, pure_prism_p2, GPU cuDSS or CG/AMG), (c) body-only FEM-BEM Fredkin-Koehler (CPU H2 and GPU CUDA near-CSR/far-ACA with atomic cuDSS or CG/AMG), and (d) periodic FDM truncated images versus FEM reduced periodic_airbox_k0.",
        ),
        (
            "demag-fdm-newell-and-multilayer",
            _draw_demag_fdm_newell_multilayer,
            980,
            618,
            "FDM Newell Cell-Averaged Convolution, Hermitian cuFFT, Multilayer Stacking, and Periodic Images",
            "Two-panel diagram of FDM demagnetization: (a) Newell 27-point cell-averaged tensor, 2N zero-padded real-space buffer layout, and exact Hermitian half-spectrum D2Z/Z2D (FP64) and R2C/C2R (FP32) cuFFT contraction; (b) Lepadatu (2019) vacuum-skipping multilayer z-stack convolution with volume-adjoint transfers (P, P*) contrasted with 2D periodic image tiling and exact Newell uniform-mode convergence N_zz(I) -> 1 and N_xx(I) -> 0.",
        ),
        (
            "demag-fem-poisson-airbox-closures",
            _draw_demag_fem_poisson_closures,
            980,
            528,
            "FEM Poisson Graded Airbox Mesh and Boundary Closures",
            "Two-panel figure of FEM Poisson airbox demagnetization: (a) conforming geometrically graded shared-domain mesh Omega_m subset Omega_a with stray field lines H_d = -grad u and side-by-side comparison of open Robin, open Dirichlet, and 2D-periodic film (Neumann + gauge pin) closures across tet4 P2, pure_prism_p2, GPU cuDSS, and CG/AMG; (b) analytical uniformly magnetized sphere potential u(r)/(M_s a) comparing exact open 1/r^2 decay against Dirichlet u=0 and first-order Robin closures at R_box = 2.4 a.",
        ),
        (
            "demag-fem-bem-fredkin-koehler-pipeline",
            _draw_demag_fem_bem_pipeline,
            980,
            536,
            "FEM-BEM Fredkin-Koehler Body-Only Pipeline",
            "Two-panel schematic of FullMag's Fredkin-Koehler FEM-BEM demagnetization on a closed body-only tet4 P1 mesh Omega_m without an airbox: (a) three-stage physical splitting u = u_1 + u_2 from interior gauge-pinned Neumann Poisson u_1 through the surface double-layer BEM operator B (near CSR Lindholm + far ACA UV^T) on Gamma_m to interior Dirichlet Laplace u_2 and field recovery H_d = -grad(u_1 + u_2); (b) analytical sphere splitting u = u_1 + u_2, solid-angle diagonal B_ii geometry, and strict FEM CPU/GPU CUDA realization (atomic cuDSS or CG/AMG).",
        ),
    ]
    return [
        write_themed_svg(
            slug,
            draw_fn,
            width=w,
            height=h,
            title=title,
            desc=desc,
            out_dir=out_dir,
        )
        for slug, draw_fn, w, h, title, desc in specs
    ]
