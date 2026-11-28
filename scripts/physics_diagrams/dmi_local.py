"""Publication-grade dual-theme (Light & Dark) SVG generators for local interactions & multiphysics.

Owns 9 diagrams (18 SVGs: ``<slug>.svg`` + ``<slug>-dark.svg``):
1. ``anisotropy-uniaxial-and-cubic-landscapes``
2. ``dmi-three-variants-chirality``
3. ``dmi-boundary-canting-and-normals``
4. ``zeeman-energy-and-precession``
5. ``oersted-cylinder-and-biot-savart``
6. ``thermal-brown-stochastic-llg``
7. ``magnetoelastic-voigt-strain-coupling``
8. ``magnetoelastic-boundary-conditions-and-meshing``
9. ``magnetoelastic-magnon-phonon-dispersion-and-solvers``
"""

from __future__ import annotations

import math
from pathlib import Path
import random
from typing import Sequence

from .primitives import (
    DEFAULT_DIAGRAMS_DIR,
    SvgCanvas,
    arc_arrow,
    axes_2d,
    bracket_dim,
    curve_path,
    curved_arrow,
    dashed_region,
    esc,
    flow_node,
    format_math,
    layer_slab,
    legend_strip,
    math_span,
    out_of_plane_symbol,
    panel_divider,
    panel_label,
    polar_axes,
    polar_curve,
    rk4_integrate,
    sphere_curve,
    sphere_vector,
    spin_arrow,
    unit_sphere,
    vector_arrow,
    write_themed_svg,
)
from .theme import FONT_MONO, Theme


# ---------------------------------------------------------------------------
# Shared math & color helpers (pure stdlib)
# ---------------------------------------------------------------------------


def _hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
    h = hex_color.strip().lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def _rgb_to_hex(r: float, g: float, b: float) -> str:
    ri = max(0, min(255, int(round(r))))
    gi = max(0, min(255, int(round(g))))
    bi = max(0, min(255, int(round(b))))
    return f"#{ri:02x}{gi:02x}{bi:02x}"


def _lerp_color(c1: str, c2: str, u: float) -> str:
    u = max(0.0, min(1.0, float(u)))
    r1, g1, b1 = _hex_to_rgb(c1)
    r2, g2, b2 = _hex_to_rgb(c2)
    return _rgb_to_hex(r1 + (r2 - r1) * u, g1 + (g2 - g1) * u, b1 + (b2 - b1) * u)


def _mz_color(t: Theme, mz: float) -> str:
    """Diverging semantic color for out-of-plane m_z in [-1, 1]: m (-1) -> ink_muted (0) -> H (+1)."""
    mz = max(-1.0, min(1.0, float(mz)))
    if mz >= 0.0:
        return _lerp_color(t.ink_muted, t.H, mz)
    return _lerp_color(t.ink_muted, t.m, -mz)


def _cross(a: Sequence[float], b: Sequence[float]) -> tuple[float, float, float]:
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def _solve_rohart_thiaville_1d(
    d_val: float,
    *,
    a_ex: float = 15.0e-12,
    k_eff: float = 0.30e6,
    length: float = 80.0e-9,
    n_pts: int = 201,
) -> tuple[list[float], list[float]]:
    """Solve 2 A theta''(x) = K_eff sin(2 theta), theta'(+/- L/2) = -D / (2 A) via damped Newton/SOR.

    Returns ``(xs_nm, thetas_rad)`` on ``[-L/2, +L/2]``.
    """
    xs = [-0.5 * length + length * i / (n_pts - 1) for i in range(n_pts)]
    dx = length / (n_pts - 1)
    slope = -d_val / (2.0 * a_ex)
    delta = math.sqrt(a_ex / k_eff)

    theta = [
        slope * delta * (math.sinh(x / delta) / math.cosh(0.5 * length / delta))
        for x in xs
    ]
    if abs(d_val) < 1e-18:
        return ([x * 1e9 for x in xs], [0.0] * n_pts)

    c_k = (k_eff * dx * dx) / (2.0 * a_ex)
    for _ in range(400):
        max_upd = 0.0
        for i in range(n_pts):
            if i == 0:
                lap = 2.0 * (theta[1] - theta[0] - dx * slope)
            elif i == n_pts - 1:
                lap = 2.0 * (theta[n_pts - 2] - theta[n_pts - 1] + dx * slope)
            else:
                lap = theta[i + 1] - 2.0 * theta[i] + theta[i - 1]
            res = lap - c_k * math.sin(2.0 * theta[i])
            jac = -2.0 - 2.0 * c_k * math.cos(2.0 * theta[i])
            upd = -res / jac
            theta[i] += 0.9 * upd
            if abs(upd) > max_upd:
                max_upd = abs(upd)
        if max_upd < 1e-12:
            break

    return ([x * 1e9 for x in xs], theta)


def _simulate_stochastic_llg_heun(
    *,
    xi: float = 3.0,
    alpha: float = 0.18,
    theta0_deg: float = 118.0,
    t_end: float = 16.0,
    dt: float = 0.04,
    n_trajectories: int = 240,
    seed: int = 42,
) -> tuple[list[float], list[float], list[list[float]], list[float]]:
    """Integrate dimensionless Stratonovich stochastic LLG with Heun midpoint scheme.

    Dimensionless units: ``gamma_0 H_ext = 1``, field along ``+z``.
    Fluctuation-dissipation relation gives ``sigma = sqrt(2 alpha / (xi dt))`` so
    equilibrium follows ``P(theta) proportional to sin(theta) exp(xi cos(theta))``
    with ``<m_z>_eq = coth(xi) - 1/xi``.
    """
    steps = int(round(t_end / dt))
    ts = [k * dt for k in range(steps + 1)]
    th0 = math.radians(theta0_deg)
    m0 = (math.sin(th0), 0.0, math.cos(th0))
    pref = 1.0 / (1.0 + alpha * alpha)

    def llg_rhs(m: tuple[float, float, float], h: tuple[float, float, float]) -> tuple[float, float, float]:
        mxh = _cross(m, h)
        mxmxh = _cross(m, mxh)
        return (
            -pref * (mxh[0] + alpha * mxmxh[0]),
            -pref * (mxh[1] + alpha * mxmxh[1]),
            -pref * (mxh[2] + alpha * mxmxh[2]),
        )

    def norm3(v: tuple[float, float, float]) -> tuple[float, float, float]:
        n = math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) or 1.0
        return (v[0] / n, v[1] / n, v[2] / n)

    m = m0
    det_mz = [m[2]]
    for _ in range(steps):
        h0 = (0.0, 0.0, 1.0)
        k1 = llg_rhs(m, h0)
        mp = norm3((m[0] + dt * k1[0], m[1] + dt * k1[1], m[2] + dt * k1[2]))
        k2 = llg_rhs(mp, h0)
        m = norm3((
            m[0] + 0.5 * dt * (k1[0] + k2[0]),
            m[1] + 0.5 * dt * (k1[1] + k2[1]),
            m[2] + 0.5 * dt * (k1[2] + k2[2]),
        ))
        det_mz.append(m[2])

    rng = random.Random(seed)
    sigma = math.sqrt(2.0 * alpha / (xi * dt))
    mean_mz = [0.0] * (steps + 1)
    sample_traces: list[list[float]] = []

    for traj_idx in range(n_trajectories):
        m = m0
        trace = [m[2]] if traj_idx < 4 else []
        mean_mz[0] += m[2]
        for k in range(1, steps + 1):
            hx = sigma * rng.gauss(0.0, 1.0)
            hy = sigma * rng.gauss(0.0, 1.0)
            hz = 1.0 + sigma * rng.gauss(0.0, 1.0)
            h_tot = (hx, hy, hz)
            k1 = llg_rhs(m, h_tot)
            mp = norm3((m[0] + dt * k1[0], m[1] + dt * k1[1], m[2] + dt * k1[2]))
            k2 = llg_rhs(mp, h_tot)
            m = norm3((
                m[0] + 0.5 * dt * (k1[0] + k2[0]),
                m[1] + 0.5 * dt * (k1[1] + k2[1]),
                m[2] + 0.5 * dt * (k1[2] + k2[2]),
            ))
            mean_mz[k] += m[2]
            if traj_idx < 4:
                trace.append(m[2])
        if traj_idx < 4:
            sample_traces.append(trace)

    mean_mz = [v / n_trajectories for v in mean_mz]
    return ts, det_mz, sample_traces, mean_mz


# ---------------------------------------------------------------------------
# 1. anisotropy-uniaxial-and-cubic-landscapes
# ---------------------------------------------------------------------------


def draw_anisotropy(c: SvgCanvas, t: Theme) -> None:
    """Two-panel publication figure for uniaxial and cubic magnetocrystalline anisotropy."""
    panel_divider(c, 480, 18, 480, 456)

    # ===== PANEL A: UNIAXIAL ANISOTROPY =====
    panel_label(
        c,
        20,
        28,
        "a",
        title="Uniaxial anisotropy",
        subtitle=math_span(format_math("w_u(θ) = −K_{u1} \\mathrm{cos}^2θ − K_{u2} \\mathrm{cos}^4θ,  q = \\mathbf{m}·\\hat{u}")),
        subtitle_markup=True,
    )

    pcx, pcy, pr = 126.0, 158.0, 66.0
    polar_axes(
        c,
        pcx,
        pcy,
        pr,
        rings=(0.5, 1.0),
        spokes_deg=(0.0, 45.0, 90.0, 135.0, 180.0, 225.0, 270.0, 315.0),
    )
    vector_arrow(c, pcx, pcy + pr + 8, pcx, pcy - pr - 16, color="axis", width=1.15, size="sm")
    c.math_text(pcx + 7, pcy - pr - 10, format_math("\\hat{u} (0°)"), fill="ink", size=10.8)
    c.text(pcx + pr + 7, pcy + 3.5, "90°", cls="fm-tick")

    n_ang = 240
    angles = [2.0 * math.pi * k / n_ang for k in range(n_ang)]
    r_base, r_span = 0.24, 0.74
    r_axis = [r_base + r_span * (math.cos(a) ** 2) for a in angles]
    r_plane = [r_base + r_span * (math.sin(a) ** 2) for a in angles]
    r_cone = [r_base + r_span * (math.cos(2.0 * a) ** 2) for a in angles]

    polar_curve(c, pcx, pcy, pr, angles, r_axis, r_scale=1.0, color="H", width=2.0, fill="H", fill_opacity=0.09)
    polar_curve(c, pcx, pcy, pr, angles, r_plane, r_scale=1.0, color="m", width=1.8, dash="5,3")
    polar_curve(c, pcx, pcy, pr, angles, r_cone, r_scale=1.0, color="flux", width=1.9)

    ang_c = math.radians(45.0)
    xc = pcx + r_base * pr * math.cos(ang_c)
    yc = pcy - r_base * pr * math.sin(ang_c)
    c.circle(xc, yc, 3.2, fill="flux", stroke="surface_ref", stroke_width=0.9)
    c.math_text(pcx + pr * 0.72, pcy - pr * 0.76, format_math("θ_c"), fill="flux", size=11.0, halo=True)

    lx = 224.0
    c.text(lx, 86, "Polar excess energy  " + math_span(format_math("w_u(θ) − w_{min}")), cls="fm-label-bold", size=11.2, raw_markup=True)
    legend_strip(
        c,
        lx,
        108,
        [
            ("Easy axis (" + math_span(format_math("K_{u1}>0, K_{u2}=0")) + ")", "H", "solid"),
            ("Easy plane (" + math_span(format_math("K_{u1}<0, K_{u2}=0")) + ")", "m", "dashed"),
            ("Easy cone (" + math_span(format_math("0<K_{u1}<−2K_{u2}")) + ")", "flux", "solid"),
        ],
        horizontal=False,
        row_gap=18.5,
    )
    c.math_text(
        lx,
        173,
        format_math("θ_c = \\mathrm{arccos}√(−K_{u1}/2K_{u2})"),
        fill="flux",
        size=10.8,
    )
    c.line(lx, 187, 462, 187, stroke="hairline", stroke_width=0.7, opacity=0.65)
    c.text(lx, 203, "Effective field (convention-invariant)", cls="fm-note")
    c.math_text(
        lx,
        222,
        format_math("\\mathbf{H}_u = (2K_{u1}q + 4K_{u2}q^3)/(μ_0M_s) \\hat{u}"),
        fill="H",
        size=11.2,
    )

    c.text(64, 267, "Scalar energy convention offset (" + math_span(format_math("K_{u1}>0, K_{u2}=0")) + ")", cls="fm-sub", size=11.0, raw_markup=True)
    pf_u = axes_2d(
        c,
        64,
        278,
        394,
        124,
        xlim=(0.0, 180.0),
        ylim=(-1.12, 1.15),
        xlabel=format_math("θ [\\mathrm{deg}]"),
        ylabel=format_math("w / K_{u1}"),
        xticks=(0.0, 45.0, 90.0, 135.0, 180.0),
        xtick_labels=("0°", "45°", "90°", "135°", "180°"),
        yticks=(-1.0, 0.0, 1.0),
        ytick_labels=("−1", "0", "+1"),
        grid=True,
        zero_lines=True,
        xlabel_offset=27.0,
        ylabel_offset=34.0,
    )
    thetas_deg = [180.0 * k / 180 for k in range(181)]
    w_fm = [-(math.cos(math.radians(th)) ** 2) for th in thetas_deg]
    w_alt = [math.sin(math.radians(th)) ** 2 for th in thetas_deg]
    pf_u.plot_curve(thetas_deg, w_fm, color="H", width=2.2)
    pf_u.plot_curve(thetas_deg, w_alt, color="accent_warm", width=2.0, dash="5,3")

    x90 = pf_u.px(90.0)
    vector_arrow(c, x90, pf_u.py(0.05), x90, pf_u.py(0.95), color="accent_warm", width=1.4, size="sm", double=True)
    c.math_text(x90 + 8, pf_u.py(0.50), format_math("Δw = +K_{u1}"), fill="accent_warm", size=11.0, halo=True)
    c.math_text(pf_u.px(22.0), pf_u.py(-0.36), format_math("−K_{u1} \\mathrm{cos}^2θ"), fill="H", size=10.8, halo=True)
    c.math_text(pf_u.px(144.0), pf_u.py(0.84), format_math("+K_{u1} \\mathrm{sin}^2θ"), fill="accent_warm", size=10.8, anchor="middle", halo=True)

    c.text(
        64,
        452,
        "Exact transform: "
        + math_span(format_math("K_{u1} = K̃_{u1} + 2K̃_{u2},  K_{u2} = −K̃_{u2}"))
        + "  (identical "
        + math_span(format_math("\\mathbf{H}_u"))
        + ")",
        cls="fm-note",
        raw_markup=True,
    )

    # ===== PANEL B: CUBIC ANISOTROPY =====
    panel_label(
        c,
        500,
        28,
        "b",
        title="Cubic anisotropy",
        subtitle=math_span(format_math("w_c = K_{c1}Σ + K_{c2}α_1^2α_2^2α_3^2 + K_{c3}Σ^2,  Σ = α_1^2α_2^2+α_2^2α_3^2+α_3^2α_1^2")),
        subtitle_markup=True,
    )

    c0_x, c0_y, c0_r = 602.0, 158.0, 62.0
    polar_axes(
        c,
        c0_x,
        c0_y,
        c0_r,
        rings=(0.5, 1.0),
        spokes_deg=(0.0, 45.0, 90.0, 135.0, 180.0, 225.0, 270.0, 315.0),
        axis_labels=[(0.0, "[100]"), (90.0, "[010]"), (45.0, "[110]")],
        math_labels=False,
    )
    r0_pos = [0.28 + 0.70 * (math.sin(2.0 * a) ** 2) for a in angles]
    r0_neg = [0.28 + 0.70 * (math.cos(2.0 * a) ** 2) for a in angles]
    polar_curve(c, c0_x, c0_y, c0_r, angles, r0_pos, r_scale=1.0, color="H", width=2.0, fill="H", fill_opacity=0.09)
    polar_curve(c, c0_x, c0_y, c0_r, angles, r0_neg, r_scale=1.0, color="m", width=1.8, dash="5,3")
    c.text(c0_x, c0_y + c0_r + 22, "(001) plane  " + math_span(format_math("w_c(φ)")), cls="fm-sub", size=10.8, anchor="middle", raw_markup=True)

    c1_x, c1_y, c1_r = 824.0, 158.0, 62.0
    ang_111_deg = math.degrees(math.acos(1.0 / math.sqrt(3.0)))
    polar_axes(
        c,
        c1_x,
        c1_y,
        c1_r,
        rings=(0.5, 1.0),
        spokes_deg=(0.0, 90.0 - ang_111_deg, 90.0, 90.0 + ang_111_deg, 180.0, 270.0 - ang_111_deg, 270.0, 270.0 + ang_111_deg),
        axis_labels=[(90.0, "[001]"), (90.0 - ang_111_deg, "[111]"), (0.0, "[110]")],
        math_labels=False,
    )
    sig_110 = [0.25 * (math.cos(a) ** 4) + (math.cos(a) ** 2) * (math.sin(a) ** 2) for a in angles]
    r1_pos = [0.24 + 0.74 * (3.0 * s) for s in sig_110]
    r1_neg = [0.24 + 0.74 * (1.0 - 3.0 * s) for s in sig_110]
    polar_curve(c, c1_x, c1_y, c1_r, angles, r1_pos, r_scale=1.0, color="H", width=2.0, fill="H", fill_opacity=0.09)
    polar_curve(c, c1_x, c1_y, c1_r, angles, r1_neg, r_scale=1.0, color="m", width=1.8, dash="5,3")
    c.text(c1_x, c1_y + c1_r + 22, "(11̄0) plane  " + math_span(format_math("w_c(θ)")), cls="fm-sub", size=10.8, anchor="middle", raw_markup=True)

    c.text(548, 267, "(11̄0)-plane cross-section (" + math_span(format_math("K_{c2}=K_{c3}=0")) + ")", cls="fm-sub", size=11.0, raw_markup=True)
    pf_c = axes_2d(
        c,
        548,
        278,
        390,
        124,
        xlim=(0.0, 180.0),
        ylim=(-0.44, 0.44),
        xlabel="",
        ylabel=format_math("w_c / |K_{c1}|"),
        xticks=(0.0, ang_111_deg, 90.0, 180.0 - ang_111_deg, 180.0),
        xtick_labels=("[001]", "[111]", "[110]", "[111̄]", "[001̄]"),
        yticks=(-1.0 / 3.0, 0.0, 1.0 / 3.0),
        ytick_labels=("−⅓", "0", "+⅓"),
        grid=True,
        zero_lines=True,
        ylabel_offset=34.0,
    )
    wc_pos = [
        0.25 * (math.sin(math.radians(th)) ** 4)
        + (math.sin(math.radians(th)) ** 2) * (math.cos(math.radians(th)) ** 2)
        for th in thetas_deg
    ]
    wc_neg = [-v for v in wc_pos]
    pf_c.plot_curve(thetas_deg, wc_pos, color="H", width=2.2)
    pf_c.plot_curve(thetas_deg, wc_neg, color="m", width=2.2)
    pf_c.scatter([0.0, ang_111_deg, 90.0], [0.0, 1.0 / 3.0, 0.25], r=3.0, fill="H")
    pf_c.scatter([ang_111_deg, 90.0, 180.0 - ang_111_deg], [-1.0 / 3.0, -0.25, -1.0 / 3.0], r=3.0, fill="m")

    # Placed cleanly in the upper-right and lower-right clear wedges
    c.math_text(pf_c.px(178.0), pf_c.py(0.32), format_math("K_{c1}>0 (⟨100⟩)"), fill="H", size=10.4, anchor="end", halo=True)
    c.math_text(pf_c.px(178.0), pf_c.py(-0.34), format_math("K_{c1}<0 (⟨111⟩)"), fill="m", size=10.4, anchor="end", halo=True)
    c.text(
        548,
        452,
        "Crystal frame: "
        + math_span(format_math("\\hat{c}_3 = \\hat{c}_1 × \\hat{c}_2"))
        + "  (FEM validates strict orthonormality)",
        cls="fm-note",
        raw_markup=True,
    )


# ---------------------------------------------------------------------------
# 2. dmi-three-variants-chirality
# ---------------------------------------------------------------------------


def _draw_skyrmion_disk(
    c: SvgCanvas,
    t: Theme,
    cx: float,
    cy: float,
    radius: float,
    *,
    kind: str,
    grad_id: str,
) -> None:
    """Draw a clean mathematically computed 2D Néel or Bloch skyrmion (core m_z=-1, bg m_z=+1)."""
    c.add_def(
        f'<radialGradient id="{grad_id}" cx="50%" cy="50%" r="50%">'
        f'<stop offset="0%" stop-color="{t.m}" stop-opacity="0.34"/>'
        f'<stop offset="36%" stop-color="{t.m}" stop-opacity="0.16"/>'
        f'<stop offset="56%" stop-color="{t.surface_ref}" stop-opacity="0.04"/>'
        f'<stop offset="82%" stop-color="{t.H}" stop-opacity="0.16"/>'
        f'<stop offset="100%" stop-color="{t.H}" stop-opacity="0.28"/>'
        f"</radialGradient>"
    )
    c.circle(cx, cy, radius, fill=f"url(#{grad_id})", stroke="hairline", stroke_width=0.95)
    c.circle(cx, cy, radius * 0.56, fill="none", stroke="hairline", stroke_width=0.75, dash="3,3", opacity=0.75)

    out_of_plane_symbol(c, cx, cy, direction="in", r=6.2, color="m", width=1.4)

    helicity = 0.0 if kind == "neel" else 0.5 * math.pi
    ring_specs = (
        (0.32, 8, 12.0, t.m, 1.5),
        (0.58, 12, 16.0, t.accent_violet, 1.75),
    )
    for frac, count, alen, col, sw in ring_specs:
        rr = radius * frac
        for k in range(count):
            phi = 2.0 * math.pi * k / count
            px = cx + rr * math.cos(phi)
            py = cy - rr * math.sin(phi)
            ang_deg = math.degrees(phi + helicity)
            spin_arrow(c, px, py, ang_deg, length=alen, color=col, width=sw, size="sm")

    for k in range(8):
        phi = 2.0 * math.pi * k / 8.0 + math.pi / 8.0
        px = cx + radius * 0.85 * math.cos(phi)
        py = cy - radius * 0.85 * math.sin(phi)
        out_of_plane_symbol(c, px, py, direction="out", r=4.3, color="H", width=1.15)


def draw_dmi_variants(c: SvgCanvas, t: Theme) -> None:
    """Three-panel comparison of Interfacial, Bulk, and Rotated Interfacial DMI."""
    panel_divider(c, 320, 18, 320, 464)
    panel_divider(c, 640, 18, 640, 464)

    # ===== PANEL A: INTERFACIAL DMI =====
    panel_label(
        c,
        18,
        28,
        "a",
        title="Interfacial DMI",
        subtitle=math_span(format_math("C_{nv}")) + " symmetry · " + math_span(format_math("\\hat{n} = +\\hat{z}")),
        subtitle_markup=True,
    )

    layer_slab(c, 26, 62, 274, 34, kind="fm", label="FM", label_pos="left")
    layer_slab(c, 26, 96, 274, 24, kind="hm", label="HM (SOC)", label_pos="left")
    spin_arrow(c, 134, 79, 90.0, length=22.0, color="m", width=1.9, size="sm")
    spin_arrow(c, 206, 79, 122.0, length=22.0, color="m", width=1.9, size="sm")
    vector_arrow(c, 144, 87, 194, 87, color="axis", width=1.2, size="sm")
    c.math_text(169, 82, format_math("\\mathbf{r}_{ij}"), fill="ink_secondary", size=10.5, anchor="middle")
    vector_arrow(c, 274, 108, 274, 68, color="H", width=1.7, size="sm")
    c.math_text(283, 76, format_math("\\hat{n}"), fill="H", size=11.4)
    out_of_plane_symbol(c, 169, 108, direction="out", r=6.0, color="accent_violet", width=1.4)
    c.math_text(182, 112, format_math("\\mathbf{D}_{ij} ⊥ \\mathbf{r}_{ij}"), fill="accent_violet", size=10.6)

    c.text(26, 142, "1D Néel cycloid (" + math_span(format_math("x\\mathrm{–}z")) + " plane, " + math_span(format_math("D_i>0")) + ")", cls="fm-note", raw_markup=True)
    c.line(32, 168, 294, 168, stroke="hairline", stroke_width=0.8, dash="3,3")
    for k in range(9):
        cx_s = 42.0 + k * 30.5
        theta = -2.0 * math.pi * k / 8.0
        mx = math.sin(theta)
        mz = math.cos(theta)
        ang_deg = math.degrees(math.atan2(mz, mx))
        col = _mz_color(t, mz)
        spin_arrow(c, cx_s, 168.0, ang_deg, length=22.0, color=col, width=2.0, size="sm", center_dot=True)

    c.text(26, 204, "2D Néel skyrmion (radial walls)", cls="fm-note")
    _draw_skyrmion_disk(c, t, 148.0, 288.0, 68.0, kind="neel", grad_id="neel-sk-grad")
    out_of_plane_symbol(c, 234, 240, direction="out", r=4.3, color="H", width=1.15)
    c.math_text(244, 244, format_math("m_z=+1"), fill="H", size=10.4)
    out_of_plane_symbol(c, 234, 288, direction="in", r=4.3, color="m", width=1.15)
    c.math_text(244, 292, format_math("m_z=−1"), fill="m", size=10.4)
    c.text(230, 338, "radial walls", cls="fm-note", fill="accent_violet")

    c.math_text(22, 402, format_math("w_i = D_i[(\\mathbf{m}·\\hat{n})∇·\\mathbf{m} − \\mathbf{m}·∇(\\mathbf{m}·\\hat{n})]"), fill="ink", size=10.8)
    c.math_text(22, 424, format_math("\\mathbf{H}_i = (2D_i/μ_0M_s)[∇(\\mathbf{m}·\\hat{n}) − \\hat{n}(∇·\\mathbf{m})]"), fill="accent_violet", size=10.6)
    c.text(22, 450, "FDM: fixed +ẑ normal · FEM: arbitrary n̂", cls="fm-note")

    # ===== PANEL B: ISOTROPIC BULK DMI =====
    panel_label(
        c,
        338,
        28,
        "b",
        title="Isotropic bulk DMI",
        subtitle=math_span(format_math("T / O")) + " (B20) symmetry · 3D curl",
        subtitle_markup=True,
    )

    layer_slab(c, 346, 62, 274, 58, kind="fm", label="B20 bulk", label_pos="left")
    spin_arrow(c, 456, 86, 90.0, length=22.0, color="m", width=1.9, size="sm")
    spin_arrow(c, 536, 86, 62.0, length=18.0, color="m", width=1.9, size="sm")
    out_of_plane_symbol(c, 542, 74, direction="out", r=4.2, color="m", width=1.1)
    vector_arrow(c, 466, 95, 526, 95, color="axis", width=1.2, size="sm")
    vector_arrow(c, 466, 108, 526, 108, color="accent_violet", width=1.8, size="sm")
    c.math_text(534, 111, format_math("\\mathbf{D}_{ij} ∥ \\mathbf{r}_{ij}"), fill="accent_violet", size=10.6)

    c.text(346, 142, "1D Bloch helix (" + math_span(format_math("y\\mathrm{–}z")) + " plane, " + math_span(format_math("D_b>0")) + ")", cls="fm-note", raw_markup=True)
    c.line(352, 168, 614, 168, stroke="hairline", stroke_width=0.8, dash="3,3")
    for k in range(9):
        cx_s = 362.0 + k * 30.5
        phase = 2.0 * math.pi * k / 8.0
        my = -math.sin(phase)
        mz = math.cos(phase)
        col = _mz_color(t, mz)
        if abs(mz) < 0.2:
            out_of_plane_symbol(c, cx_s, 168.0, direction="out" if my > 0 else "in", r=6.8, color="accent_violet", width=1.5)
        else:
            dx_p = 6.5 * my
            dy_p = -11.5 * mz
            c.line(cx_s - 0.5 * dx_p, 168.0 - 0.5 * dy_p, cx_s + 0.5 * dx_p, 168.0 + 0.5 * dy_p, stroke=col, stroke_width=2.0, marker_end=c.marker_url(col, size="sm"))
            c.circle(cx_s, 168.0, 1.8, fill=col)

    c.text(346, 204, "2D Bloch skyrmion (tangential curl)", cls="fm-note")
    _draw_skyrmion_disk(c, t, 468.0, 288.0, 68.0, kind="bloch", grad_id="bloch-sk-grad")
    out_of_plane_symbol(c, 554, 240, direction="out", r=4.3, color="H", width=1.15)
    c.math_text(564, 244, format_math("m_z=+1"), fill="H", size=10.4)
    out_of_plane_symbol(c, 554, 288, direction="in", r=4.3, color="m", width=1.15)
    c.math_text(564, 292, format_math("m_z=−1"), fill="m", size=10.4)
    c.text(550, 338, "vortex curl", cls="fm-note", fill="accent_violet")

    c.math_text(344, 402, format_math("w_b = D_b \\mathbf{m}·(∇×\\mathbf{m})"), fill="ink", size=11.4)
    c.math_text(344, 424, format_math("\\mathbf{H}_b = −(2D_b/μ_0M_s) ∇×\\mathbf{m}"), fill="accent_violet", size=11.2)
    c.text(344, 450, "FDM: requires 3D PBC · FEM: open or PBC", cls="fm-note")

    # ===== PANEL C: ROTATED INTERFACIAL DMI (GÖBEL BIMERON) =====
    panel_label(
        c,
        658,
        28,
        "c",
        title="Rotated interfacial DMI",
        subtitle="In-plane bimeron (Göbel et al. 2019)",
    )

    flow_node(c, 666, 66, 108, 48, "Skyrmion", subtitle=math_span(format_math("+\\hat{z}")) + " background", accent="H", title_size=11.0, sub_size=10.0, sub_markup=True)
    curved_arrow(c, 778, 90, 804, 78, 826, 90, color="accent_violet", width=1.6, size="sm")
    c.math_text(802, 63, format_math("R_y(π/2)"), fill="accent_violet", size=10.0, anchor="middle")
    flow_node(c, 830, 66, 110, 48, "Bimeron", subtitle=math_span(format_math("+\\hat{x}")) + " background", accent="accent_violet", title_size=11.0, sub_size=10.0, sub_markup=True)

    c.text(666, 142, "Centerline cut (" + math_span(format_math("y=0")) + "): two opposite merons", cls="fm-note", raw_markup=True)
    c.line(672, 168, 934, 168, stroke="hairline", stroke_width=0.8, dash="3,3")
    for k in range(9):
        u = -2.6 + 5.2 * k / 8.0
        cx_s = 682.0 + k * 30.5
        denom = u * u + 1.0
        mx = (u * u - 1.0) / denom
        mz = -2.0 * u / denom
        ang_deg = math.degrees(math.atan2(mz, mx))
        col = _mz_color(t, mz)
        spin_arrow(c, cx_s, 168.0, ang_deg, length=21.0, color=col, width=2.0, size="sm", center_dot=True)

    c.text(666, 204, "2D Bimeron (in-plane arrows, color = " + math_span(format_math("m_z")) + ")", cls="fm-note", raw_markup=True)
    bx0, by0, bw, bh = 666.0, 216.0, 274.0, 138.0
    bcx, bcy = bx0 + 0.5 * bw, by0 + 0.5 * bh
    c.rect(bx0, by0, bw, bh, fill="surface_subtle", fill_opacity=0.45, stroke="hairline", stroke_width=0.9, rx=3.0)

    r_px = 46.0
    c.add_def(
        f'<radialGradient id="meron-plus" cx="50%" cy="50%" r="50%">'
        f'<stop offset="0%" stop-color="{t.H}" stop-opacity="0.42"/>'
        f'<stop offset="60%" stop-color="{t.H}" stop-opacity="0.14"/>'
        f'<stop offset="100%" stop-color="{t.H}" stop-opacity="0"/>'
        f"</radialGradient>"
    )
    c.add_def(
        f'<radialGradient id="meron-minus" cx="50%" cy="50%" r="50%">'
        f'<stop offset="0%" stop-color="{t.m}" stop-opacity="0.42"/>'
        f'<stop offset="60%" stop-color="{t.m}" stop-opacity="0.14"/>'
        f'<stop offset="100%" stop-color="{t.m}" stop-opacity="0"/>'
        f"</radialGradient>"
    )
    c.circle(bcx - r_px, bcy, 44.0, fill="url(#meron-plus)")
    c.circle(bcx + r_px, bcy, 44.0, fill="url(#meron-minus)")

    nx_g, ny_g = 9, 5
    for iy in range(ny_g):
        for ix in range(nx_g):
            gx = bx0 + 17.0 + ix * (bw - 34.0) / (nx_g - 1)
            gy = by0 + 18.0 + iy * (bh - 36.0) / (ny_g - 1)
            ux = (gx - bcx) / r_px
            uy = -(gy - bcy) / r_px
            r2 = ux * ux + uy * uy
            denom = r2 + 1.0
            mx = (r2 - 1.0) / denom
            my = 2.0 * uy / denom
            mz = -2.0 * ux / denom
            in_plane = math.hypot(mx, my)
            col = _mz_color(t, mz)
            if abs(mz) > 0.88:
                out_of_plane_symbol(c, gx, gy, direction="out" if mz > 0 else "in", r=5.4, color="H" if mz > 0 else "m", width=1.35)
            else:
                ang_deg = math.degrees(math.atan2(my, mx))
                alen = 9.0 + 9.0 * in_plane
                spin_arrow(c, gx, gy, ang_deg, length=alen, color=col, width=1.6, size="sm")

    # Clean meron core legend strictly BELOW the bimeron frame (zero arrow overlap)
    ly_bm = by0 + bh + 16.0
    out_of_plane_symbol(c, bcx - 74, ly_bm - 3.5, direction="out", r=4.2, color="H", width=1.15)
    c.math_text(bcx - 65, ly_bm, format_math("m_z=+1 (−R)"), fill="H", size=10.0)
    out_of_plane_symbol(c, bcx + 12, ly_bm - 3.5, direction="in", r=4.2, color="m", width=1.15)
    c.math_text(bcx + 21, ly_bm, format_math("m_z=−1 (+R)"), fill="m", size=10.0)
    c.math_text(bx0 + bw - 4, ly_bm, format_math("bg +\\hat{x}"), fill="ink_muted", size=10.0, anchor="end")

    c.math_text(662, 402, format_math("w_{rot} = D_{rot}(L_{zx}^x + L_{xy}^y)"), fill="ink", size=11.2)
    c.math_text(662, 424, format_math("\\mathbf{H}_{rot} = (2D_{rot}/μ_0M_s)(∂_xm_z−∂_ym_y, ∂_ym_x, −∂_xm_x)^T"), fill="accent_violet", size=9.6)
    c.text(662, 450, "Distinct non-aliasing term · requires A > 0", cls="fm-note")


# ---------------------------------------------------------------------------
# 3. dmi-boundary-canting-and-normals
# ---------------------------------------------------------------------------


def draw_dmi_boundary(c: SvgCanvas, t: Theme) -> None:
    """Two-panel figure: solved Rohart-Thiaville edge canting and FDM/FEM normal BCs."""
    panel_divider(c, 502, 18, 502, 448)

    # ===== PANEL A: SOLVED CHIRAL EDGE CANTING =====
    panel_label(
        c,
        20,
        28,
        "a",
        title="Chiral edge canting",
        subtitle="Solved 1D BVP (" + math_span(format_math("A=15 \\mathrm{pJ/m}, K_{eff}=0.3 \\mathrm{MJ/m}^3, L=80 \\mathrm{nm}")) + ")",
        subtitle_markup=True,
    )

    xs_nm, th_0 = _solve_rohart_thiaville_1d(0.0)
    _, th_12 = _solve_rohart_thiaville_1d(1.2e-3)
    _, th_22 = _solve_rohart_thiaville_1d(2.2e-3)
    mz_0 = [math.cos(v) for v in th_0]
    mz_12 = [math.cos(v) for v in th_12]
    mz_22 = [math.cos(v) for v in th_22]

    sx0, sw = 78.0, 380.0
    layer_slab(c, sx0, 76, sw, 45, kind="fm")
    layer_slab(c, sx0, 121, sw, 18, kind="hm")
    c.text(sx0 + 6, 132.5, "HM substrate", cls="fm-note", fill="hm_stroke", size=9.5)
    c.text(sx0 + sw - 6, 132.5, math_span(format_math("∂Ω_m")) + " open edges", cls="fm-note", fill="hm_stroke", size=9.5, anchor="end", raw_markup=True)

    n_spins = 11
    for k in range(n_spins):
        idx = int(round(k * (len(xs_nm) - 1) / (n_spins - 1)))
        px = sx0 + 16.0 + k * (sw - 32.0) / (n_spins - 1)
        th = th_22[idx]
        ang_deg = 90.0 - math.degrees(th)
        col = "accent_violet" if abs(th) > 0.14 else "H"
        spin_arrow(c, px, 98.5, ang_deg, length=26.0, color=col, width=2.0, size="sm")

    c.line(sx0 + 16.0, 98.5, sx0 + 16.0, 80.0, stroke="hairline", stroke_width=0.9, dash="2,2")
    c.math_text(sx0 + 30.0, 88.0, format_math("θ_c"), fill="accent_violet", size=10.8, halo=True)

    vector_arrow(c, sx0, 98.5, sx0 - 30.0, 98.5, color="ink", width=1.8, size="sm")
    c.math_text(sx0 - 18.0, 88.5, format_math("\\mathbf{ν}=−\\hat{x}"), fill="ink", size=10.2, anchor="middle")
    vector_arrow(c, sx0 + sw, 98.5, sx0 + sw + 30.0, 98.5, color="ink", width=1.8, size="sm")
    c.math_text(sx0 + sw + 16.0, 88.5, format_math("+\\hat{x}"), fill="ink", size=10.2, anchor="middle")
    vector_arrow(c, sx0 + 0.5 * sw + 28, 121.0, sx0 + 0.5 * sw + 28, 66.0, color="H", width=1.5, size="sm")
    c.math_text(sx0 + 0.5 * sw + 35, 68.0, format_math("\\hat{n} = +\\hat{z}"), fill="H", size=10.4, halo=True)

    delta_px = (7.07 / 80.0) * sw
    bracket_dim(
        c,
        sx0,
        146,
        sx0 + delta_px,
        146,
        label=None,
        offset=6.0,
        color="accent_violet",
    )
    c.math_text(
        sx0,
        166,
        format_math("Δ = √(A/K_{eff}) = 7.1 \\mathrm{nm}"),
        fill="accent_violet",
        size=10.4,
    )
    c.math_text(
        sx0 + sw,
        166,
        format_math("θ_c = 31.2°  \\mathrm{at}  D = 2.2 \\mathrm{mJ m}^{-2}"),
        fill="accent_violet",
        size=10.4,
        anchor="end",
    )

    pf = axes_2d(
        c,
        74,
        186,
        396,
        178,
        xlim=(-40.0, 40.0),
        ylim=(0.82, 1.02),
        xlabel=format_math("x [\\mathrm{nm}]"),
        ylabel=format_math("m_z(x)"),
        xticks=(-40.0, -20.0, 0.0, 20.0, 40.0),
        yticks=(0.85, 0.90, 0.95, 1.00),
        ytick_labels=("0.85", "0.90", "0.95", "1.00"),
        grid=True,
        xlabel_offset=28.0,
        ylabel_offset=38.0,
    )
    pf.fill_between([-40.0, -40.0 + 7.07], [1.02, 1.02], 0.82, fill="accent_violet_soft", opacity=0.45)
    pf.fill_between([40.0 - 7.07, 40.0], [1.02, 1.02], 0.82, fill="accent_violet_soft", opacity=0.45)

    pf.plot_curve(xs_nm, mz_0, color="axis", width=1.6, dash="5,3")
    pf.plot_curve(xs_nm, mz_12, color="H", width=2.1)
    pf.plot_curve(xs_nm, mz_22, color="accent_violet", width=2.3)
    pf.scatter([-40.0, 40.0], [mz_12[0], mz_12[-1]], r=3.1, fill="H")
    pf.scatter([-40.0, 40.0], [mz_22[0], mz_22[-1]], r=3.4, fill="accent_violet")

    legend_strip(
        c,
        182,
        294,
        [
            (math_span(format_math("D = 0")) + " (Neumann)", "axis", "dashed"),
            (math_span(format_math("D = 1.2 \\mathrm{mJ m}^{-2}")), "H", "solid"),
            (math_span(format_math("D = 2.2 \\mathrm{mJ m}^{-2}")), "accent_violet", "solid"),
        ],
        horizontal=False,
        row_gap=18.0,
    )

    c.math_text(
        268,
        428,
        format_math("2A ∂_ν\\mathbf{m} + D[(\\hat{n}×\\mathbf{ν})×\\mathbf{m}] = \\mathbf{0},   ℓ_{DMI} = 2A/|D|"),
        fill="accent_violet",
        size=11.4,
        anchor="middle",
    )

    # ===== PANEL B: FDM VS FEM NORMALS & ALL THREE NATURAL BCs =====
    panel_label(
        c,
        522,
        28,
        "b",
        title="Discrete normals & natural boundary laws",
        subtitle="FDM ghost stencil vs FEM weak residual",
    )

    c.text(524, 74, "FDM: fixed " + math_span(format_math("\\hat{n} = +\\hat{z}")) + " only", cls="fm-label-bold", fill="H", size=11.4, raw_markup=True)
    layer_slab(c, 524, 96, 54, 48, kind="fm")
    layer_slab(c, 580, 96, 54, 48, kind="fm", stroke_width=1.6)
    dashed_region(c, 636, 96, 54, 48, stroke="air_stroke", fill="air_fill", fill_opacity=0.55)
    c.math_text(551, 110, format_math("i−1"), fill="ink_secondary", size=10.2, anchor="middle")
    c.math_text(607, 110, format_math("i"), fill="ink", size=10.6, bold=True, anchor="middle")
    c.text(663, 110, "ghost", cls="fm-note", anchor="middle", size=9.6)
    spin_arrow(c, 551, 130, 90.0, length=20.0, color="m", width=1.8, size="sm")
    spin_arrow(c, 607, 130, 62.0, length=20.0, color="accent_violet", width=1.9, size="sm")
    spin_arrow(c, 663, 130, 40.0, length=18.0, color="air_stroke", width=1.4, size="sm", opacity=0.75)
    c.text(524, 165, "Ghost BC on open faces; tilted " + math_span(format_math("\\hat{n}")) + " rejected", cls="fm-note", raw_markup=True)

    # Shifted FEM tilted slab cleanly down so normal vector n_hat never touches the header
    c.text(740, 74, "FEM: general " + math_span(format_math("\\hat{n} = \\mathbf{n}/‖\\mathbf{n}‖")), cls="fm-label-bold", fill="flux", size=11.4, raw_markup=True)
    p_bl, p_tl = (754.0, 150.0), (745.0, 124.0)
    p_br, p_tr = (892.0, 114.0), (883.0, 88.0)
    c.polygon([p_tl, p_tr, p_br, p_bl], fill="fm_fill", stroke="fm_stroke", stroke_width=1.35)
    for frac in (0.25, 0.5, 0.75):
        tx = p_tl[0] + frac * (p_tr[0] - p_tl[0])
        ty = p_tl[1] + frac * (p_tr[1] - p_tl[1])
        bx = p_bl[0] + frac * (p_br[0] - p_bl[0])
        by = p_bl[1] + frac * (p_br[1] - p_bl[1])
        c.line(tx, ty, bx, by, stroke="fm_stroke", stroke_width=0.7, opacity=0.55)
        if frac < 0.75:
            bx2 = p_bl[0] + (frac + 0.25) * (p_br[0] - p_bl[0])
            by2 = p_bl[1] + (frac + 0.25) * (p_br[1] - p_bl[1])
            c.line(tx, ty, bx2, by2, stroke="fm_stroke", stroke_width=0.65, opacity=0.45)
    # Normal n_hat starting on top face, stopping well below y=74
    nx0, ny0 = 814.0, 106.0
    vector_arrow(c, nx0, ny0, nx0 - 8.5, ny0 - 24.0, color="H", width=1.85, size="sm")
    c.math_text(nx0 - 14.0, ny0 - 12.0, format_math("\\hat{n}"), fill="H", size=11.0, anchor="end")
    vector_arrow(c, 888.0, 101.0, 918.0, 93.0, color="ink", width=1.8, size="sm")
    c.math_text(924.0, 95.0, format_math("\\mathbf{ν}"), fill="ink", size=11.2)
    c.text(740, 165, "Weak residual carries natural BC natively", cls="fm-note")

    ty_hdr = 208.0
    c.line(524, ty_hdr - 14, 940, ty_hdr - 14, stroke="ink", stroke_width=1.1)
    c.text(526, ty_hdr, "DMI variant", cls="fm-label-bold", size=10.8)
    c.text(608, ty_hdr, "Natural boundary condition on " + math_span(format_math("∂Ω_m")), cls="fm-label-bold", size=10.8, raw_markup=True)
    c.line(524, ty_hdr + 8, 940, ty_hdr + 8, stroke="hairline", stroke_width=0.9)

    rows = [
        (
            "Interfacial",
            "accent_violet",
            format_math("2A ∂_ν\\mathbf{m} + D_i[(\\hat{n}×\\mathbf{ν})×\\mathbf{m}] = \\mathbf{0}"),
            "FDM: +ẑ ghost stencil  ·  FEM: general n̂ weak form",
        ),
        (
            "Bulk (B20)",
            "H",
            format_math("2A ∂_ν\\mathbf{m} + D_b(\\mathbf{m}×\\mathbf{ν}) = \\mathbf{0}"),
            "FDM: requires 3D PBC  ·  FEM: open or periodic weak form",
        ),
        (
            "Rotated",
            "flux",
            format_math("2A ∂_ν\\mathbf{m} + D_{rot}(ν_xm_z−ν_ym_y, ν_ym_x, −ν_xm_x)^T = \\mathbf{0}"),
            "FDM & FEM: lateral open edges (requires A > 0)",
        ),
    ]
    ry = ty_hdr + 34.0
    for name, accent, eq, note in rows:
        c.text(526, ry, name, cls="fm-label-bold", fill=accent, size=11.0)
        c.math_text(608, ry, eq, fill="ink", size=10.5)
        c.text(608, ry + 16.5, note, cls="fm-note", size=9.8)
        ry += 56.0
        if name != "Rotated":
            c.line(524, ry - 26, 940, ry - 26, stroke="grid", stroke_width=0.8)

    c.line(524, ry - 24, 940, ry - 24, stroke="ink", stroke_width=1.1)
    c.text(
        526,
        ry - 6,
        "FEM weak residual includes boundary trace automatically (no separate surface integral).",
        cls="fm-note",
        size=10.0,
    )


# ---------------------------------------------------------------------------
# 4. zeeman-energy-and-precession
# ---------------------------------------------------------------------------


def draw_zeeman(c: SvgCanvas, t: Theme) -> None:
    """Two-panel figure: Larmor precession + cosine energy well (a) and source boundaries (b)."""
    panel_divider(c, 624, 18, 624, 418)

    # ===== PANEL A: PRECESSION CONE & COSINE POTENTIAL =====
    panel_label(
        c,
        20,
        28,
        "a",
        title="Zeeman precession & potential well",
        subtitle=math_span(format_math("\\mathbf{H}_{ext} = \\mathbf{B}_{ext} / μ_0,   ω_L = γ_0 H_{ext}")),
        subtitle_markup=True,
    )

    scx, scy, sr = 152.0, 214.0, 94.0
    proj = unit_sphere(
        c,
        scx,
        scy,
        sr,
        azim_deg=34.0,
        elev_deg=22.0,
        meridians_deg=(0.0, 90.0),
        latitudes_deg=(0.0,),
        axes=True,
        axis_labels=("x", "y", ""),
    )

    hx_tip, hy_tip = sphere_vector(c, proj, (0.0, 0.0, 0.0), (0.0, 0.0, 1.32), color="H", width=2.4, size="md")
    c.math_text(hx_tip + 9, hy_tip + 4, format_math("\\mathbf{H}_{ext} = \\mathbf{B}_{ext} / μ_0"), fill="H", size=11.2, halo=True)

    alpha = 0.14
    pref = 1.0 / (1.0 + alpha * alpha)
    h_vec = (0.0, 0.0, 1.0)

    def llg_rhs(_t: float, m: tuple[float, ...]) -> tuple[float, float, float]:
        mxh = _cross(m, h_vec)
        mxmxh = _cross(m, mxh)
        return (
            -pref * (mxh[0] + alpha * mxmxh[0]),
            -pref * (mxh[1] + alpha * mxmxh[1]),
            -pref * (mxh[2] + alpha * mxmxh[2]),
        )

    th_init = math.radians(78.0)
    phi_init = math.radians(-15.0)
    m_start = (math.sin(th_init) * math.cos(phi_init), math.sin(th_init) * math.sin(phi_init), math.cos(th_init))
    _, traj = rk4_integrate(llg_rhs, m_start, (0.0, 18.0), 0.05, normalize=True)
    sphere_curve(c, proj, traj, color="flux", width=1.55, back_opacity=0.24)

    # Choose m on front-right hemisphere (phi=54°, theta=54°) so tangent vectors project cleanly outward
    th_m = math.radians(54.0)
    phi_m = math.radians(54.0)
    m_pt = (math.sin(th_m) * math.cos(phi_m), math.sin(th_m) * math.sin(phi_m), math.cos(th_m))
    cone_pts = [
        (math.sin(th_m) * math.cos(2.0 * math.pi * k / 120), math.sin(th_m) * math.sin(2.0 * math.pi * k / 120), math.cos(th_m))
        for k in range(121)
    ]
    sphere_curve(c, proj, cone_pts, color="H", width=1.25, front_dash="4,3", back_opacity=0.22)

    cone_l = proj.pt2((math.sin(th_m) * math.cos(math.radians(-56.0)), math.sin(th_m) * math.sin(math.radians(-56.0)), math.cos(th_m)))
    cone_r = proj.pt2((math.sin(th_m) * math.cos(math.radians(124.0)), math.sin(th_m) * math.sin(math.radians(124.0)), math.cos(th_m)))
    ox, oy = proj.pt2((0.0, 0.0, 0.0))
    c.line(ox, oy, cone_l[0], cone_l[1], stroke="H", stroke_width=0.85, dash="2.5,3", opacity=0.42)
    c.line(ox, oy, cone_r[0], cone_r[1], stroke="H", stroke_width=0.85, dash="2.5,3", opacity=0.42)

    mx_tip, my_tip = sphere_vector(c, proj, (0.0, 0.0, 0.0), m_pt, color="m", width=2.5, size="md", tip_dot=True)
    c.math_text(mx_tip + 6, my_tip + 15, format_math("\\mathbf{m}"), fill="m", size=12.2, halo=True)

    arc_pts = [
        proj.pt2((0.38 * math.sin(th_m * k / 20) * math.cos(phi_m), 0.38 * math.sin(th_m * k / 20) * math.sin(phi_m), 0.38 * math.cos(th_m * k / 20)))
        for k in range(21)
    ]
    c.path(curve_path(arc_pts), stroke="ink_secondary", stroke_width=1.1)
    t_lbl = proj.pt2((0.52 * math.sin(0.5 * th_m) * math.cos(phi_m), 0.52 * math.sin(0.5 * th_m) * math.sin(phi_m), 0.52 * math.cos(0.5 * th_m)))
    c.math_text(t_lbl[0] + 4, t_lbl[1] + 2, format_math("θ"), fill="ink", size=11.0, halo=True)

    t_prec = _cross(h_vec, m_pt)
    np_v = math.sqrt(sum(v * v for v in t_prec)) or 1.0
    t_prec = tuple(0.38 * v / np_v for v in t_prec)
    t_damp = _cross(m_pt, t_prec)
    nd_v = math.sqrt(sum(v * v for v in t_damp)) or 1.0
    t_damp = tuple(0.38 * v / nd_v for v in t_damp)

    p_end = (m_pt[0] + t_prec[0], m_pt[1] + t_prec[1], m_pt[2] + t_prec[2])
    d_end = (m_pt[0] + t_damp[0], m_pt[1] + t_damp[1], m_pt[2] + t_damp[2])
    px_e, py_e = sphere_vector(c, proj, m_pt, p_end, color="flux", width=2.1, size="sm")
    dx_e, dy_e = sphere_vector(c, proj, m_pt, d_end, color="accent_warm", width=2.1, size="sm")
    c.math_text(px_e + 7, py_e + 4, format_math("ω_L"), fill="flux", size=11.2, halo=True)
    c.math_text(dx_e + 7, dy_e - 6, format_math("\\mathbf{τ}_{damp}"), fill="accent_warm", size=10.6, halo=True)

    legend_strip(
        c,
        32,
        366,
        [
            ("Precession " + math_span(format_math("−γ_0\\mathbf{m}×\\mathbf{H}_{ext}")), "flux", "arrow"),
            ("Damping " + math_span(format_math("\\mathbf{τ}_{damp} = −αγ_0\\mathbf{m}×(\\mathbf{m}×\\mathbf{H}_{ext})")), "accent_warm", "arrow"),
        ],
        horizontal=False,
        row_gap=18.5,
    )

    pf = axes_2d(
        c,
        368,
        104,
        232,
        204,
        xlim=(0.0, math.pi),
        ylim=(-1.18, 1.18),
        xlabel=format_math("θ (\\mathbf{m}, \\mathbf{H}_{ext})"),
        ylabel=format_math("w_Z / (μ_0M_sH_{ext})"),
        xticks=(0.0, 0.5 * math.pi, math.pi),
        xtick_labels=("0", "π/2", "π"),
        yticks=(-1.0, 0.0, 1.0),
        ytick_labels=("−1", "0", "+1"),
        grid=True,
        zero_lines=True,
        xlabel_offset=28.0,
        ylabel_offset=36.0,
    )
    ths = [math.pi * k / 120 for k in range(121)]
    pf.plot_curve(ths, [math.cos(x) for x in ths], color="ink_muted", width=1.5, dash="4,3")
    pf.plot_curve(ths, [-math.cos(x) for x in ths], color="H", width=2.3)
    pf.scatter([0.0], [-1.0], r=3.8, fill="flux")
    pf.scatter([0.5 * math.pi], [0.0], r=3.8, fill="accent_warm")
    pf.scatter([math.pi], [1.0], r=3.8, fill="m")

    c.text(pf.px(0.14), pf.py(-0.98) + 2, "aligned min", cls="fm-note", fill="flux", halo=True)
    c.text(pf.px(0.5 * math.pi) + 8, pf.py(-0.18), "max torque", cls="fm-note", fill="accent_warm", halo=True)
    c.text(pf.px(math.pi) - 6, pf.py(1.0) - 9, "antiparallel", cls="fm-note", fill="m", anchor="end", halo=True)
    c.math_text(pf.px(0.28 * math.pi), pf.py(0.88), format_math("−\\mathbf{B}_{ext} (+\\mathrm{cos} θ)"), fill="ink_muted", size=10.2, halo=True)

    c.math_text(
        484,
        374,
        format_math("w_Z(θ) = −μ_0M_sH_{ext}\\mathrm{cos} θ = −M_sB_{ext}\\mathrm{cos} θ"),
        fill="H",
        size=11.2,
        anchor="middle",
    )
    c.text(
        484,
        394,
        "Odd reversal: " + math_span(format_math("\\mathbf{B}_{ext} → −\\mathbf{B}_{ext}")) + " flips " + math_span(format_math("\\mathbf{H}_Z")) + " and " + math_span(format_math("E_Z")),
        cls="fm-note",
        anchor="middle",
        raw_markup=True,
    )

    # ===== PANEL B: FULLMAG FIELD-SOURCE CONTRACTS =====
    panel_label(
        c,
        644,
        28,
        "b",
        title="Prescribed field-source contracts",
        subtitle="Non-aliasing IR terms into " + math_span(format_math("\\mathbf{H}_{eff}")),
        subtitle_markup=True,
    )

    bx, bw = 648.0, 276.0
    flow_node(
        c,
        bx,
        78,
        bw,
        68,
        "Uniform  Zeeman(B) / study.b_ext",
        subtitle=[
            "Spatially constant " + math_span(format_math("\\mathbf{H}_{ext} = \\mathbf{B}_{ext}/μ_0")),
            "FDM &amp; FEM (CPU/GPU) · " + math_span(format_math("\\mathbf{H}_{ext}, E_{ext}")),
        ],
        accent="H",
        align="left",
        sub_markup=True,
    )
    flow_node(
        c,
        bx,
        162,
        bw,
        64,
        "StaticFieldMap(id, field_B_T)",
        subtitle=[
            "Per-cell static induction " + math_span(format_math("\\mathbf{B}_{ext}(\\mathbf{x}_i)")),
            "FDM CPU/GPU only · rejected fail-closed on FEM",
        ],
        accent="accent_violet",
        align="left",
        sub_markup=True,
    )
    flow_node(
        c,
        bx,
        242,
        bw,
        68,
        "RegionalFieldDrive / MaskAntenna",
        subtitle=[
            "Localized " + math_span(format_math("\\mathbf{H}_{drive}(\\mathbf{x}, t) = \\mathbf{B}_{drive}/μ_0")),
            "FDM &amp; FEM (CPU/GPU) · " + math_span(format_math("\\mathbf{H}_{drive}, E_{drive}")),
        ],
        accent="flux",
        align="left",
        sub_markup=True,
    )

    # Clean right-hand collector rail joining ALL three field sources into H_eff
    rail_x = bx + bw + 14.0
    c.line(bx + bw, 112, rail_x, 112, stroke="H", stroke_width=1.2)
    c.line(bx + bw, 194, rail_x, 194, stroke="accent_violet", stroke_width=1.2)
    c.line(bx + bw, 276, rail_x, 276, stroke="flux", stroke_width=1.2)
    c.line(rail_x, 112, rail_x, 366, stroke="axis", stroke_width=1.25)
    vector_arrow(c, rail_x, 366, bx + bw + 2, 366, color="axis", width=1.35, size="sm")

    flow_node(
        c,
        bx,
        342,
        bw,
        48,
        "Additive into " + math_span(format_math("\\mathbf{H}_{eff}")),
        subtitle="Prescribed input only (no Maxwell or eddy-current solve)",
        accent="axis",
        title_markup=True,
    )
    c.text(
        bx + 0.5 * bw,
        412,
        "Strict GPU fuses Zeeman &amp; drives in single " + math_span(format_math("\\mathbf{H}_{eff}")) + " launch",
        cls="fm-note",
        anchor="middle",
        raw_markup=True,
    )


# ---------------------------------------------------------------------------
# 5. oersted-cylinder-and-biot-savart
# ---------------------------------------------------------------------------


def draw_oersted(c: SvgCanvas, t: Theme) -> None:
    """Two-panel figure: OerstedCylinder Ampère profile (a) and Biot-Savart + H(curl) A (b)."""
    panel_divider(c, 488, 18, 488, 452)

    # ===== PANEL A: OERSTED CYLINDER =====
    panel_label(
        c,
        20,
        28,
        "a",
        title="Analytic cylindrical wire",
        subtitle="OerstedCylinder · Ampère right-hand rule",
    )

    wcx, wcy, wr = 94.0, 126.0, 25.0
    c.circle(wcx, wcy, wr * 1.90, fill="none", stroke="H", stroke_width=1.0, dash="3,3", opacity=0.45)
    c.circle(wcx, wcy, wr * 1.40, fill="none", stroke="H", stroke_width=1.35, opacity=0.8)
    c.circle(wcx, wcy, wr, fill="hm_fill", stroke="hm_stroke", stroke_width=1.5)
    out_of_plane_symbol(c, wcx, wcy, direction="out", r=6.8, color="hm_stroke", width=1.4, fill="hm_fill")
    c.math_text(wcx - 34, wcy - 37, format_math("I, \\hat{a}"), fill="hm_stroke", size=11.0, anchor="end", halo=True)

    arc_arrow(c, wcx, wcy, wr * 1.40, -15.0, -78.0, color="H", width=1.6, size="sm")
    arc_arrow(c, wcx, wcy, wr * 1.90, 160.0, 102.0, color="H", width=1.3, size="sm")
    vector_arrow(c, wcx, wcy, wcx + wr, wcy, color="ink", width=1.1, size="sm")
    c.math_text(wcx + 12, wcy - 5, format_math("R"), fill="ink", size=10.4, anchor="middle")
    vector_arrow(c, wcx, wcy, wcx + wr * 1.65, wcy + wr * 0.95, color="axis", width=1.2, size="sm")
    c.math_text(wcx + wr * 1.25, wcy + wr * 1.15, format_math("ρ"), fill="ink_secondary", size=10.8)
    c.math_text(wcx + wr * 1.48, wcy - wr * 1.32, format_math("\\mathbf{H}_{oe} ∥ \\hat{φ}"), fill="H", size=10.8)

    ex = 226.0
    c.math_text(ex, 88, format_math("0 ≤ ρ < R:   \\mathbf{H}_{oe}(ρ) = Iρ / (2πR^2) \\hat{φ}"), fill="hm_stroke", size=11.2)
    c.math_text(ex, 114, format_math("ρ ≥ R:        \\mathbf{H}_{oe}(ρ) = I / (2πρ) \\hat{φ}"), fill="H", size=11.2)
    c.math_text(ex, 140, format_math("H_{peak} = |I| / (2πR)  \\mathrm{at}  ρ = R"), fill="m", size=11.2)
    c.text(ex, 162, "Azimuth " + math_span(format_math("\\hat{φ} = \\hat{a} × \\hat{ρ}")) + "; zero on axis", cls="fm-note", raw_markup=True)

    pf = axes_2d(
        c,
        74,
        208,
        386,
        192,
        xlim=(0.0, 4.0),
        ylim=(0.0, 1.14),
        xlabel=format_math("ρ / R"),
        ylabel=format_math("|H_φ(ρ)| / H_{peak}"),
        xticks=(0.0, 1.0, 2.0, 3.0, 4.0),
        yticks=(0.0, 0.5, 1.0),
        ytick_labels=("0", "0.5", "1.0"),
        grid=True,
        xlabel_offset=28.0,
        ylabel_offset=38.0,
    )
    pf.fill_between([0.0, 1.0], [1.14, 1.14], 0.0, fill="hm_fill", opacity=0.6)
    pf.vline(1.0, color="hm_stroke", width=1.1, dash="4,3")

    r_in = [k / 40.0 for k in range(41)]
    h_in = list(r_in)
    r_out = [1.0 + 3.0 * k / 120.0 for k in range(121)]
    h_out = [1.0 / r for r in r_out]

    pf.plot_curve(r_in, h_in, color="hm_stroke", width=2.4)
    pf.plot_curve(r_out, h_out, color="H", width=2.4)
    pf.scatter([1.0], [1.0], r=4.2, fill="m")

    c.text(pf.px(0.5), pf.py(0.95), "inside", cls="fm-note", fill="hm_stroke", anchor="middle")
    c.math_text(pf.px(0.5), pf.py(0.81), format_math("∝ ρ"), fill="hm_stroke", size=10.8, anchor="middle")
    c.math_text(pf.px(1.12), pf.py(1.01), format_math("I / (2πR)"), fill="m", size=11.0, halo=True)
    c.text(pf.px(2.45), pf.py(0.56), "exterior decay " + math_span(format_math("∝ 1/ρ")), cls="fm-sub", fill="H", size=11.0, raw_markup=True)

    # ===== PANEL B: BIOT-SAVART & VECTOR POTENTIAL =====
    panel_label(
        c,
        510,
        28,
        "b",
        title="Current-source Biot–Savart & vector potential",
        subtitle="OerstedField(source) · conservative " + math_span(format_math("∇·\\mathbf{J}_c = 0")),
        subtitle_markup=True,
    )

    wire_top = "M 530 166 C 575 110, 645 96, 704 128"
    c.path(
        f"{wire_top} L 704 162 C 645 130, 575 144, 530 200 Z",
        fill="hm_fill",
        stroke="hm_stroke",
        stroke_width=1.25,
    )
    c.math_text(564, 155, format_math("Ω_c"), fill="hm_stroke", size=11.0, anchor="middle")
    c.polygon([(598, 121), (628, 117), (630, 147), (600, 151)], fill="flux_soft", stroke="flux", stroke_width=1.3)
    vector_arrow(c, 594, 136, 642, 130, color="flux", width=2.4, size="md")
    c.math_text(618, 99, format_math("\\mathbf{J}_c(\\mathbf{x}') \\mathrm{d}V' (I \\mathrm{d}\\mathbf{ℓ})"), fill="flux", size=11.0, anchor="middle")

    obs_x, obs_y = 836.0, 152.0
    c.ellipse(obs_x + 8, obs_y + 12, 62, 34, fill="fm_fill", fill_opacity=0.65, stroke="fm_stroke", stroke_width=1.15, dash="4,3")
    c.math_text(obs_x + 24, obs_y + 30, format_math("Ω_m"), fill="fm_stroke", size=11.0, anchor="middle")

    vector_arrow(c, 616, 132, obs_x - 3, obs_y - 1, color="axis", width=1.6, size="md")
    c.math_text(728, 133, format_math("\\mathbf{x} − \\mathbf{x}'"), fill="ink_secondary", size=11.4, anchor="middle", halo=True)

    c.circle(obs_x, obs_y, 3.4, fill="H")
    vector_arrow(c, obs_x, obs_y, obs_x - 16, obs_y - 54, color="H", width=2.4, size="md")
    c.math_text(obs_x - 4, obs_y - 54, format_math("\\mathrm{d}\\mathbf{H}_{oe}"), fill="H", size=12.0)
    c.polyline([(obs_x - 12, obs_y - 1), (obs_x - 15, obs_y - 12), (obs_x - 3, obs_y - 11)], stroke="hairline", stroke_width=0.95)
    c.math_text(obs_x + 12, obs_y + 6, format_math("\\mathbf{x}"), fill="ink", size=11.0)

    # Zero raw underscore: render Omega_c integral limit with explicit nested tspan baseline-shifts
    bs_eq = (
        format_math("\\mathbf{H}_{oe}(\\mathbf{x}) = (4π)^{−1} ∫")
        + '<tspan baseline-shift="-22%" font-size="72%" font-style="normal">Ω</tspan>'
        + '<tspan baseline-shift="-34%" font-size="56%" font-style="normal">c</tspan>'
        + format_math(" [\\mathbf{J}_c(\\mathbf{x}')×(\\mathbf{x}−\\mathbf{x}')] / |\\mathbf{x}−\\mathbf{x}'|^3 \\mathrm{d}V'")
    )
    c.math_text(724, 226, bs_eq, fill="ink", size=11.0, anchor="middle")
    c.text(
        724,
        247,
        "No " + math_span(format_math("μ_0")) + " in " + math_span(format_math("\\mathbf{H}_{oe}")) + "  (" + math_span(format_math("\\mathbf{B}_{oe} = μ_0\\mathbf{H}_{oe}")) + ")",
        cls="fm-note",
        anchor="middle",
        raw_markup=True,
    )

    flow_node(
        c,
        594,
        266,
        260,
        36,
        "RT0 current closure (OE-T0):  " + math_span(format_math("∇·\\mathbf{J}_c = 0")),
        accent="flux",
        title_size=10.8,
        title_markup=True,
    )
    curved_arrow(c, 674, 302, 626, 316, 616, 332, color="axis", width=1.3, size="sm")
    curved_arrow(c, 774, 302, 822, 316, 832, 332, color="axis", width=1.3, size="sm")

    # Spacious OE-F1 and OE-F2 boxes with comfortable vertical line spacing for super/subscripts
    flow_node(
        c,
        510,
        336,
        204,
        96,
        "OE-F1 · Direct Biot–Savart",
        subtitle=[
            "FEM tet4 + Duffy singular pairs",
            "CUDA 106-bit hybrid far-field",
            "FDM midpoint (≤ 4096 cells)",
        ],
        accent="H",
        align="left",
        title_size=11.0,
        sub_size=10.0,
    )
    # Custom-spaced OE-F2 node so μ_0^{-1} superscripts and subscripts have generous breathing room
    c.rect(728, 336, 214, 96, fill="node_fill", stroke="accent_violet", stroke_width=1.05, rx=3.0)
    c.line(729.4, 339.0, 729.4, 429.0, stroke="accent_violet", stroke_width=2.6, linecap="round")
    c.text(739, 357, "OE-F2 · " + math_span(format_math("H(\\mathrm{curl})")) + " Vector Potential", cls="fm-label-bold", size=11.0, raw_markup=True)
    c.math_text(739, 378, format_math("∇×(μ_0^{−1}∇×\\mathbf{A}) + ∇p = \\mathbf{J}_c"), fill="ink_secondary", size=10.2)
    c.math_text(739, 399, format_math("∇·\\mathbf{A} = 0,  \\mathbf{H}_{oe} = μ_0^{−1}∇×\\mathbf{A}"), fill="ink_secondary", size=10.2)
    c.text(739, 419, "Sparse MUMPS / Hypre AMS", cls="fm-note", size=10.0)


# ---------------------------------------------------------------------------
# 6. thermal-brown-stochastic-llg
# ---------------------------------------------------------------------------


def draw_thermal(c: SvgCanvas, t: Theme) -> None:
    """Two-panel figure: stochastic LLG ensemble + Heun midpoint (a) and Boltzmann P(theta) (b)."""
    panel_divider(c, 494, 18, 494, 452)

    # ===== PANEL A: STOCHASTIC LLG ENSEMBLE & HEUN CONTRACT =====
    panel_label(
        c,
        20,
        28,
        "a",
        title="Stochastic LLG ensemble & Heun step",
        subtitle=math_span(format_math("\\mathbf{H}_{th,i}^n = σ_i^n\\mathbf{ξ}_i^n,   \\mathbf{ξ}_i^n ∼ \\mathrm{N}(\\mathbf{0}, \\mathbf{I}_3)")),
        subtitle_markup=True,
    )

    xi_dyn = 3.0
    ts, det_mz, sample_traces, mean_mz = _simulate_stochastic_llg_heun(
        xi=xi_dyn,
        alpha=0.18,
        theta0_deg=118.0,
        t_end=16.0,
        dt=0.04,
        n_trajectories=240,
        seed=42,
    )
    langevin_eq = (1.0 / math.tanh(xi_dyn)) - (1.0 / xi_dyn)

    pf_t = axes_2d(
        c,
        66,
        74,
        406,
        168,
        xlim=(0.0, 16.0),
        ylim=(-0.65, 1.08),
        xlabel=format_math("γ_0 H_{ext} t"),
        ylabel=format_math("m_z(t)"),
        xticks=(0.0, 4.0, 8.0, 12.0, 16.0),
        yticks=(-0.5, 0.0, 0.5, 1.0),
        ytick_labels=("−0.5", "0", "0.5", "1.0"),
        grid=True,
        zero_lines=True,
        xlabel_offset=27.0,
        ylabel_offset=36.0,
    )
    for trace in sample_traces:
        pf_t.plot_curve(ts, trace, color="m", width=0.9, opacity=0.30)
    pf_t.hline(langevin_eq, color="flux", width=1.1, dash="3,3")
    eq_x, eq_y = pf_t.px(15.6), pf_t.py(langevin_eq) - 8
    c.rect(eq_x - 68, eq_y - 11, 70, 16, fill="surface_ref", fill_opacity=0.88, stroke="none", rx=2.0)
    c.math_text(eq_x, eq_y, format_math("⟨m_z⟩_{eq} = L(ξ)"), fill="flux", size=10.0, anchor="end", halo=True)
    pf_t.plot_curve(ts, det_mz, color="H", width=1.8, dash="5,3")
    pf_t.plot_curve(ts, mean_mz, color="m", width=2.2)

    # Clean borderless legend with subtle translucent surface backing so faint traces don't clutter text
    c.rect(244, 178, 220, 56, fill="surface_ref", fill_opacity=0.84, stroke="none", rx=2.0)
    c.line(252, 189, 270, 189, stroke="H", stroke_width=1.8, dash="5,3")
    c.text(276, 192.5, "Deterministic (" + math_span(format_math("T=0")) + ")", cls="fm-sub", size=10.4, raw_markup=True)
    c.line(252, 206, 270, 206, stroke="m", stroke_width=2.2)
    c.text(276, 209.5, "Mean " + math_span(format_math("⟨m_z(t)⟩")) + " (" + math_span(format_math("N=240")) + ")", cls="fm-sub", size=10.4, raw_markup=True)
    c.line(252, 223, 270, 223, stroke="m", stroke_width=1.0, opacity=0.45)
    c.text(276, 226.5, "Single realizations", cls="fm-sub", size=10.4)

    c.math_text(
        256,
        294,
        format_math("σ_i^n = √[ 2α_i k_B T / (γ_{μ0} μ_0 M_{s,i} V_i Δt_n) ]"),
        fill="ink",
        size=12.0,
        anchor="middle",
    )
    c.text(
        256,
        314,
        "Bare " + math_span(format_math("γ_{μ0}")) + " in denominator: " + math_span(format_math("1/(1+α^2)")) + " applied once by LLG",
        cls="fm-note",
        anchor="middle",
        raw_markup=True,
    )

    y_st = 336.0
    flow_node(c, 24, y_st, 128, 52, "1. Draw " + math_span(format_math("\\mathbf{ξ}_i^n")), subtitle="once per interval " + math_span(format_math("n")), accent="H", title_size=10.6, sub_size=9.8, title_markup=True, sub_markup=True)
    vector_arrow(c, 152, y_st + 26, 174, y_st + 26, color="axis", width=1.4, size="sm")
    flow_node(c, 176, y_st, 142, 52, "2. Heun midpoint", subtitle="hold " + math_span(format_math("σ(Δt)\\mathbf{ξ}_i^n")) + " fixed", accent="flux", title_size=10.6, sub_size=9.8, sub_markup=True)
    vector_arrow(c, 318, y_st + 26, 340, y_st + 26, color="flux", width=1.4, size="sm")
    flow_node(c, 342, y_st, 132, 52, "3. Accept step", subtitle="invalidate FSAL reuse", accent="accent_violet", title_size=10.6, sub_size=9.8)

    c.path("M 268 388 L 268 414 L 204 414 L 204 391", stroke="m", stroke_width=1.4, dash="4,2.5", marker_end=c.marker_url("m", size="sm"))
    c.text(
        248,
        433,
        "Rejected adaptive retry: reuse " + math_span(format_math("\\mathbf{ξ}_i^n")) + ", rescale " + math_span(format_math("σ ∝ Δt^{−1/2}")),
        cls="fm-note",
        fill="m",
        anchor="middle",
        raw_markup=True,
    )

    # ===== PANEL B: BOLTZMANN EQUILIBRIUM & STATISTICAL VALIDATION =====
    panel_label(
        c,
        514,
        28,
        "b",
        title="Boltzmann equilibrium distribution",
        subtitle=math_span(format_math("P_{eq}(θ) = [ξ/(2 \\mathrm{sinh} ξ)] \\mathrm{sin} θ \\mathrm{exp}(ξ \\mathrm{cos} θ),  ξ = 2.0")),
        subtitle_markup=True,
    )

    xi_eq = 2.0
    norm_eq = xi_eq / (2.0 * math.sinh(xi_eq))
    ths = [math.pi * k / 150 for k in range(151)]
    p_eq = [norm_eq * math.sin(th) * math.exp(xi_eq * math.cos(th)) for th in ths]
    p_inf = [0.5 * math.sin(th) for th in ths]

    rng = random.Random(2026)
    n_samples = 4000
    n_bins = 12
    dth = math.pi / n_bins
    counts = [0] * n_bins
    em = math.exp(-xi_eq)
    ep = math.exp(xi_eq)
    for _ in range(n_samples):
        u = rng.random()
        cos_th = math.log(em + u * (ep - em)) / xi_eq
        cos_th = max(-1.0, min(1.0, cos_th))
        th = math.acos(cos_th)
        b_idx = min(n_bins - 1, int(th / dth))
        counts[b_idx] += 1

    pf_b = axes_2d(
        c,
        566,
        74,
        368,
        222,
        xlim=(0.0, math.pi),
        ylim=(0.0, 0.92),
        xlabel=format_math("θ [\\mathrm{rad}]"),
        ylabel=format_math("P(θ)"),
        xticks=(0.0, 0.25 * math.pi, 0.5 * math.pi, 0.75 * math.pi, math.pi),
        xtick_labels=("0", "π/4", "π/2", "3π/4", "π"),
        yticks=(0.0, 0.3, 0.6, 0.9),
        ytick_labels=("0", "0.3", "0.6", "0.9"),
        grid=True,
        xlabel_offset=28.0,
        ylabel_offset=36.0,
    )
    pf_b.fill_between(ths, p_eq, 0.0, fill="H_soft", opacity=0.45)
    pf_b.plot_curve(ths, p_inf, color="ink_muted", width=1.5, dash="4,3")
    pf_b.plot_curve(ths, p_eq, color="H", width=2.3)

    for b_idx, cnt in enumerate(counts):
        th_c = (b_idx + 0.5) * dth
        p_hat = cnt / n_samples
        dens = p_hat / dth
        se_dens = math.sqrt(max(p_hat * (1.0 - p_hat), 1e-9) / n_samples) / dth
        ci95 = 1.96 * se_dens
        sx = pf_b.px(th_c)
        sy = pf_b.py(dens)
        sy_lo = pf_b.py(max(0.0, dens - ci95))
        sy_hi = pf_b.py(min(0.92, dens + ci95))
        c.line(sx, sy_lo, sx, sy_hi, stroke="m", stroke_width=1.35)
        c.line(sx - 3.0, sy_lo, sx + 3.0, sy_lo, stroke="m", stroke_width=1.15)
        c.line(sx - 3.0, sy_hi, sx + 3.0, sy_hi, stroke="m", stroke_width=1.15)
        c.circle(sx, sy, 3.0, fill="m", stroke="surface_ref", stroke_width=0.9)

    legend_strip(
        c,
        742,
        102,
        [
            ("Exact Boltzmann " + math_span(format_math("P_{eq}(θ)")), "H", "solid"),
            ("Ensemble ± 95% CI (" + math_span(format_math("N=4000")) + ")", "m", "dot"),
            (math_span(format_math("T → ∞")) + " limit: " + math_span(format_math("½ \\mathrm{sin} θ")), "ink_muted", "dashed"),
        ],
        horizontal=False,
        row_gap=18.0,
    )

    c.line(520, 348, 938, 348, stroke="hairline", stroke_width=0.8, opacity=0.65)
    c.math_text(
        522,
        370,
        format_math("⟨H_{th,i,a}^n H_{th,j,b}^m⟩ = (σ_i^n)^2 δ_{ij}δ_{ab}δ_{nm}"),
        fill="ink",
        size=11.4,
    )
    c.text(
        522,
        392,
        "Statistical qualification: verify variance scaling "
        + math_span(format_math("∝ Tα/(VΔt)"))
        + " and "
        + math_span(format_math("P_{eq}(θ)"))
        + " CIs",
        cls="fm-note",
        raw_markup=True,
    )
    c.text(
        522,
        410,
        "across CPU/GPU RNG streams (not bitwise trajectory identity).",
        cls="fm-note",
    )
    c.text(
        522,
        432,
        "FDM: fixed-step Heun · FEM CPU: adaptive retry reuse · FEM GPU: gated",
        cls="fm-note",
        fill="ink_muted",
    )


# ---------------------------------------------------------------------------
# 7. magnetoelastic-voigt-strain-coupling
# ---------------------------------------------------------------------------


def _draw_isometric_cube(
    c: SvgCanvas,
    ox: float,
    oy: float,
    ex: tuple[float, float],
    ey: tuple[float, float],
    ez: tuple[float, float],
    *,
    fill_front: str | None = None,
    fill_top: str | None = None,
    fill_side: str | None = None,
    stroke: str = "ink",
    stroke_width: float = 1.2,
    dash: str | None = None,
    fill_opacity: float = 0.65,
) -> dict[str, tuple[float, float]]:
    """Draw a 3D oblique/isometric parallelepiped from origin ``(ox, oy)`` and 3 edge vectors."""
    def add(p: tuple[float, float], v: tuple[float, float]) -> tuple[float, float]:
        return (p[0] + v[0], p[1] + v[1])

    p000 = (ox, oy)
    p100 = add(p000, ex)
    p010 = add(p000, ey)
    p001 = add(p000, ez)
    p110 = add(p100, ey)
    p101 = add(p100, ez)
    p011 = add(p010, ez)
    p111 = add(p110, ez)

    if fill_front is not None:
        c.polygon([p000, p100, p101, p001], fill=fill_front, fill_opacity=fill_opacity, stroke=stroke, stroke_width=stroke_width, dash=dash)
    if fill_top is not None:
        c.polygon([p001, p101, p111, p011], fill=fill_top, fill_opacity=fill_opacity, stroke=stroke, stroke_width=stroke_width, dash=dash)
    if fill_side is not None:
        c.polygon([p100, p110, p111, p101], fill=fill_side, fill_opacity=fill_opacity, stroke=stroke, stroke_width=stroke_width, dash=dash)
    if fill_front is None:
        for a, b in (
            (p000, p100), (p100, p101), (p101, p001), (p001, p000),
            (p001, p011), (p011, p111), (p111, p101),
            (p100, p110), (p110, p111),
        ):
            c.line(a[0], a[1], b[0], b[1], stroke=stroke, stroke_width=stroke_width, dash=dash)

    return {
        "000": p000, "100": p100, "010": p010, "001": p001,
        "110": p110, "101": p101, "011": p011, "111": p111,
    }


def draw_magnetoelastic(c: SvgCanvas, t: Theme) -> None:
    """Two-panel figure: Voigt strain modes (a) and bidirectional magnon-phonon coupling (b)."""
    panel_divider(c, 464, 18, 464, 466)

    # ===== PANEL A: DEFORMED CUBIC UNIT CELL & VOIGT STRAIN =====
    panel_label(
        c,
        20,
        28,
        "a",
        title="Cubic Voigt strain modes",
        subtitle=math_span(format_math("\\mathbf{ε}^{eng} = (ε_{11}, ε_{22}, ε_{33}, γ_{23}, γ_{13}, γ_{12})^T,  γ_{ij} = 2ε_{ij}")),
        subtitle_markup=True,
    )

    c.text(118, 72, "Normal strain (" + math_span(format_math("B_1")) + ")", cls="fm-label-bold", fill="H", size=11.2, anchor="middle", raw_markup=True)
    ox1, oy1 = 52.0, 182.0
    ex0, ey0, ez0 = (60.0, 0.0), (24.0, -17.0), (0.0, -56.0)
    _draw_isometric_cube(c, ox1, oy1, ex0, ey0, ez0, stroke="hairline", stroke_width=1.0, dash="3,2.5")
    ex_n, ey_n, ez_n = (78.0, 0.0), (24.0, -17.0), (0.0, -51.0)
    _draw_isometric_cube(
        c,
        ox1,
        oy1,
        ex_n,
        ey_n,
        ez_n,
        fill_front="H_soft",
        fill_top="H_soft",
        fill_side="H_soft",
        stroke="H",
        stroke_width=1.35,
        fill_opacity=0.62,
    )
    vector_arrow(c, ox1 + 64, oy1 - 26, ox1 + 108, oy1 - 26, color="H", width=1.8, size="sm")
    c.math_text(ox1 + 114, oy1 - 22, format_math("ε_{11}"), fill="H", size=11.4)
    vector_arrow(c, ox1 + 22, oy1 - 26, ox1 + 56, oy1 - 26, color="m", width=2.2, size="sm")
    c.math_text(ox1 + 39, oy1 - 34, format_math("\\mathbf{m}"), fill="m", size=11.4, anchor="middle", halo=True)
    c.math_text(ox1 + 48, oy1 + 16, format_math("ε_{11}, ε_{22}, ε_{33} ∼ λ_{100}"), fill="ink_secondary", size=10.4, anchor="middle")

    c.text(336, 72, "Shear strain (" + math_span(format_math("B_2")) + ")", cls="fm-label-bold", fill="accent_violet", size=11.2, anchor="middle", raw_markup=True)
    ox2, oy2 = 272.0, 182.0
    _draw_isometric_cube(c, ox2, oy2, ex0, ey0, ez0, stroke="hairline", stroke_width=1.0, dash="3,2.5")
    ex_s, ey_s, ez_s = (60.0, 0.0), (24.0, -17.0), (18.0, -54.0)
    _draw_isometric_cube(
        c,
        ox2,
        oy2,
        ex_s,
        ey_s,
        ez_s,
        fill_front="accent_violet_soft",
        fill_top="accent_violet_soft",
        fill_side="accent_violet_soft",
        stroke="accent_violet",
        stroke_width=1.35,
        fill_opacity=0.68,
    )
    # Shear arrow & label strictly above the top face (top back corner is at y = oy2 - 54 - 17 = 111)
    vector_arrow(c, ox2 + 12, oy2 - 86, ox2 + 44, oy2 - 86, color="accent_violet", width=1.8, size="sm")
    c.math_text(ox2 + 52, oy2 - 82, format_math("γ_{13} = 2ε_{13}"), fill="accent_violet", size=10.8, halo=True)
    vector_arrow(c, ox2 + 22, oy2 - 17, ox2 + 52, oy2 - 42, color="m", width=2.2, size="sm")
    c.math_text(ox2 + 24, oy2 - 35, format_math("\\mathbf{m}"), fill="m", size=11.4, anchor="middle", halo=True)
    c.math_text(ox2 + 46, oy2 + 16, format_math("γ_{23}, γ_{13}, γ_{12} ∼ λ_{111}"), fill="ink_secondary", size=10.4, anchor="middle")

    c.text(24, 228, "Canonical FullMag engineering-Voigt vector " + math_span(format_math("\\mathbf{ε}^{eng} = \\mathbf{W}_V\\mathbf{ε}_{ten}")), cls="fm-sub", size=10.6, raw_markup=True)
    voigt_items = [
        ("[0]", format_math("ε_{11}"), format_math("B_1"), "H_soft", "H"),
        ("[1]", format_math("ε_{22}"), format_math("B_1"), "H_soft", "H"),
        ("[2]", format_math("ε_{33}"), format_math("B_1"), "H_soft", "H"),
        ("[3]", format_math("γ_{23}"), format_math("2ε_{23}"), "accent_violet_soft", "accent_violet"),
        ("[4]", format_math("γ_{13}"), format_math("2ε_{13}"), "accent_violet_soft", "accent_violet"),
        ("[5]", format_math("γ_{12}"), format_math("2ε_{12}"), "accent_violet_soft", "accent_violet"),
    ]
    vx0, vw, vgap = 24.0, 64.0, 6.0
    for i, (idx_s, sym_s, tag_s, bg_c, fg_c) in enumerate(voigt_items):
        vx = vx0 + i * (vw + vgap)
        c.rect(vx, 240, vw, 54, fill=bg_c, fill_opacity=0.65, stroke=fg_c, stroke_width=1.0, rx=2.5)
        c.text(vx + 0.5 * vw, 253, idx_s, cls="fm-code", size=9.4, anchor="middle")
        c.math_text(vx + 0.5 * vw, 271, sym_s, fill=fg_c, size=12.4, anchor="middle")
        c.math_text(vx + 0.5 * vw, 287, tag_s, fill="ink_secondary", size=9.6, anchor="middle")

    c.line(24, 314, 440, 314, stroke="hairline", stroke_width=0.75, opacity=0.65)
    c.text(24, 334, "Traceless cubic magnetoelastic density (crystal frame)", cls="fm-sub", size=10.8)
    c.math_text(
        24,
        358,
        format_math("w_{mel} = B_1∑_i ε_{ii}(m_i^2 − ⅓) + 2B_2∑_{i<j} ε_{ij}m_i m_j"),
        fill="ink",
        size=11.6,
    )
    c.math_text(
        24,
        385,
        format_math("B_1 = −(3/2)λ_{100}(C_{11}−C_{12}),   B_2 = −3λ_{111}C_{44}"),
        fill="H",
        size=11.2,
    )
    c.math_text(
        24,
        412,
        format_math("H_{mel,1} = −[2B_1ε_{11}m_1 + 2B_2(ε_{12}m_2+ε_{13}m_3)] / (μ_0M_s)"),
        fill="flux",
        size=10.6,
    )
    c.text(
        24,
        438,
        "Kernel halves shear " + math_span(format_math("ε_{ij} = ½γ_{ij}")) + "; Kelvin–Mandel " + math_span(format_math("\\mathbf{C}_{KM}")) + " bounds CFL",
        cls="fm-note",
        raw_markup=True,
    )

    # ===== PANEL B: BIDIRECTIONAL MAGNON-PHONON COUPLING =====
    panel_label(
        c,
        484,
        28,
        "b",
        title="Bidirectional magnon–phonon coupling",
        subtitle="Hybrid film–substrate dynamics on " + math_span(format_math("Ω_{mag} ⊆ Ω_{mech}")),
        subtitle_markup=True,
    )

    # Heterostructure slab with outward right bracket cleanly outside the slab
    hx0, hw = 496.0, 376.0
    layer_slab(c, hx0, 70, hw, 38, kind="fm")
    layer_slab(c, hx0, 108, hw, 42, kind="hm")
    c.math_text(hx0 + 8, 86, format_math("Ω_{mag}"), fill="fm_stroke", size=10.6)
    c.math_text(hx0 + 8, 124, format_math("Ω_{sub}"), fill="hm_stroke", size=10.6)

    for k in range(8):
        px = hx0 + 62.0 + k * 38.0
        ang_deg = 90.0 + 26.0 * math.sin(2.0 * math.pi * k / 4.0)
        spin_arrow(c, px, 89.0, ang_deg, length=20.0, color="m", width=1.8, size="sm")
    wave_xs = [hx0 + 54.0 + 260.0 * k / 100.0 for k in range(101)]
    wave_y1 = [122.0 + 4.8 * math.sin(2.0 * math.pi * (x - hx0 - 54.0) / 80.0) for x in wave_xs]
    wave_y2 = [137.0 + 3.2 * math.sin(2.0 * math.pi * (x - hx0 - 54.0) / 80.0) for x in wave_xs]
    c.path(curve_path(list(zip(wave_xs, wave_y1))), stroke="H", stroke_width=1.6, opacity=0.9)
    c.path(curve_path(list(zip(wave_xs, wave_y2))), stroke="H", stroke_width=1.2, opacity=0.55)
    c.math_text(hx0 + hw - 8, 132, format_math("\\mathbf{u}(\\mathbf{r},t)"), fill="H", size=10.4, anchor="end", halo=True)
    # Draw bracket from bottom to top so offset > 0 shifts RIGHT into open margin
    bracket_dim(c, hx0 + hw + 2, 150, hx0 + hw + 2, 70, label=format_math("Ω_{mech}"), offset=10.0, color="axis", label_offset=8.0)

    # Bidirectional coupling feedback loop with generous clearance between curves & equations
    ly = 238.0
    flow_node(
        c,
        488,
        ly,
        204,
        82,
        "LLG Spin Dynamics (" + math_span(format_math("Ω_{mag}")) + ")",
        subtitle=[
            math_span(format_math("∂_t\\mathbf{m} = −γ'\\mathbf{m}×\\mathbf{H}_{eff} − α'\\mathbf{m}×(\\mathbf{m}×\\mathbf{H}_{eff})")),
            math_span(format_math("\\mathbf{H}_{eff} = … + \\mathbf{H}_{mel} + \\mathbf{H}_{rot}")),
        ],
        accent="m",
        title_size=10.8,
        sub_size=9.7,
        title_markup=True,
        sub_markup=True,
    )
    flow_node(
        c,
        734,
        ly,
        208,
        82,
        "Elastodynamics (" + math_span(format_math("Ω_{mech}")) + ")",
        subtitle=[
            math_span(format_math("ρ ∂_t^2\\mathbf{u} = ∇·(\\mathbf{C}:\\mathbf{ε} + \\mathbf{σ}^{me} + \\mathbf{σ}^{rot})")),
            math_span(format_math("\\mathbf{ε} = ½(∇\\mathbf{u}+∇\\mathbf{u}^T),  \\mathbf{ω} = ½(∇\\mathbf{u}−∇\\mathbf{u}^T)")),
        ],
        accent="H",
        title_size=10.8,
        sub_size=9.7,
        title_markup=True,
        sub_markup=True,
    )

    # Top curved arrow: midpoint at y = ly - 20, equation cleanly above at ly - 38, tag at ly - 56
    curved_arrow(c, 816, ly - 3, 714, ly - 38, 610, ly - 3, color="H", width=2.0, size="md")
    c.math_text(
        714,
        ly - 38,
        format_math("\\mathbf{H}_{mel} = −(μ_0M_s)^{−1}∂w_{mel}/∂\\mathbf{m}  (+\\mathbf{H}_{rot})"),
        fill="H",
        size=10.8,
        anchor="middle",
    )
    c.text(
        714,
        ly - 56,
        "Strain → spins (executable one-way FEM CPU/GPU)",
        cls="fm-note",
        fill="H",
        anchor="middle",
    )

    # Bottom curved arrow: midpoint at y = ly + 102, equation cleanly below at ly + 122, tag at ly + 139
    curved_arrow(c, 610, ly + 85, 714, ly + 120, 816, ly + 85, color="accent_violet", width=2.0, size="md", dash="5,3")
    c.math_text(
        714,
        ly + 122,
        format_math("\\mathbf{σ}^{me} = ∂w_{mel}/∂\\mathbf{ε},   σ_{ij}^{rot} = ∂w_{rot}/∂ω_{ij}"),
        fill="accent_violet",
        size=10.8,
        anchor="middle",
    )
    c.text(
        714,
        ly + 140,
        "Spin back-action stress → phonons (v2 bidirectional)",
        cls="fm-note",
        fill="accent_violet",
        anchor="middle",
    )

    c.line(488, 400, 942, 400, stroke="hairline", stroke_width=0.75, opacity=0.65)
    c.math_text(
        490,
        420,
        format_math("\\mathrm{d}/\\mathrm{d}t (F_{mag} + F_{el} + F_{mel} + E_{kin}) = −D_{LLG} − D_{mech}"),
        fill="ink",
        size=11.0,
    )
    c.text(
        490,
        441,
        "Total angular momentum "
        + math_span(format_math("\\mathbf{τ}_{mag} + \\mathbf{τ}_{mech} = \\mathbf{0}"))
        + " via skew-symmetric Melcher "
        + math_span(format_math("\\mathbf{σ}^{rot}")),
        cls="fm-note",
        raw_markup=True,
    )


# ---------------------------------------------------------------------------
# 8. magnetoelastic-boundary-conditions-and-meshing
# ---------------------------------------------------------------------------


def _code_span(text: str, *, size: float = 9.4) -> str:
    return f'<tspan font-family="{esc(FONT_MONO)}" font-size="{size:.1f}">{esc(text)}</tspan>'


def _draw_dashpot(c: SvgCanvas, x_wall: float, y: float, *, color: str = "H") -> None:
    """Draw a crisp engineering Lysmer-Kuhlemeyer surface damper attached on the left of ``x_wall``."""
    c.line(x_wall, y, x_wall - 8.5, y, stroke=color, stroke_width=1.3)
    c.line(x_wall - 8.5, y - 4.2, x_wall - 8.5, y + 4.2, stroke=color, stroke_width=1.7)
    c.polyline(
        [
            (x_wall - 5.5, y - 6.2),
            (x_wall - 13.0, y - 6.2),
            (x_wall - 13.0, y + 6.2),
            (x_wall - 5.5, y + 6.2),
        ],
        stroke=color,
        stroke_width=1.25,
    )
    c.line(x_wall - 13.0, y, x_wall - 19.5, y, stroke=color, stroke_width=1.25)


def draw_magnetoelastic_bc_meshing(c: SvgCanvas, t: Theme) -> None:
    """Two-panel figure: FM/NM mechanical BCs & absorbing layers (a) and FDM vs FEM meshing (b)."""
    panel_divider(c, 474, 18, 474, 468)

    # ===== PANEL A: MULTI-DOMAIN MECHANICAL BCs & INTERFACE CONTINUITY =====
    panel_label(
        c,
        20,
        28,
        "a",
        title="Boundary & interface conditions",
        subtitle="Multi-domain "
        + math_span(format_math("Ω_{mag} ⊆ Ω_{mech}"))
        + " &amp; absorbing collars",
        subtitle_markup=True,
    )

    # Physical NM substrate slab (interior) + right absorbing collar
    sub_x0, sub_x1 = 122.0, 340.0
    abs_x1 = 450.0
    sub_y0, sub_y1 = 168.0, 248.0
    fm_x0, fm_x1 = 122.0, 252.0
    fm_y0, fm_y1 = 122.0, 168.0

    # Right absorbing collar (Omega_ABL / Omega_PML) with graded sponge tint + subtle hatch
    c.rect(
        sub_x1,
        sub_y0,
        abs_x1 - sub_x1,
        sub_y1 - sub_y0,
        fill="flux_soft",
        fill_opacity=0.32,
        stroke="none",
    )
    collar_w = abs_x1 - sub_x1
    for band_idx, band_op in enumerate((0.06, 0.13, 0.22)):
        bx = sub_x1 + band_idx * (collar_w / 3.0)
        c.rect(
            bx,
            sub_y0,
            collar_w / 3.0,
            sub_y1 - sub_y0,
            fill="flux",
            fill_opacity=band_op,
            stroke="none",
        )
    c.rect(
        sub_x1,
        sub_y0,
        collar_w,
        sub_y1 - sub_y0,
        fill=f"url(#{c._pid('hatch-flux')})",
        stroke="flux",
        stroke_width=1.15,
        dash="4,3",
    )

    # Interior NM substrate slab
    layer_slab(c, sub_x0, sub_y0, sub_x1 - sub_x0, sub_y1 - sub_y0, kind="hm", rx=0.0)
    # Ferromagnetic film bonded on top of NM substrate
    layer_slab(c, fm_x0, fm_y0, fm_x1 - fm_x0, fm_y1 - fm_y0, kind="fm", rx=0.0)

    # FM interior label and spin moments
    c.math_text(fm_x0 + 7.0, fm_y0 + 14.5, format_math("Ω_{mag} \\mathrm{(FM)}"), fill="fm_stroke", size=9.8)
    for k, ang in enumerate((82.0, 104.0, 76.0, 98.0)):
        spin_arrow(c, fm_x0 + 21.0 + k * 29.0, fm_y0 + 31.0, ang, length=16.5, color="m", width=1.7, size="sm")

    # Propagating elastic wave in Omega_sub decaying smoothly inside right absorbing collar
    wave_xs = [135.0 + (444.0 - 135.0) * k / 150.0 for k in range(151)]
    wave_y1: list[float] = []
    wave_y2: list[float] = []
    for wx in wave_xs:
        if wx <= sub_x1:
            env = 1.0
        else:
            xi = (wx - sub_x1) / (444.0 - sub_x1)
            env = math.exp(-5.0 * (xi ** 3.2))
        phase = 2.0 * math.pi * (wx - 135.0) / 50.0
        wave_y1.append(205.0 + 10.0 * env * math.sin(phase))
        wave_y2.append(221.0 + 4.8 * env * math.sin(phase - 0.5))
    c.path(curve_path(list(zip(wave_xs, wave_y1))), stroke="H", stroke_width=1.65, opacity=0.92)
    c.path(curve_path(list(zip(wave_xs, wave_y2))), stroke="H", stroke_width=1.15, opacity=0.52)

    c.math_text(sub_x0 + 7.0, sub_y1 - 7.0, format_math("Ω_{sub} \\mathrm{(NM)}"), fill="hm_stroke", size=9.8)
    c.math_text(294.0, sub_y1 - 7.0, format_math("\\mathbf{u}(\\mathbf{r},t)"), fill="H", size=9.8, anchor="middle")
    c.math_text(
        0.5 * (sub_x1 + abs_x1),
        sub_y1 - 7.0,
        format_math("Ω_{ABL/PML}"),
        fill="flux",
        size=9.5,
        anchor="middle",
    )

    # Highlighted bonded FM/NM interface Gamma_FM/NM
    c.line(fm_x0, fm_y1, fm_x1, fm_y1, stroke="accent_violet", stroke_width=2.6)
    c.math_text(
        0.5 * (fm_x0 + fm_x1),
        fm_y1 + 14.0,
        format_math("Γ_{FM/NM}"),
        fill="accent_violet",
        size=10.2,
        anchor="middle",
    )

    # Free top surface BC on FM film
    vector_arrow(c, 141.0, fm_y0, 141.0, 98.0, color="H", width=1.55, size="sm")
    c.math_text(132.0, 111.0, format_math("\\hat{n}"), fill="H", size=10.4, anchor="end")
    c.text(198.0, 78.0, "Free surface", cls="fm-note", fill="H", anchor="middle", size=9.8)
    c.math_text(198.0, 94.0, format_math("\\mathbf{σ}^{tot}·\\hat{n} = \\mathbf{0}"), fill="H", size=10.4, anchor="middle")

    # Prescribed traction IDT pad on exposed NM surface
    idt_x0, idt_x1 = 266.0, 326.0
    c.rect(idt_x0, sub_y0 - 4.5, idt_x1 - idt_x0, 4.5, fill="accent_warm", stroke="accent_warm", stroke_width=0.8, rx=1.0)
    for tx in (276.0, 296.0, 316.0):
        vector_arrow(c, tx, 137.0, tx, sub_y0 - 7.0, color="accent_warm", width=1.45, size="sm")
    c.text(296.0, 113.0, "Prescribed traction", cls="fm-note", fill="accent_warm", anchor="middle", size=9.6)
    c.math_text(296.0, 128.0, format_math("\\mathbf{σ}^{tot}·\\hat{n} = \\mathbf{t}_0"), fill="accent_warm", size=10.2, anchor="middle")

    # Mini cubic ramp profile inset above absorbing collar
    rx0, rx1 = 348.0, 446.0
    ry_bot, ry_top = 156.0, 118.0
    c.line(rx0, ry_bot, rx1, ry_bot, stroke="axis", stroke_width=0.95)
    c.line(rx0, ry_bot, rx0, ry_top, stroke="axis", stroke_width=0.95)
    ramp_pts = [
        (rx0 + (rx1 - rx0) * (k / 40.0), ry_bot - 34.0 * ((k / 40.0) ** 3))
        for k in range(41)
    ]
    c.polygon(ramp_pts + [(rx1, ry_bot), (rx0, ry_bot)], fill="flux_soft", fill_opacity=0.65)
    c.path(curve_path(ramp_pts), stroke="flux", stroke_width=1.75)
    c.text(397.0, 78.0, "Absorbing collar", cls="fm-note", fill="flux", anchor="middle", size=9.8)
    c.text(397.0, 92.0, "ABL / ADE CFS-PML", cls="fm-note", fill="flux", anchor="middle", size=9.4)
    c.math_text(397.0, 111.0, format_math("α_M, d_j ∝ (ξ/L)^p"), fill="flux", size=9.6, anchor="middle")

    # Left boundary: Lysmer-Kuhlemeyer local viscous impedance
    c.line(sub_x0, sub_y0, sub_x0, sub_y1, stroke="H", stroke_width=2.4)
    _draw_dashpot(c, sub_x0, 190.0, color="H")
    _draw_dashpot(c, sub_x0, 226.0, color="H")
    c.text(96.0, 188.0, "Lysmer–", cls="fm-note", fill="H", anchor="end", size=9.8)
    c.text(96.0, 201.0, "Kuhlemeyer", cls="fm-note", fill="H", anchor="end", size=9.8)
    c.math_text(96.0, 218.0, format_math("\\mathbf{σ}·\\hat{n} = −\\mathbf{Z}_{LK}\\mathbf{u\u0307}"), fill="H", size=9.4, anchor="end")
    c.text(96.0, 238.0, "(local SPD)", cls="fm-note", fill="ink_muted", anchor="end", size=9.1)

    # Clamped bottom boundary with ground hatch marks
    c.line(sub_x0, sub_y1, abs_x1, sub_y1, stroke="ink", stroke_width=2.0)
    for hx in range(int(sub_x0) + 6, int(abs_x1), 13):
        c.line(hx, sub_y1, hx - 6.0, sub_y1 + 7.5, stroke="axis", stroke_width=0.95)
    c.text(
        0.5 * (sub_x0 + abs_x1),
        274.0,
        "Clamped base:  " + math_span(format_math("\\mathbf{u} = \\mathbf{0},   \\mathbf{u\u0307} = \\mathbf{0}")),
        cls="fm-sub",
        size=10.4,
        anchor="middle",
        raw_markup=True,
    )

    # Lower physics summary block (interface jump + ABL vs ADE CFS-PML)
    c.line(22.0, 290.0, 454.0, 290.0, stroke="hairline", stroke_width=0.75, opacity=0.65)
    c.text(
        22.0,
        310.0,
        "FM / NM interface continuity (" + math_span(format_math("Γ_{FM/NM}")) + ")",
        cls="fm-label-bold",
        fill="accent_violet",
        size=10.8,
        raw_markup=True,
    )
    c.math_text(
        22.0,
        332.0,
        format_math("⟦\\mathbf{u}⟧ = \\mathbf{0},     ⟦\\mathbf{σ}^{tot}·\\hat{n}⟧ = \\mathbf{0}"),
        fill="ink",
        size=11.4,
    )
    c.math_text(
        22.0,
        354.0,
        format_math("⇒   ⟦(\\mathbf{σ}^{el}+\\mathbf{σ}^{visc})·\\hat{n}⟧ = −⟦(\\mathbf{σ}^{mel}+\\mathbf{σ}^{rot})·\\hat{n}⟧"),
        fill="accent_violet",
        size=10.5,
    )
    c.text(
        22.0,
        375.0,
        "Fresnel acoustic transmission (YIG/GGG):  "
        + math_span(format_math("T_P = \\mathrm{4}Z_1Z_2/(Z_1+Z_2)^2 = \\mathrm{0.9857}")),
        cls="fm-note",
        size=9.9,
        raw_markup=True,
    )

    c.line(22.0, 391.0, 454.0, 391.0, stroke="hairline", stroke_width=0.75, opacity=0.65)
    c.text(22.0, 412.0, "Rayleigh ABL:", cls="fm-label-bold", fill="H", size=10.0)
    c.text(
        106.0,
        412.0,
        "Unconditionally stable (7 classes) · " + math_span(format_math("L_{ABL} ≥ \\mathrm{2–3}\u2009λ_{max}")),
        cls="fm-sub",
        size=10.0,
        raw_markup=True,
    )
    c.text(22.0, 433.0, "ADE CFS-PML:", cls="fm-label-bold", fill="flux", size=10.0)
    c.text(
        106.0,
        433.0,
        "Compact "
        + math_span(format_math("L_{PML} ≈ \\mathrm{0.8}\u2009λ_{max}, R_0 ∼ \\mathrm{10}^{−6}"))
        + " · guard "
        + math_span(format_math("s_j v_{g,j} ≥ \\mathrm{0}")),
        cls="fm-sub",
        size=10.0,
        raw_markup=True,
    )
    c.text(
        22.0,
        456.0,
        "Quasistatic free bodies: multi-component Fredholm RBM nullspace ("
        + math_span(format_math("d_{null} ≤ \\mathrm{6}\u2009N_{free}"))
        + ")",
        cls="fm-note",
        size=9.9,
        raw_markup=True,
    )

    # ===== PANEL B: SPATIAL MESHING COMPARISON (FDM STAGGERED VS FEM SUBMESH) =====
    panel_label(
        c,
        492,
        28,
        "b",
        title="Spatial discretization: FDM vs. FEM",
        subtitle="Staggered velocity–stress stencil vs. conforming SubMesh",
    )

    # ---- Left sub-figure: FDM Virieux / Lebedev cell ----
    c.text(598.0, 74.0, "FDM Virieux / Lebedev cell", cls="fm-label-bold", fill="H", size=10.6, anchor="middle")
    cx0, cy0, cw, ch = 542.0, 108.0, 110.0, 110.0
    cxm, cym = cx0 + 0.5 * cw, cy0 + 0.5 * ch

    c.rect(cx0, cy0, cw, ch, fill="fm_fill", fill_opacity=0.42, stroke="hairline", stroke_width=1.1, dash="4,3")
    c.line(cxm, cy0, cxm, cy0 + ch, stroke="grid", stroke_width=0.9)
    c.line(cx0, cym, cx0 + cw, cym, stroke="grid", stroke_width=0.9)

    # Cell center (i, k): normal stresses + magnetization m
    c.circle(cxm, cym, 5.2, fill="m", stroke="surface_ref", stroke_width=1.3)
    spin_arrow(c, cxm - 24.0, cym - 24.0, 68.0, length=16.0, color="m", width=1.6, size="sm")
    c.math_text(cxm - 37.0, cym - 24.0, format_math("\\mathbf{m}"), fill="m", size=10.0, anchor="end")
    c.math_text(cxm, cym + 20.0, format_math("σ_{xx}, σ_{zz}, \\mathbf{m}"), fill="m", size=10.0, anchor="middle", halo=True)
    c.math_text(cxm, cym + 38.0, format_math("(i, k)"), fill="ink_muted", size=9.2, anchor="middle")

    # Face velocity nodes (squares in H)
    sq = 4.2
    for fx, fy in ((cx0, cym), (cx0 + cw, cym), (cxm, cy0), (cxm, cy0 + ch)):
        c.rect(fx - sq, fy - sq, 2.0 * sq, 2.0 * sq, fill="H", stroke="surface_ref", stroke_width=1.1, rx=1.0)
    c.math_text(cxm, cy0 - 11.0, format_math("v_z (i, k+½)"), fill="H", size=10.0, anchor="middle")
    c.math_text(cx0 + cw + 9.0, cym + 4.0, format_math("v_x"), fill="H", size=10.6, anchor="start")
    c.math_text(cx0 + cw + 9.0, cym + 20.5, format_math("(i+½, k)"), fill="ink_muted", size=8.8, anchor="start")

    # Corner / edge shear-stress nodes (diamonds in accent_violet)
    dm = 5.0
    for ex, ey in ((cx0, cy0), (cx0 + cw, cy0), (cx0, cy0 + ch), (cx0 + cw, cy0 + ch)):
        c.polygon(
            [(ex, ey - dm), (ex + dm, ey), (ex, ey + dm), (ex - dm, ey)],
            fill="accent_violet",
            stroke="surface_ref",
            stroke_width=1.0,
        )
    c.math_text(cx0 + cw + 9.0, cy0 + 4.0, format_math("σ_{xz}"), fill="accent_violet", size=10.6, anchor="start")
    c.math_text(cx0 + cw + 9.0, cy0 + 20.5, format_math("(i+½, k+½)"), fill="ink_muted", size=8.8, anchor="start")

    # Dimension brackets
    bracket_dim(c, cx0 - 8.0, cy0 + ch, cx0 - 8.0, cy0, label=format_math("Δz"), offset=-7.0, color="axis", label_offset=7.0)
    bracket_dim(c, cx0, cy0 + ch + 6.0, cx0 + cw, cy0 + ch + 6.0, label=format_math("Δx"), offset=8.0, color="axis", label_offset=11.0)

    # Compact stencil marker legend
    leg_y = 272.0
    c.circle(505.0, leg_y - 3.5, 3.6, fill="m")
    c.math_text(513.0, leg_y, format_math("σ_{ii}, \\mathbf{m}"), fill="ink_secondary", size=9.8)
    c.rect(565.0, leg_y - 7.0, 7.0, 7.0, fill="H", rx=1.0)
    c.math_text(576.0, leg_y, format_math("v_i"), fill="ink_secondary", size=9.8)
    c.polygon([(604.0, leg_y - 7.8), (608.2, leg_y - 3.5), (604.0, leg_y + 0.8), (599.8, leg_y - 3.5)], fill="accent_violet")
    c.math_text(613.0, leg_y, format_math("σ_{ij} \\mathrm{(edges)}"), fill="ink_secondary", size=9.8)

    # ---- Right sub-figure: FEM conforming SubMesh ----
    c.text(830.0, 74.0, "FEM conforming SubMesh", cls="fm-label-bold", fill="flux", size=10.6, anchor="middle")
    fx_cols = [736.0, 796.0, 856.0, 916.0]
    fy_rows = [96.0, 136.0, 180.0, 232.0]

    # Build slightly varied vertices while keeping horizontal interfaces strictly conforming
    fem_pts: list[list[tuple[float, float]]] = []
    for r_i, ry in enumerate(fy_rows):
        row: list[tuple[float, float]] = []
        for c_i, rx in enumerate(fx_cols):
            dx = 0.0
            if 0 < c_i < 3:
                dx = (5.0 if (r_i + c_i) % 2 == 0 else -5.0) if r_i != 2 else (3.0 if c_i == 1 else -3.0)
            row.append((rx + dx, ry))
        fem_pts.append(row)

    # Draw triangulated airbox (row 0), FM layer (row 1), and NM substrate (row 2)
    p2_tri: list[tuple[float, float]] = []
    for r_i in range(3):
        for c_i in range(3):
            p00 = fem_pts[r_i][c_i]
            p10 = fem_pts[r_i][c_i + 1]
            p01 = fem_pts[r_i + 1][c_i]
            p11 = fem_pts[r_i + 1][c_i + 1]
            tris = [
                [p00, p10, p11],
                [p00, p11, p01],
            ]
            for t_idx, poly in enumerate(tris):
                if r_i == 0:
                    c.polygon(poly, fill="air_fill", stroke="air_stroke", stroke_width=0.85, dash="3,2.5")
                elif r_i == 1:
                    c.polygon(poly, fill="fm_fill", stroke="fm_stroke", stroke_width=0.95)
                else:
                    if c_i == 1 and t_idx == 1:
                        p2_tri = poly
                        c.polygon(poly, fill="flux_soft", stroke="flux", stroke_width=1.55)
                    else:
                        c.polygon(poly, fill="hm_fill", stroke="hm_stroke", stroke_width=0.95)

    # SubMesh boundary (Omega_el = Omega_m union Omega_sub, excluding Omega_air)
    c.rect(
        fx_cols[0],
        fy_rows[1],
        fx_cols[-1] - fx_cols[0],
        fy_rows[-1] - fy_rows[1],
        fill="none",
        stroke="flux",
        stroke_width=1.75,
    )

    # Shared conforming interface Gamma_FM/NM with shared nodes
    c.line(fx_cols[0], fy_rows[2], fx_cols[-1], fy_rows[2], stroke="accent_violet", stroke_width=2.3)
    for vx, vy in fem_pts[2]:
        c.circle(vx, vy, 3.1, fill="accent_violet", stroke="surface_ref", stroke_width=1.0)

    # Highlight P2 quadratic element vertices + mid-edge nodes
    if p2_tri:
        for vx, vy in p2_tri:
            c.circle(vx, vy, 3.1, fill="flux", stroke="surface_ref", stroke_width=0.9)
        for idx in range(3):
            a = p2_tri[idx]
            b = p2_tri[(idx + 1) % 3]
            mx, my = 0.5 * (a[0] + b[0]), 0.5 * (a[1] + b[1])
            c.circle(mx, my, 2.6, fill="node_fill", stroke="flux", stroke_width=1.25)

    # Domain labels cleanly in right margin & inside airbox
    c.text(826.0, 120.0, "excluded airbox", cls="fm-note", fill="air_stroke", size=9.4, anchor="middle", halo=True)
    c.math_text(922.0, 119.0, format_math("Ω_{air}"), fill="air_stroke", size=9.8)
    c.math_text(922.0, 161.0, format_math("Ω_m"), fill="fm_stroke", size=10.2)
    c.math_text(922.0, 210.0, format_math("Ω_{sub}"), fill="hm_stroke", size=9.8)

    c.text(
        826.0,
        251.0,
        "SubMesh "
        + math_span(format_math("Ω_m ⊂ Ω_{el}"))
        + " (strips "
        + math_span(format_math("Ω_{air}"))
        + ", Pyramid5)",
        cls="fm-note",
        fill="flux",
        size=9.5,
        anchor="middle",
        raw_markup=True,
    )
    c.text(
        826.0,
        272.0,
        "Highlighted "
        + math_span(format_math("P_2"))
        + " cell (vertex + mid-edge DOFs)",
        cls="fm-note",
        fill="ink_secondary",
        size=9.5,
        anchor="middle",
        raw_markup=True,
    )

    # ---- Lower comparison table & numerical guarantees ----
    c.line(494.0, 290.0, 944.0, 290.0, stroke="hairline", stroke_width=0.75, opacity=0.65)
    c.line(716.0, 298.0, 716.0, 412.0, stroke="hairline", stroke_width=0.75, opacity=0.55)

    # Left column: FDM
    c.text(496.0, 310.0, "FDM staggered / Lebedev", cls="fm-label-bold", fill="H", size=10.4)
    fdm_notes = [
        "• Virieux: half-staggered (no checkerboard)",
        "• Lebedev 4-grid: full 21-const anisotropy",
        "• Interface: harm. shear + stabilizer " + math_span(format_math("θ_c")),
        "• Thin film (" + math_span(format_math("N_z = \\mathrm{1}")) + "): 2D plane-stress Schur",
        "• Mesh: " + math_span(format_math("h ≤ \\mathrm{0.5}\u2009ℓ_{ex}")) + ", PPW ≥ 12–16",
    ]
    for idx, line in enumerate(fdm_notes):
        c.text(496.0, 330.0 + idx * 19.0, line, cls="fm-note", fill="ink_secondary", size=9.6, raw_markup=True)

    # Right column: FEM
    c.text(728.0, 310.0, "FEM conforming SubMesh", cls="fm-label-bold", fill="flux", size=10.4)
    fem_notes = [
        "• " + _code_span("mfem::SubMesh", size=9.2) + " strips " + math_span(format_math("Ω_{air}")) + " &amp; Pyramid5",
        "• " + _code_span("FaceKey", size=9.2) + " hashes deterministic MPI BCs",
        "• Tet10 " + math_span(format_math("\\mathbf{B̄}")) + " (" + math_span(format_math("P_2/P_0")) + "): locking-free " + math_span(format_math("ν < \\mathrm{0.499}")),
        "• Prism6 MITC6+EAS-1: rank 12/18, 12-pt",
        "• Mesh: " + math_span(format_math("h ≤ ℓ_{ex}")) + " (" + math_span(format_math("P_2")) + "), PPW ≥ 6–8",
    ]
    for idx, line in enumerate(fem_notes):
        c.text(728.0, 330.0 + idx * 19.0, line, cls="fm-note", fill="ink_secondary", size=9.6, raw_markup=True)

    c.line(494.0, 421.0, 944.0, 421.0, stroke="hairline", stroke_width=0.75, opacity=0.65)
    c.text(
        496.0,
        441.0,
        "Staggered symbol:  "
        + math_span(format_math("D̂_x^{stag}(k_x) = (\\mathrm{2}i/Δx)\u2009\\mathrm{sin}(k_x Δx / \\mathrm{2}) ≠ \\mathrm{0}"))
        + "  at Nyquist",
        cls="fm-note",
        size=9.8,
        raw_markup=True,
    )
    c.text(
        496.0,
        460.0,
        "Tet4 fails closed at "
        + math_span(format_math("ν_{eff} ≥ \\mathrm{0.48}"))
        + " · 12-pt "
        + _code_span("IntRules(PRISM, 3)", size=9.2)
        + " eliminates 1.85% cubic error",
        cls="fm-note",
        size=9.8,
        raw_markup=True,
    )


# ---------------------------------------------------------------------------
# 9. magnetoelastic-magnon-phonon-dispersion-and-solvers
# ---------------------------------------------------------------------------


def _solve_magnon_phonon_dispersion(
    *,
    w0: float = 0.72,
    d_ex: float = 0.28,
    kappa: float = 0.052,
    k_max: float = 1.65,
    n_pts: int = 240,
) -> tuple[list[float], list[float], list[float], list[float], list[float]]:
    """Solve exact Kittel secular cubic (w - w_m(k))(w^2 - k^2) = kappa * k^2 for w_+(k), w_-(k).

    Dimensionless units normalized to the bare crossing ``(k_x = 1, w_x = 1)``:
    ``w_m(k) = w0 + d_ex * k^2`` with ``w0 + d_ex = 1``, and bare TA phonon ``w_ph(k) = k``.
    """
    ks = [k_max * i / (n_pts - 1) for i in range(n_pts)]
    wm: list[float] = []
    wph: list[float] = []
    w_plus: list[float] = []
    w_minus: list[float] = []

    def bisect(fn, lo: float, hi: float) -> float:
        flo = fn(lo)
        for _ in range(64):
            mid = 0.5 * (lo + hi)
            fmid = fn(mid)
            if (flo <= 0.0 and fmid <= 0.0) or (flo >= 0.0 and fmid >= 0.0):
                lo, flo = mid, fmid
            else:
                hi = mid
        return 0.5 * (lo + hi)

    for k in ks:
        w_m = w0 + d_ex * k * k
        w_p = k
        wm.append(w_m)
        wph.append(w_p)
        if k <= 1e-12:
            w_minus.append(0.0)
            w_plus.append(w_m)
            continue

        def poly(w: float) -> float:
            return (w - w_m) * (w * w - k * k) - kappa * k * k

        lo_branch = bisect(poly, 0.0, min(w_m, w_p))
        hi_start = max(w_m, w_p)
        hi_end = hi_start + 0.5
        while poly(hi_end) <= 0.0:
            hi_end += 0.5
        hi_branch = bisect(poly, hi_start, hi_end)
        w_minus.append(lo_branch)
        w_plus.append(hi_branch)

    return ks, wm, wph, w_plus, w_minus


def draw_magnetoelastic_dispersion_solvers(c: SvgCanvas, t: Theme) -> None:
    """Two-panel figure: exact magnon-phonon avoided crossing (a) and coupled 4-lane HPC stack (b)."""
    panel_divider(c, 474, 18, 474, 468)

    # ===== PANEL A: EXACT MAGNON-PHONON AVOIDED CROSSING DISPERSION =====
    panel_label(
        c,
        20,
        28,
        "a",
        title="Magnon–phonon avoided crossing",
        subtitle="Exact hybridized branches "
        + math_span(format_math("ω_±(k)"))
        + " &amp; magnetoelastic polaron gap "
        + math_span(format_math("Δω_{me}")),
        subtitle_markup=True,
    )

    ks, wm, wph, w_plus, w_minus = _solve_magnon_phonon_dispersion()
    # Exact values right at crossing k/k_x = 1.0
    _, _, _, wp_x_list, wm_x_list = _solve_magnon_phonon_dispersion(k_max=1.0, n_pts=2)
    wp_cross = wp_x_list[-1]
    wm_cross = wm_x_list[-1]

    pf = axes_2d(
        c,
        68.0,
        72.0,
        378.0,
        222.0,
        xlim=(0.0, 1.65),
        ylim=(0.0, 1.78),
        xlabel=format_math("k / k_{×}"),
        ylabel=format_math("ω / ω_{×}"),
        xticks=(0.0, 0.5, 1.0, 1.5),
        xtick_labels=("0", "0.5", math_span(format_math("k_{×}")), "1.5"),
        yticks=(0.0, 0.5, 1.0, 1.5),
        ytick_labels=("0", "0.5", math_span(format_math("ω_{×}")), "1.5"),
        grid=True,
        arrow_axes=True,
        xlabel_offset=28.0,
        ylabel_offset=38.0,
    )

    # Shaded magnetoelastic polaron hybridization band around k_x
    pf.fill_between([0.82, 1.18], [1.78, 1.78], 0.0, fill="accent_warm", opacity=0.08)
    pf.vline(1.0, color="hairline", width=0.95, dash="3,3")
    c.line(pf.px(0.0), pf.py(1.0), pf.px(1.0), pf.py(1.0), stroke="hairline", stroke_width=0.9, dash="3,3")

    # Bare uncoupled dispersions (dashed) and exact hybridized branches (solid)
    pf.plot_curve(ks, wm, color="m", width=1.45, dash="5,3.5", opacity=0.82)
    pf.plot_curve(ks, wph, color="H", width=1.45, dash="5,3.5", opacity=0.82)
    pf.plot_curve(ks, w_plus, color="accent_violet", width=2.35)
    pf.plot_curve(ks, w_minus, color="flux", width=2.35)

    # Key physical markers: FMR gap omega_0 at k=0 and hybridized gap vertices at k=k_x
    pf.scatter([0.0], [0.72], r=3.2, fill="m")
    pf.scatter([1.0], [wp_cross], r=3.3, fill="accent_violet")
    pf.scatter([1.0], [wm_cross], r=3.3, fill="flux")
    c.math_text(pf.px(0.05), pf.py(0.81), format_math("ω_0"), fill="m", size=10.8, halo=True)

    # Polaron anticrossing gap double arrow & clean callout in open lower-right wedge
    gap_mid_w = 0.5 * (wp_cross + wm_cross)
    vector_arrow(
        c,
        pf.px(1.0),
        pf.py(wm_cross) - 4.5,
        pf.px(1.0),
        pf.py(wp_cross) + 4.5,
        color="accent_warm",
        width=1.75,
        size="sm",
        double=True,
    )
    c.polyline(
        [
            (pf.px(1.015), pf.py(gap_mid_w)),
            (pf.px(1.13), pf.py(0.64)),
            (pf.px(1.18), pf.py(0.64)),
        ],
        stroke="accent_warm",
        stroke_width=1.1,
        opacity=0.88,
    )
    c.circle(pf.px(1.015), pf.py(gap_mid_w), 2.1, fill="accent_warm")
    c.math_text(
        pf.px(1.20),
        pf.py(0.61),
        format_math("Δω_{me}"),
        fill="accent_warm",
        size=11.8,
        halo=True,
    )

    # Direct clean branch labels in wide open wedges
    c.math_text(pf.px(1.30), pf.py(1.58), format_math("ω_+(k)"), fill="accent_violet", size=10.8, anchor="end", halo=True)
    c.math_text(pf.px(1.49), pf.py(1.05), format_math("ω_−(k)"), fill="flux", size=10.8, anchor="middle", halo=True)
    c.math_text(pf.px(0.32), pf.py(0.14), format_math("ω_{ph} = c_t k"), fill="H", size=9.8, halo=True)

    # Minimalist borderless legend in the wide-open upper-left quadrant (generous row gap)
    legend_strip(
        c,
        78.0,
        86.0,
        [
            (math_span(format_math("ω_+(k)")) + " upper polaron", "accent_violet", "solid"),
            (math_span(format_math("ω_−(k)")) + " lower polaron", "flux", "solid"),
            (math_span(format_math("ω_m = ω_0 + D_{ex}k^2")), "m", "dashed"),
            (math_span(format_math("ω_{ph} = c_t k")) + " (TA)", "H", "dashed"),
        ],
        horizontal=False,
        row_gap=20.5,
    )

    # Lower eigenproblem, congruence scaling & Benchmark G5 oracle summary
    c.line(22.0, 342.0, 454.0, 342.0, stroke="hairline", stroke_width=0.75, opacity=0.65)
    c.text(22.0, 362.0, "Coupled linearized eigenpencil & congruence scaling", cls="fm-label-bold", size=10.6)
    c.math_text(
        22.0,
        385.0,
        format_math("\\mathbf{S}\\mathbf{A}\\mathbf{S}\u2009\\mathbf{x} = λ\u2009\\mathbf{S}\\mathbf{B}\\mathbf{S}\u2009\\mathbf{x},    \\mathbf{x} = (\\mathbf{ξ}, δ\\mathbf{u}, δ\\mathbf{v})^T"),
        fill="accent_violet",
        size=11.0,
    )
    c.text(
        22.0,
        407.0,
        "Diagonal "
        + math_span(format_math("\\mathbf{S}"))
        + " equilibrates "
        + math_span(format_math("\\mathrm{10}^5–\\mathrm{10}^{11}"))
        + " elastic/magnetic stiffness contrast",
        cls="fm-sub",
        size=10.0,
        raw_markup=True,
    )
    c.text(
        22.0,
        429.0,
        "YIG G5 oracle ("
        + math_span(format_math("f_{×} = \\mathrm{5.0}\u2009\\mathrm{GHz}"))
        + "):  "
        + math_span(format_math("Δf_{1D} = \\mathrm{79.63}\u2009\\mathrm{MHz},  Δf_{3D} = \\mathrm{112.62}\u2009\\mathrm{MHz}")),
        cls="fm-note",
        fill="flux",
        size=9.9,
        raw_markup=True,
    )
    c.text(
        22.0,
        451.0,
        "SLEPc "
        + _code_span("EPS_GNHEP", size=9.2)
        + " ("
        + _code_span("STSINVERT", size=9.2)
        + ") · MUMPS exact inertia · FDM 1D-"
        + math_span(format_math("z"))
        + " Bloch",
        cls="fm-note",
        size=9.8,
        raw_markup=True,
    )

    # ===== PANEL B: COUPLED TIME-STEPPING & 4-LANE HPC SOLVER STACK =====
    panel_label(
        c,
        492,
        28,
        "b",
        title="Coupled time-stepping & 4-lane HPC stack",
        subtitle="Explicit leapfrog/RK4 vs. IMEX-ARK2 across FDM & FEM lanes",
    )

    # Bidirectional time-stepping coupling loop
    ny = 98.0
    flow_node(
        c,
        494.0,
        ny,
        190.0,
        76.0,
        "Spin step (" + math_span(format_math("\\mathbf{m}^n → \\mathbf{m}^{n+1}")) + ")",
        subtitle=[
            "Explicit RK4 / RK45 (FSAL)",
            "Cubic Hermite " + math_span(format_math("\\mathbf{m}_H(s)")) + " multirate",
        ],
        accent="m",
        title_size=10.5,
        sub_size=9.3,
        title_markup=True,
        sub_markup=True,
    )
    flow_node(
        c,
        750.0,
        ny,
        192.0,
        76.0,
        "Elastic step (" + math_span(format_math("\\mathbf{u}^n, \\mathbf{v}^n")) + ")",
        subtitle=[
            "IMEX-ARK2 / HEVI-" + math_span(format_math("z")) + " · Gen-" + math_span(format_math("α")),
            "Leapfrog Verlet (" + math_span(format_math("Δt_{CFL}, Δt_{visc}")) + ")",
        ],
        accent="H",
        title_size=10.5,
        sub_size=9.3,
        title_markup=True,
        sub_markup=True,
    )

    # Top curved coupling arrow (strain -> spins)
    curved_arrow(c, 808.0, ny - 3.0, 717.0, ny - 28.0, 626.0, ny - 3.0, color="H", width=1.9, size="md")
    c.math_text(
        717.0,
        ny - 29.0,
        format_math("\\mathbf{H}_{mel}(\\mathbf{ε}^n) + \\mathbf{H}_{rot}(\\mathbf{ω}^n)"),
        fill="H",
        size=10.5,
        anchor="middle",
    )

    # Bottom curved coupling arrow (spins -> back-action stress)
    curved_arrow(c, 626.0, ny + 79.0, 717.0, ny + 104.0, 808.0, ny + 79.0, color="accent_violet", width=1.9, size="md", dash="5,3")
    c.math_text(
        717.0,
        ny + 109.0,
        format_math("\\mathbf{σ}^{mel}(\\mathbf{m}^n) + \\mathbf{σ}^{rot}(\\mathbf{m}^n)"),
        fill="accent_violet",
        size=10.5,
        anchor="middle",
    )

    # Concise multirate indicator between nodes (generous clearance below subscript)
    c.math_text(717.0, ny + 31.0, format_math("N_{sub}"), fill="ink_secondary", size=10.2, anchor="middle")
    c.text(717.0, ny + 51.0, "loop", cls="fm-note", fill="ink_muted", size=9.4, anchor="middle")

    c.text(
        718.0,
        226.0,
        "Explicit leapfrog/RK4 vs. IMEX-ARK2 / Gen-"
        + math_span(format_math("α"))
        + " (stiff thin-film "
        + math_span(format_math("Δz"))
        + " &amp; viscosity)",
        cls="fm-note",
        size=9.7,
        anchor="middle",
        raw_markup=True,
    )

    # 4-lane HPC solver & pinned external library stack (2x2 architectural grid)
    c.line(494.0, 238.0, 942.0, 238.0, stroke="hairline", stroke_width=0.75, opacity=0.65)
    c.text(494.0, 255.0, "Four-lane HPC solver & pinned library stack", cls="fm-label-bold", size=10.6)

    flow_node(
        c,
        494.0,
        265.0,
        216.0,
        86.0,
        "FDM · CPU (AVX-512 + MPI)",
        subtitle=[
            "AVX-512 64×8×8 SoA cache tiles",
            "Virieux / Lebedev · HEVI IMEX-" + math_span(format_math("z")),
            "oneMKL PARDISO · MPI 2D pencil",
        ],
        accent="H",
        align="left",
        title_size=10.3,
        sub_size=9.5,
        sub_markup=True,
    )
    flow_node(
        c,
        724.0,
        265.0,
        218.0,
        86.0,
        "FDM · GPU (CUDA + MPI)",
        subtitle=[
            "CUDA 3.5D ping-pong SMEM",
            "Zero-transfer GPU residency",
            "cuDSS · SpectralZThomas · cuFFT",
        ],
        accent="flux",
        align="left",
        title_size=10.3,
        sub_size=9.5,
    )
    flow_node(
        c,
        494.0,
        363.0,
        216.0,
        86.0,
        "FEM · CPU (MFEM + MPI)",
        subtitle=[
            "oneMKL PARDISO (" + _code_span("mkl_gnu_thread", size=8.8) + ")",
            "MUMPS exact inertia · SLEPc",
            "MFEM SubMesh · ParMETIS (" + math_span(format_math("n_{con} = \\mathrm{3}")) + ")",
        ],
        accent="accent_violet",
        align="left",
        title_size=10.3,
        sub_size=9.5,
        sub_markup=True,
    )
    flow_node(
        c,
        724.0,
        363.0,
        218.0,
        86.0,
        "FEM · GPU (CUDA + MPI)",
        subtitle=[
            "cuDSS Frozen-Factor PCG + Graph",
            "libCEED PA + Hypre BoomerAMG",
            "CudssModalShift · SLEPc GNHEP",
        ],
        accent="accent_warm",
        align="left",
        title_size=10.3,
        sub_size=9.5,
    )

    c.text(
        718.0,
        469.0,
        "FP64 sparse direct & eigen solves · C ABI v1 capability bitmasks · G1–G8 oracles",
        cls="fm-note",
        size=9.7,
        anchor="middle",
    )


# ---------------------------------------------------------------------------
# Public generator registry
# ---------------------------------------------------------------------------


def generate_all(out_dir: Path | str = DEFAULT_DIAGRAMS_DIR) -> list[tuple[Path, Path]]:
    """Generate all 9 local-interaction & multiphysics diagram pairs (18 SVGs: Light + Dark)."""
    specs = (
        (
            "anisotropy-uniaxial-and-cubic-landscapes",
            draw_anisotropy,
            960,
            470,
            "Magnetocrystalline Anisotropy Energy Landscapes: Uniaxial and Cubic Conventions",
            "Two-panel scientific figure comparing (a) uniaxial polar excess energy curves for easy-axis, easy-plane, and easy-cone regimes plus the scalar energy offset between -K_u1 cos^2(theta) and K_u1 sin^2(theta), and (b) exact (001)-plane and (1-10)-plane cubic anisotropy profiles for K_c1 > 0 (<100> easy) and K_c1 < 0 (<111> easy).",
        ),
        (
            "dmi-three-variants-chirality",
            draw_dmi_variants,
            960,
            474,
            "Dzyaloshinskii-Moriya Interaction Variants and Chiral Spin Textures",
            "Three-panel scientific comparison of FullMag's three non-aliasing DMI variants: (a) interfacial C_nv DMI stabilizing a 1D Néel cycloid and 2D Néel skyrmion, (b) isotropic B20 bulk DMI stabilizing a 1D Bloch helix and 2D Bloch skyrmion, and (c) rotated interfacial DMI stabilizing an in-plane Göbel 2019 bimeron.",
        ),
        (
            "dmi-boundary-canting-and-normals",
            draw_dmi_boundary,
            960,
            462,
            "Chiral DMI Boundary Canting and Natural Boundary Laws",
            "Two-panel scientific figure showing (a) the numerically solved Rohart-Thiaville chiral edge canting profile m_z(x) across an open nanostrip under 2A d_nu m + D[(n_hat x nu) x m] = 0 with decay length Delta = sqrt(A/K_eff), and (b) FDM fixed +z ghost closure versus FEM general normalized normal n_hat and all three natural DMI boundary laws.",
        ),
        (
            "zeeman-energy-and-precession",
            draw_zeeman,
            960,
            432,
            "Zeeman Interaction: Larmor Precession, Cosine Potential, and Source Contracts",
            "Two-panel scientific figure showing (a) the 3D Larmor precession cone, damped RK4 helical relaxation on S^2, and exact cosine Zeeman energy well w_Z(theta) = -mu_0 M_s H_ext cos(theta), and (b) FullMag's non-aliasing prescribed field-source contracts for uniform Zeeman, StaticFieldMap, and RegionalFieldDrive / MaskAntenna.",
        ),
        (
            "oersted-cylinder-and-biot-savart",
            draw_oersted,
            960,
            462,
            "Oersted Field Families: Analytic Cylindrical Wire and Biot-Savart / Vector Potential",
            "Two-panel scientific figure comparing (a) OerstedCylinder wire cross-section, azimuthal right-hand-rule field, and exact piecewise radial profile |H_phi(rho)|/H_peak peaking at rho = R, and (b) 3D Biot-Savart current element geometry, integral formula, and conservative RT0 closure feeding OE-F1 direct quadrature and OE-F2 H(curl) vector-potential solves.",
        ),
        (
            "thermal-brown-stochastic-llg",
            draw_thermal,
            960,
            464,
            "Thermal Brown Stochastic LLG Dynamics and Boltzmann Equilibrium Validation",
            "Two-panel scientific figure showing (a) numerical Stratonovich Heun stochastic LLG trajectories and ensemble mean versus deterministic relaxation, fluctuation-dissipation amplitude with bare gamma_mu0, and rejected-step raw-draw reuse, and (b) exact Boltzmann equilibrium density P_eq(theta) against ensemble 95% confidence intervals.",
        ),
        (
            "magnetoelastic-voigt-strain-coupling",
            draw_magnetoelastic,
            960,
            476,
            "Magnetoelastic Voigt Strain Modes and Bidirectional Magnon-Phonon Coupling",
            "Two-panel scientific figure showing (a) normal (B_1) and shear (B_2) deformed cubic unit cells, the 6-component engineering-Voigt vector with gamma_ij = 2 epsilon_ij, and cubic magnetoelastic energy/field laws, and (b) bidirectional magnon-phonon coupling between LLG magnetization m (driven by H_mel + H_rot) and elastodynamic displacement u (driven by back-action stresses sigma^me + sigma^rot).",
        ),
        (
            "magnetoelastic-boundary-conditions-and-meshing",
            draw_magnetoelastic_bc_meshing,
            960,
            486,
            "Magnetoelastic Boundary Conditions, Interface Continuity, and FDM vs FEM Spatial Meshing",
            "Two-panel scientific figure showing (a) multi-domain FM/NM mechanical boundary conditions including traction-free top surface, prescribed IDT traction, clamped base, Lysmer-Kuhlemeyer local impedance, Rayleigh ABL vs ADE CFS-PML absorbing collar, and FM/NM interface total-traction continuity, and (b) spatial meshing comparison between the staggered FDM Virieux/Lebedev velocity-stress stencil and conforming FEM SubMesh (Omega_m subset Omega_el, stripping Omega_air) with quadratic P2/locking-free elements.",
        ),
        (
            "magnetoelastic-magnon-phonon-dispersion-and-solvers",
            draw_magnetoelastic_dispersion_solvers,
            960,
            486,
            "Magnetoelastic Magnon-Phonon Avoided Crossing and Four-Lane HPC Solver Architecture",
            "Two-panel scientific figure showing (a) the exact analytically computed magnon-phonon avoided crossing dispersion omega_pm(k) hybridizing the bare spin-wave branch omega_m(k) = omega_0 + D_ex k^2 and transverse acoustic phonon omega_ph(k) = c_t k with polaron gap Delta omega_me plus coupled congruence-scaled eigenpencil and YIG G5 oracles, and (b) the bidirectional spin-elastic time-stepping loop (explicit leapfrog/RK4 vs IMEX-ARK2/Generalized-alpha) mapped across all four FDM/FEM CPU/GPU HPC solver lanes.",
        ),
    )

    pairs: list[tuple[Path, Path]] = []
    for slug, draw_fn, width, height, title, desc in specs:
        pairs.append(
            write_themed_svg(
                slug,
                draw_fn,
                width=width,
                height=height,
                title=title,
                desc=desc,
                out_dir=out_dir,
            )
        )
    return pairs


if __name__ == "__main__":
    written = generate_all()
    print(f"Generated {len(written)} local-interaction diagram pairs ({len(written) * 2} SVGs).")
