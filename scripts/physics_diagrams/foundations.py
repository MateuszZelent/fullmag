"""Publication-grade dual-theme SVG generators for FullMag foundational & architecture diagrams.

Generates 7 figures (14 SVGs: Light + Dark) in a minimalist Nature / Physical Review B / AIP style:
  1. fullmag-object-interaction-architecture
  2. geometry-regions-materials-realization
  3. interactions-taxonomy-energy-vs-torque
  4. llg-precession-damping-sphere
  5. effective-field-and-direct-torque-composition
  6. micromagnetic-boundary-conditions-overview
  7. observables-materialization-pipeline
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Sequence

import numpy as np
from scipy.spatial import Delaunay

from .primitives import (
    DEFAULT_DIAGRAMS_DIR,
    SvgCanvas,
    axes_2d,
    bracket_dim,
    curve_path,
    curved_arrow,
    esc,
    hat,
    layer_slab,
    legend_strip,
    math_span,
    panel_divider,
    panel_label,
    rk4_integrate,
    roman,
    sphere_curve,
    sphere_vector,
    spin_arrow,
    sub,
    sup,
    sym,
    tangent_plane_patch,
    unit_sphere,
    vec,
    vector_arrow,
    write_themed_svg,
)
from .theme import FONT_MATH, FONT_MONO, FONT_SANS, Theme


# ---------------------------------------------------------------------------
# Small internal typography & geometry helpers
# ---------------------------------------------------------------------------


def _ms(markup: str, *, bold: bool = False, italic: bool = True) -> str:
    """Short alias for embedding math-serif markup inside sans-serif strings."""
    return math_span(markup, bold=bold, italic=italic)


def _code(text: str) -> str:
    """Inline monospace <tspan> for exact API identifiers."""
    return f'<tspan font-family="{esc(FONT_MONO)}" font-size="92%" font-weight="500">{esc(text)}</tspan>'


def _hairline_box(
    c: SvgCanvas,
    x: float,
    y: float,
    w: float,
    h: float,
    *,
    accent: str | None = None,
    accent_bar: str = "left",
    fill: str = "node_fill",
    stroke: str = "node_stroke",
    rx: float = 3.0,
    dash: str | None = None,
) -> None:
    """Draw a minimalist hairline schematic container (zero drop shadow)."""
    c.rect(x, y, w, h, fill=fill, stroke=stroke, stroke_width=0.95, rx=rx, dash=dash)
    if accent:
        if accent_bar == "left":
            c.line(x + 1.3, y + 3.0, x + 1.3, y + h - 3.0, stroke=accent, stroke_width=2.5, linecap="round")
        elif accent_bar == "top":
            c.line(x + 3.0, y + 1.3, x + w - 3.0, y + 1.3, stroke=accent, stroke_width=2.2, linecap="round")


def _top_rule_header(
    c: SvgCanvas,
    x: float,
    y: float,
    w: float,
    letter: str,
    title: str,
    *,
    accent: str = "ink",
    subtitle: str | None = None,
    title_markup: bool = False,
    subtitle_markup: bool = False,
    subtitle_dy: float = 19.5,
) -> None:
    """Nature-style bare panel letter + title with a delicate top accent hairline."""
    c.line(x, y - 14.0, x + w, y - 14.0, stroke=accent, stroke_width=1.6, linecap="round")
    panel_label(
        c,
        x,
        y,
        letter,
        title,
        title_markup=title_markup,
    )
    if subtitle:
        c.text(
            x + 17.0,
            y + subtitle_dy,
            subtitle,
            cls="fm-note",
            raw_markup=subtitle_markup,
        )


def _solve_rohart_thiaville_1d(
    length_over_delta: float = 7.0,
    delta_over_ldmi: float = 0.56,
    n_pts: int = 121,
) -> tuple[np.ndarray, np.ndarray]:
    """Solve exact 1D Rohart-Thiaville edge canting BVP on u = x/Delta in [-L/2D, +L/2D].

    ODE: d^2 theta / du^2 = sin(theta) cos(theta)
    BC:  d theta / du |_{u = +-L/(2 Delta)} = delta_over_ldmi
    """
    half = 0.5 * length_over_delta
    u = np.linspace(-half, half, n_pts)
    du = u[1] - u[0]
    # Analytic small-angle initial guess
    theta = delta_over_ldmi * np.sinh(u) / np.cosh(half)
    # Damped Newton-Raphson iterations on second-order central finite differences
    for _ in range(25):
        res = np.zeros(n_pts)
        jac = np.zeros((n_pts, n_pts))
        # Interior points: (theta_{i-1} - 2 theta_i + theta_{i+1}) / du^2 - 0.5 sin(2 theta_i) = 0
        for i in range(1, n_pts - 1):
            res[i] = (theta[i - 1] - 2.0 * theta[i] + theta[i + 1]) / (du * du) - 0.5 * math.sin(2.0 * theta[i])
            jac[i, i - 1] = 1.0 / (du * du)
            jac[i, i] = -2.0 / (du * du) - math.cos(2.0 * theta[i])
            jac[i, i + 1] = 1.0 / (du * du)
        # Second-order ghost-point Neumann BCs:
        # Left (i=0): theta_{-1} = theta_1 - 2*du*s => 2*(theta_1 - theta_0 - du*s)/du^2 - 0.5*sin(2*theta_0) = 0
        s = delta_over_ldmi
        res[0] = 2.0 * (theta[1] - theta[0] - du * s) / (du * du) - 0.5 * math.sin(2.0 * theta[0])
        jac[0, 0] = -2.0 / (du * du) - math.cos(2.0 * theta[0])
        jac[0, 1] = 2.0 / (du * du)
        # Right (i=-1): theta_{n} = theta_{n-2} + 2*du*s => 2*(theta_{n-2} - theta_{n-1} + du*s)/du^2 - 0.5*sin(2*theta_{n-1}) = 0
        res[-1] = 2.0 * (theta[-2] - theta[-1] + du * s) / (du * du) - 0.5 * math.sin(2.0 * theta[-1])
        jac[-1, -2] = 2.0 / (du * du)
        jac[-1, -1] = -2.0 / (du * du) - math.cos(2.0 * theta[-1])
        step = np.linalg.solve(jac, -res)
        theta += step
        if float(np.max(np.abs(step))) < 1e-12:
            break
    return u, theta


# ---------------------------------------------------------------------------
# 1. fullmag-object-interaction-architecture
# ---------------------------------------------------------------------------


def draw_architecture(c: SvgCanvas, t: Theme) -> None:
    """Canonical FullMag authoring -> physics modules -> ProblemIR -> four-lane execution."""
    # Column headers (bare bold Nature panel letters + understated titles)
    panel_label(c, 12, 24, "a", "Study & scene objects")
    panel_label(c, 266, 24, "b", "Explicit physics modules")
    panel_label(c, 536, 24, "c", "ProblemIR & planner gate")
    panel_label(c, 774, 24, "d", "Execution lanes & outputs")

    # Subtle column header underlines
    for x0, x1, col in (
        (12, 236, "H"),
        (266, 506, "flux"),
        (536, 744, "accent_violet"),
        (774, 968, "m"),
    ):
        c.line(x0, 33, x1, 33, stroke=col, stroke_width=1.3, opacity=0.75)

    # ---- Column a: Study & scene objects (x=12..236, w=224) ----
    _hairline_box(c, 12, 46, 224, 54, accent="H")
    c.text(24, 65, "fm.study(name)", cls="fm-code", fill="H", weight=600)
    c.text(24, 81, "study.engine · device · mode", cls="fm-code", size=9.8)
    c.text(24, 94, "Target intent only; no implicit physics", cls="fm-note", size=9.8)

    _hairline_box(c, 12, 112, 224, 228, accent="fm_stroke")
    c.text(24, 130, "Scene Objects", cls="fm-label-bold", size=11.3)
    c.text(226, 130, "geom · cond · ant", cls="fm-note", anchor="end", size=9.2)

    # Identity strip inside Scene Objects
    c.rect(22, 139, 204, 38, fill="fm_fill", stroke="fm_stroke", stroke_width=0.75, rx=2.5)
    c.text(30, 154, "object_id · name · type", cls="fm-code", fill="fm_stroke", size=10.1, weight=600)
    c.text(30, 169, "Identity only — never activates physics", cls="fm-note", fill="fm_stroke", size=9.6)

    scene_rows = [
        ("Geometry AST", "Box, Cylinder, CSG, Transform, CAD"),
        (f"ObjectRegion {_ms('Ω' + sub('i'))}", "frame (object|world), priority, mesh(…)"),
        ("SI Material & fields", f"{_ms('M' + sub('s') + ', A, α, K' + sub('u') + ', K' + sub('c') + ', D')} · parameter fields"),
        (f"Initial state {_ms(vec('m', sub_text='0'))}", f"fm.texture.*  ({_ms('‖' + vec('m', sub_text='0') + '‖' + sub('2') + ' = 1')})"),
    ]
    for idx, (head, desc) in enumerate(scene_rows):
        ry = 194 + idx * 36
        if idx > 0:
            c.line(22, ry - 14, 226, ry - 14, stroke="grid", stroke_width=0.8)
        c.text(24, ry, head, cls="fm-label-bold", size=10.8, raw_markup="<tspan" in head)
        c.text(24, ry + 14, desc, cls="fm-note", size=9.7, raw_markup="<tspan" in desc)

    _hairline_box(c, 12, 352, 224, 124, accent="H")
    c.text(24, 371, "Ordered Stages", cls="fm-label-bold", fill="H", size=11.4)
    c.text(122, 371, "study.stages", cls="fm-code", size=10.0)
    stages = [
        ("add_relax / add_minimize", "overdamped, BB, NCG"),
        ("add_run", "LLG: heun, rk4, rk23, rk45, abm3"),
        ("add_eigenmodes / freq_response", "linearized LLG & χ(ω)"),
        ("add_hysteresis_sweep", "FieldSegment branches"),
    ]
    for idx, (cmd, note) in enumerate(stages):
        sy = 390 + idx * 22
        c.circle(24, sy - 3.5, 2.0, fill="H")
        c.text(32, sy, cmd, cls="fm-code", size=9.5)
        c.text(32, sy + 10.5, note, cls="fm-note", size=8.8)

    # ---- Column b: Explicit physics modules (x=266..506, w=240) ----
    # 1. Conservative field terms
    _hairline_box(c, 266, 46, 240, 108, accent="H")
    c.text(
        278,
        65,
        f"Field Terms  {_ms('K' + sub('field') + ' → ' + vec('H', sub_text='k'))}  (A m{sup('−1')})",
        cls="fm-label-bold",
        fill="H",
        size=10.8,
        raw_markup=True,
    )
    c.text(278, 83, "Exchange · Demag · Zeeman · Static", cls="fm-code", size=9.2)
    c.text(278, 98, "Anisotropy · DMI · Magnetoelastic", cls="fm-code", size=9.2)
    c.text(278, 113, f"ThermalNoise  (stochastic {_ms(vec('H', sub_text='th'))})", cls="fm-code", size=9.2, raw_markup=True)
    c.line(278, 123, 496, 123, stroke="grid", stroke_width=0.8)
    c.math_text(
        278,
        140,
        f"δE{sub('k')} = −μ{sub('0')}∫M{sub('s')}{vec('H', sub_text='k')}·{vec('η')} dV   →   "
        f"{vec('H', sub_text='eff')} = ∑{vec('H', sub_text='k')}",
        fill="H",
        size=10.5,
    )

    # 2. Direct spin torques
    _hairline_box(c, 266, 166, 240, 96, accent="accent_warm")
    c.text(
        278,
        185,
        f"Direct Torques  {_ms(vec('τ', sub_text='direct'))}  (s{sup('−1')})",
        cls="fm-label-bold",
        fill="accent_warm",
        size=10.8,
        raw_markup=True,
    )
    c.text(278, 203, "SlonczewskiSTT · ZhangLiSTT", cls="fm-code", size=9.2)
    c.text(278, 218, "PrescribedSOT · DriftDiffusion", cls="fm-code", size=9.2)
    c.line(278, 229, 496, 229, stroke="grid", stroke_width=0.8)
    c.math_text(
        278,
        247,
        f"{vec('τ', sub_text='direct')} = ({vec('T', sub_text='G')} + α {vec('m')}×{vec('T', sub_text='G')}) / (1 + α{sup('2')})",
        fill="accent_warm",
        size=10.7,
    )

    # 3. Coupled PDEs
    _hairline_box(c, 266, 274, 240, 96, accent="flux")
    c.text(278, 293, "Coupled Transport & Aux. PDEs", cls="fm-label-bold", fill="flux", size=10.8)
    c.text(278, 311, f"CurrentTransport ({_ms('V, ' + vec('J', sub_text='c'))})", cls="fm-code", size=9.2, raw_markup=True)
    c.text(278, 326, f"SpinDriftDiffusion ({_ms(vec('μ', sub_text='s') + ', Q' + sub('ia'))})", cls="fm-code", size=9.2, raw_markup=True)
    c.text(278, 341, f"Oersted ({_ms(vec('H', sub_text='oe'))}) · Elastic · Antenna", cls="fm-code", size=9.2, raw_markup=True)
    c.text(278, 359, "Explicit PhysicsGraph dependency edges", cls="fm-note", fill="flux", size=9.4)

    # 4. Inter-region couplings
    _hairline_box(c, 266, 382, 240, 94, accent="accent_violet")
    c.text(
        278,
        401,
        f"Inter-Region Couplings  {_ms('Γ' + sub('ab'))}",
        cls="fm-label-bold",
        fill="accent_violet",
        size=10.8,
        raw_markup=True,
    )
    c.text(278, 419, f"couplings.exchange (harmonic {_ms('A' + sub('ab'))})", cls="fm-code", size=9.1, raw_markup=True)
    c.text(278, 434, "couplings.rkky / interlayer", cls="fm-code", size=9.1)
    c.line(278, 445, 496, 445, stroke="grid", stroke_width=0.8)
    c.math_text(
        278,
        463,
        f"σ{sub('surf')} = −J{sub('1')}({vec('m', sub_text='a')}·{vec('m', sub_text='b')}) − J{sub('2')}({vec('m', sub_text='a')}·{vec('m', sub_text='b')}){sup('2')}",
        fill="accent_violet",
        size=10.4,
    )

    # Connectors Col a -> Col b (clean vertical bus at x=250)
    c.line(250, 73, 250, 429, stroke="axis", stroke_width=1.1, opacity=0.75)
    for y_src in (73, 226, 414):
        c.line(236, y_src, 250, y_src, stroke="axis", stroke_width=1.1, opacity=0.75)
    m_ax = c.marker_url("axis", size="sm")
    for y_dst in (100, 214, 322, 429):
        c.line(250, y_dst, 263, y_dst, stroke="axis", stroke_width=1.15, marker_end=m_ax)

    # ---- Column c: ProblemIR & Planner Gate (x=536..744, w=208) ----
    _hairline_box(c, 536, 46, 208, 140, accent="accent_violet")
    c.text(548, 65, "ProblemIR", cls="fm-label-bold", fill="accent_violet", size=11.5)
    c.text(618, 65, "[Requested intent]", cls="fm-note", fill="accent_violet", size=9.8)
    ir_lines = [
        "geometry · object_regions",
        "materials · parameter_fields",
        "energy_terms · couplings",
        "physics_graph · spin_torque",
        "study.stages · sampling",
    ]
    for idx, line in enumerate(ir_lines):
        c.text(548, 84 + idx * 15, line, cls="fm-code", size=9.5)
    c.line(548, 157, 734, 157, stroke="grid", stroke_width=0.8)
    c.text(548, 173, "Preserves 'auto' & target intent", cls="fm-note", fill="accent_violet", size=9.7)

    # Connectors Col b -> ProblemIR (bus at x=520)
    c.line(520, 100, 520, 429, stroke="axis", stroke_width=1.1, opacity=0.75)
    for y_src in (100, 214, 322, 429):
        c.line(506, y_src, 520, y_src, stroke="axis", stroke_width=1.1, opacity=0.75)
    c.line(520, 116, 533, 116, stroke="axis", stroke_width=1.25, marker_end=m_ax)

    # Vertical arrow ProblemIR -> Planner Gate
    vector_arrow(c, 640, 186, 640, 217, color="accent_violet", width=1.6, size="sm")
    c.text(648, 205, "fullmag-plan", cls="fm-code", fill="accent_violet", size=9.8)

    # Planner Gate node
    _hairline_box(c, 536, 220, 208, 104, accent="ink")
    c.text(548, 239, "Planner & Legality Gate", cls="fm-label-bold", size=11.2)
    c.text(548, 257, "• CapabilityMatrix & lane check", cls="fm-note", size=9.6)
    c.text(548, 273, "• validate_executable_outputs", cls="fm-note", size=9.6)
    c.text(548, 289, "• PreparationPlan & reuse keys", cls="fm-note", size=9.6)
    c.text(548, 308, "Strict GPU: no silent CPU fallback", cls="fm-note", fill="err", size=9.6, weight=600)

    # Fail-closed branch (left)
    vector_arrow(c, 594, 324, 594, 348, color="err", width=1.35, size="sm", dash="3.5,2.5")
    _hairline_box(c, 536, 351, 140, 42, accent="err", fill="err_soft", stroke="err")
    c.text(546, 368, "Fail-Closed Error", cls="fm-label-bold", fill="err", size=10.2)
    c.text(546, 383, "Aborts pre-execution", cls="fm-note", fill="err", size=9.2)

    # Pass branch (right) -> ExecutionPlanIR
    vector_arrow(c, 712, 324, 712, 405, color="ok", width=1.6, size="sm")
    c.text(718, 368, "valid", cls="fm-note", fill="ok", size=9.6)

    _hairline_box(c, 536, 408, 208, 68, accent="ok", fill="ok_soft", stroke="ok")
    c.text(548, 426, "ExecutionPlanIR", cls="fm-label-bold", fill="ok", size=11.0)
    c.text(648, 426, "[Resolved]", cls="fm-note", fill="ok", size=9.5)
    c.text(548, 444, "Resolved lane, precision & integrator", cls="fm-note", size=9.5)
    c.text(548, 460, "Device identity, seed & provenance", cls="fm-note", size=9.5)

    # ---- Column d: Four separate execution lanes & artifacts (x=774..968, w=194) ----
    lanes = [
        ("FDM CPU", "H", "Rust SoA · open/PBC FFT", "fullmag-engine"),
        ("FDM GPU", "hm_stroke", "CUDA · cuFFT convolution", "explicit FP32/FP64"),
        ("FEM CPU", "flux", f"MFEM ({_ms('Ω' + sub('m') + ' ⊂ Ω' + sub('a'))})", "Krylov airbox & BEM"),
        ("FEM GPU", "m", "CUDA / HYPRE / cuDSS", "device residency receipt"),
    ]
    lane_ys = []
    for idx, (name, col, l1, l2) in enumerate(lanes):
        ly = 46 + idx * 64
        lane_ys.append(ly + 27)
        _hairline_box(c, 774, ly, 194, 54, accent=col)
        c.text(786, ly + 18, name, cls="fm-label-bold", fill=col, size=11.0)
        c.text(786, ly + 33, l1, cls="fm-note", size=9.4, raw_markup="<tspan" in l1)
        c.text(786, ly + 46, l2, cls="fm-note", size=9.2)

    c.text(871, 314, "Four independently qualified lanes", cls="fm-note", anchor="middle", size=9.5, italic=True)

    # Route ExecutionPlanIR -> 4 lanes via clean vertical bus at x=758
    c.line(744, 442, 758, 442, stroke="ok", stroke_width=1.45)
    c.line(758, 442, 758, lane_ys[0], stroke="ok", stroke_width=1.45)
    m_ok = c.marker_url("ok", size="sm")
    for ly_mid in lane_ys:
        c.line(758, ly_mid, 771, ly_mid, stroke="ok", stroke_width=1.4, marker_end=m_ok)

    # Arrow from lanes -> Materialized artifacts
    vector_arrow(c, 871, 321, 871, 348, color="ink", width=1.5, size="sm")

    _hairline_box(c, 774, 352, 194, 124, accent="ink")
    c.text(786, 371, "Materialized Artifacts", cls="fm-label-bold", size=11.2)

    art_rows = [
        ("Spatial Fields", f"{_ms(vec('m') + ', ' + vec('H', sub_text='eff') + ', ' + vec('H', sub_text='k') + ', u, ' + vec('J', sub_text='c'))}", "H"),
        ("Scalar Reductions", f"{_ms('∑' + sub('Ωm') + ' w' + sub('i') + 'q' + sub('i'))} (airbox excl.)", "accent_warm"),
        ("Zarr / HDF5 & Receipt", "OutputStorage · fm.Result", "ok"),
    ]
    for idx, (head, desc, col) in enumerate(art_rows):
        ay = 392 + idx * 30
        if idx > 0:
            c.line(784, ay - 13, 958, ay - 13, stroke="grid", stroke_width=0.8)
        c.text(786, ay, head, cls="fm-label-bold", fill=col, size=10.2)
        c.text(786, ay + 12.5, desc, cls="fm-note", size=9.2, raw_markup="<tspan" in desc)


# ---------------------------------------------------------------------------
# 2. geometry-regions-materials-realization
# ---------------------------------------------------------------------------


def _build_fem_conforming_mesh(
    x_air0: float,
    x_air1: float,
    y_air0: float,
    y_air1: float,
    x_fm0: float,
    x_fm1: float,
    y_fm0: float,
    y_fm1: float,
    core_cx: float,
    core_cy: float,
    core_rx: float,
    core_ry: float,
    hole_cx: float,
    hole_cy: float,
    hole_r: float,
) -> tuple[np.ndarray, np.ndarray, list[str]]:
    """Generate a deterministic conforming 2D Delaunay triangulation of Omega_m subset Omega_a."""
    pts: list[tuple[float, float]] = []

    def add_seg(p0: tuple[float, float], p1: tuple[float, float], n: int) -> None:
        for k in range(n):
            frac = k / n
            pts.append((p0[0] + frac * (p1[0] - p0[0]), p0[1] + frac * (p1[1] - p0[1])))

    # 1. Outer airbox boundary Gamma_a (coarse)
    add_seg((x_air0, y_air0), (x_air1, y_air0), 7)
    add_seg((x_air1, y_air0), (x_air1, y_air1), 4)
    add_seg((x_air1, y_air1), (x_air0, y_air1), 7)
    add_seg((x_air0, y_air1), (x_air0, y_air0), 4)

    # 2. Magnetic film outer boundary dOmega_m (medium)
    add_seg((x_fm0, y_fm0), (x_fm1, y_fm0), 12)
    add_seg((x_fm1, y_fm0), (x_fm1, y_fm1), 6)
    add_seg((x_fm1, y_fm1), (x_fm0, y_fm1), 12)
    add_seg((x_fm0, y_fm1), (x_fm0, y_fm0), 6)

    # 3. Circular hole boundary + center point (conformal circular air cutout)
    n_hole = 14
    for k in range(n_hole):
        ang = 2.0 * math.pi * k / n_hole
        pts.append((hole_cx + hole_r * math.cos(ang), hole_cy + hole_r * math.sin(ang)))
    pts.append((hole_cx, hole_cy))

    # 4. Core ObjectRegion ellipse boundary + graded fine interior rings
    n_core_outer = 18
    for k in range(n_core_outer):
        ang = 2.0 * math.pi * k / n_core_outer
        pts.append((core_cx + core_rx * math.cos(ang), core_cy + core_ry * math.sin(ang)))
    for scale, n_ring in ((0.64, 12), (0.30, 6)):
        for k in range(n_ring):
            ang = 2.0 * math.pi * (k + 0.35) / n_ring
            pts.append((core_cx + scale * core_rx * math.cos(ang), core_cy + scale * core_ry * math.sin(ang)))
    pts.append((core_cx, core_cy))

    # 5. Structured interior film nodes (avoiding core & hole margins)
    for gx in np.linspace(x_fm0 + 18.0, x_fm1 - 18.0, 9):
        for gy in np.linspace(y_fm0 + 16.0, y_fm1 - 16.0, 4):
            dc = ((gx - core_cx) / (core_rx + 8.0)) ** 2 + ((gy - core_cy) / (core_ry + 7.0)) ** 2
            dh = math.hypot(gx - hole_cx, gy - hole_cy)
            if dc > 1.05 and dh > hole_r + 9.0:
                pts.append((float(gx), float(gy)))

    # 6. Intermediate airbox points for well-shaped outer triangles
    mid_y_top = 0.5 * (y_air0 + y_fm0)
    mid_y_bot = 0.5 * (y_fm1 + y_air1)
    for gx in np.linspace(x_air0 + 26.0, x_air1 - 26.0, 6):
        pts.append((float(gx), mid_y_top))
        pts.append((float(gx), mid_y_bot))

    arr = np.asarray(pts, dtype=float)
    tri = Delaunay(arr)
    kinds: list[str] = []
    for simplex in tri.simplices:
        cx = float(np.mean(arr[simplex, 0]))
        cy = float(np.mean(arr[simplex, 1]))
        in_film = (x_fm0 < cx < x_fm1) and (y_fm0 < cy < y_fm1)
        in_hole = math.hypot(cx - hole_cx, cy - hole_cy) < hole_r
        in_core = ((cx - core_cx) / core_rx) ** 2 + ((cy - core_cy) / core_ry) ** 2 < 1.0
        if (not in_film) or in_hole:
            kinds.append("air")
        elif in_core:
            kinds.append("core")
        else:
            kinds.append("film")
    return arr, tri.simplices, kinds


def draw_geometry_realization(c: SvgCanvas, t: Theme) -> None:
    """Three-panel comparison: Authored CSG -> FDM Cartesian masks -> FEM conforming shared mesh."""
    panel_divider(c, 320, 14, 320, 464)
    panel_divider(c, 640, 14, 640, 464)

    # ---- Panel a: Authored CSG, Regions & Spatial Fields ----
    panel_label(
        c,
        14,
        24,
        "a",
        "Authored CSG, regions & fields",
        subtitle=f"Box − Cylinder, ObjectRegion(priority) &amp; spatial {_ms('M' + sub('s'))}",
        subtitle_markup=True,
    )

    # Box minus Cylinder (true transparent hole via fill-rule="evenodd")
    bx, by, bw, bh = 68.0, 78.0, 228.0, 108.0
    hole_cx, hole_cy, hole_r = 250.0, 132.0, 19.0
    core_cx, core_cy, core_rx, core_ry = 128.0, 132.0, 38.0, 26.0

    d_cutout = (
        f"M {bx:.1f} {by:.1f} L {bx + bw:.1f} {by:.1f} L {bx + bw:.1f} {by + bh:.1f} L {bx:.1f} {by + bh:.1f} Z "
        f"M {hole_cx + hole_r:.1f} {hole_cy:.1f} "
        f"A {hole_r:.1f} {hole_r:.1f} 0 1 0 {hole_cx - hole_r:.1f} {hole_cy:.1f} "
        f"A {hole_r:.1f} {hole_r:.1f} 0 1 0 {hole_cx + hole_r:.1f} {hole_cy:.1f} Z"
    )
    c.raw(
        f'<path d="{d_cutout}" fill="{esc(t.fm_fill)}" fill-rule="evenodd" '
        f'stroke="{esc(t.fm_stroke)}" stroke-width="1.5"/>'
    )
    c.circle(hole_cx, hole_cy, hole_r, fill="none", stroke="air_stroke", stroke_width=1.15, dash="3.5,2.5")
    c.text(hole_cx, hole_cy + 3.5, "hole", cls="fm-note", anchor="middle", size=10.2)
    c.text(bx + 0.5 * bw, by - 8.0, "film = Box − Cylinder", cls="fm-code", fill="fm_stroke", anchor="middle", size=10.2)

    # Core ObjectRegion + transition halo
    c.ellipse(
        core_cx,
        core_cy,
        core_rx + 6.5,
        core_ry + 6.0,
        fill=f"url(#{c._pid('hatch-warm')})",
        stroke="accent_warm",
        stroke_width=0.85,
        dash="3,2",
    )
    c.ellipse(
        core_cx,
        core_cy,
        core_rx,
        core_ry,
        fill="accent_warm_soft",
        fill_opacity=0.85,
        stroke="accent_warm",
        stroke_width=1.45,
    )
    c.text(core_cx, core_cy - 2.0, "core", cls="fm-label-bold", fill="accent_warm", anchor="middle", size=10.8)
    c.text(core_cx, core_cy + 12.0, "prio = 10", cls="fm-code", fill="accent_warm", anchor="middle", size=9.1)

    # Object frame cleanly positioned between core and hole
    ox, oy = 184.0, by + 0.5 * bh
    c.circle(ox, oy, 2.5, fill="H")
    vector_arrow(c, ox, oy, ox + 22.0, oy, color="H", width=1.4, size="sm")
    vector_arrow(c, ox, oy, ox, oy - 24.0, color="H", width=1.4, size="sm")
    c.math_text(ox + 23.0, oy + 13.0, f"x{sub('obj')}", fill="H", size=10.2, anchor="middle", halo=True)
    c.math_text(ox + 5.0, oy - 26.0, f"y{sub('obj')}", fill="H", size=10.2, halo=True)

    # World frame at bottom-left outside film (shifted up so X_lab subscript clears frame='world')
    wx, wy = 22.0, 199.0
    vector_arrow(c, wx, wy, wx + 26.0, wy, color="axis", width=1.25, size="sm")
    vector_arrow(c, wx, wy, wx, wy - 26.0, color="axis", width=1.25, size="sm")
    c.math_text(wx + 29.0, wy + 3.5, f"X{sub('lab')}", fill="ink_muted", size=9.8)
    c.math_text(wx - 2.0, wy - 31.0, f"Y{sub('lab')}", fill="ink_muted", size=9.8)
    c.text(wx, 221.0, "frame='world'", cls="fm-code", fill="ink_muted", size=9.1)

    # Transition callout (cleanly clear of frame='world')
    c.line(128.0, 165.0, 128.0, 208.0, stroke="accent_warm", stroke_width=0.9, dash="2.5,2")
    c.text(
        212.0,
        221.0,
        "material_transition(cells=2)",
        cls="fm-code",
        fill="accent_warm",
        anchor="middle",
        size=9.2,
    )

    # Bottom 2D profile plot: MaterialParameterField along y_obj across 'core'
    c.text(
        178.0,
        250.0,
        f"MaterialParameterField along {_ms('y' + sub('obj'))}",
        cls="fm-label-bold",
        anchor="middle",
        size=10.8,
        raw_markup=True,
    )
    pf = axes_2d(
        c,
        62.0,
        262.0,
        236.0,
        122.0,
        xlim=(-50.0, 50.0),
        ylim=(720.0, 815.0),
        xticks=[-40, 0, 40],
        xtick_labels=["−40", "0", "+40"],
        yticks=[725, 760, 800],
        ytick_labels=["725", "760", "800"],
        xlabel=f"y{sub('obj')} {roman('(nm)')}",
        ylabel=f"M{sub('s')} {roman('(kA/m)')}",
        grid=True,
        xlabel_offset=28.0,
        ylabel_offset=35.0,
    )
    # Base film left/right (800 kA/m), core linear override [-25, +25] nm: 738 -> 786 kA/m
    pf.plot_curve([-50.0, -25.0], [800.0, 800.0], color="fm_stroke", width=2.2)
    pf.plot_curve([25.0, 50.0], [800.0, 800.0], color="fm_stroke", width=2.2)
    pf.plot_curve([-25.0, 25.0], [738.0, 786.0], color="accent_warm", width=2.2)
    c.line(pf.px(-25.0), pf.py(800.0), pf.px(-25.0), pf.py(738.0), stroke="accent_warm", stroke_width=1.0, dash="3,2")
    c.line(pf.px(25.0), pf.py(786.0), pf.px(25.0), pf.py(800.0), stroke="accent_warm", stroke_width=1.0, dash="3,2")
    c.text(pf.px(0.0), pf.py(748.0), "core linear", cls="fm-note", fill="accent_warm", anchor="middle", size=9.6, halo=True)
    c.text(pf.px(-37.5), pf.py(806.0), "base", cls="fm-note", fill="fm_stroke", anchor="middle", size=9.4)

    c.text(
        162.0,
        442.0,
        "conflict_policy='error' rejects equal-priority ties",
        cls="fm-code",
        fill="err",
        anchor="middle",
        size=8.9,
    )
    c.text(
        162.0,
        458.0,
        "Preserves geometry AST & frames; no mesh built yet.",
        cls="fm-note",
        anchor="middle",
        size=9.6,
    )

    # ---- Panel b: FDM Structured Cartesian Cells & Masks ----
    panel_label(
        c,
        334,
        24,
        "b",
        "FDM: Cartesian cells & masks",
        subtitle=f"Structured grid ({_ms('Δx, Δy, Δz')}), active mask {_ms('A')}, region index {_ms('r' + sub('i'))}",
        subtitle_markup=True,
    )

    nx, ny = 22, 12
    gx0, gy0 = 346.0, 66.0
    cw, ch = 12.0, 11.2
    grid_w, grid_h = nx * cw, ny * ch
    # Map film box inside cells [1..20] x [1..10]
    fb_x0, fb_x1 = gx0 + 1.0 * cw, gx0 + (nx - 1) * cw
    fb_y0, fb_y1 = gy0 + 1.0 * ch, gy0 + (ny - 1) * ch
    fdm_hole_cx = fb_x0 + 0.77 * (fb_x1 - fb_x0)
    fdm_hole_cy = 0.5 * (fb_y0 + fb_y1)
    fdm_hole_r = 21.0
    fdm_core_cx = fb_x0 + 0.29 * (fb_x1 - fb_x0)
    fdm_core_cy = 0.5 * (fb_y0 + fb_y1)
    fdm_core_rx, fdm_core_ry = 36.0, 26.0

    for j in range(ny):
        for i in range(nx):
            rx = gx0 + i * cw
            ry = gy0 + j * ch
            cx = rx + 0.5 * cw
            cy = ry + 0.5 * ch
            in_film = (fb_x0 <= cx <= fb_x1) and (fb_y0 <= cy <= fb_y1)
            in_hole = math.hypot(cx - fdm_hole_cx, cy - fdm_hole_cy) <= fdm_hole_r
            in_core = ((cx - fdm_core_cx) / fdm_core_rx) ** 2 + ((cy - fdm_core_cy) / fdm_core_ry) ** 2 <= 1.0
            if (not in_film) or in_hole:
                fill_c, stroke_c = "air_fill", "grid"
            elif in_core:
                fill_c, stroke_c = "accent_warm_soft", "accent_warm"
            else:
                fill_c, stroke_c = "fm_fill", "fm_stroke"
            c.rect(rx, ry, cw, ch, fill=fill_c, stroke=stroke_c, stroke_width=0.6)

    # Dashed exact CSG overlay showing staircase boundary
    c.rect(fb_x0, fb_y0, fb_x1 - fb_x0, fb_y1 - fb_y0, fill="none", stroke="fm_stroke", stroke_width=1.25, dash="4,2.5")
    c.circle(fdm_hole_cx, fdm_hole_cy, fdm_hole_r, fill="none", stroke="air_stroke", stroke_width=1.2, dash="3.5,2.5")

    bracket_dim(
        c,
        gx0 + 3.0 * cw,
        gy0 + grid_h,
        gx0 + 6.0 * cw,
        gy0 + grid_h,
        label=f"{roman('3')} Δx {roman('(cell size)')}",
        offset=14.0,
        color="H",
        label_offset=12.0,
    )

    # Clean legend strip & contract lines (zero boxed bullets!)
    legend_strip(
        c,
        348.0,
        266.0,
        [
            (f"Inactive / hole: {_ms('M' + sub('s,i') + ' = ' + roman('0'))}, active = 0", "air_fill", "swatch"),
            (f"Base film: {_ms('r' + sub('i') + ' = ' + roman('0'))}, {_ms('M' + sub('s'))} = 800 kA/m", "fm_fill", "swatch"),
            (f"Core region: {_ms('r' + sub('i') + ' = ' + roman('1'))}, {_ms('M' + sub('s') + '(x' + sub('i') + ', y' + sub('i') + ')')}", "accent_warm_soft", "swatch"),
        ],
        horizontal=False,
        row_gap=22.0,
    )
    c.line(348.0, 336.0, 612.0, 336.0, stroke="hairline", stroke_width=0.75, opacity=0.6)
    c.text(348.0, 358.0, "FDM cell & stencil semantics", cls="fm-label-bold", fill="H", size=11.0)
    fdm_notes = [
        "• Cell-center sampling of spatial material fields",
        f"• Staircase mask {_ms('A')} excludes hole &amp; vacuum",
        f"• Interface exchange {_ms('A' + sub('ab'))} across {_ms('r' + sub('i') + ' ≠ r' + sub('j'))} faces",
        "• Periodicity & multilayer grids are separate contracts",
    ]
    for idx, line in enumerate(fdm_notes):
        c.text(348.0, 378.0 + idx * 18.0, line, cls="fm-sub", size=10.3, raw_markup="<tspan" in line)

    c.text(480.0, 458.0, "Single active-cell ownership; no overlapping subgrids.", cls="fm-note", anchor="middle", size=9.8)

    # ---- Panel c: FEM Single Shared Conforming Domain ----
    panel_label(
        c,
        654,
        24,
        "c",
        "FEM: shared conforming mesh",
        subtitle=f"Single domain {_ms('Ω' + sub('m') + ' ⊂ Ω' + sub('a'))}, markers &amp; local grading",
        subtitle_markup=True,
    )

    x_a0, x_a1, y_a0, y_a1 = 664.0, 936.0, 66.0, 200.0
    x_f0, x_f1, y_f0, y_f1 = 696.0, 904.0, 90.0, 176.0
    fc_cx, fc_cy, fc_rx, fc_ry = 754.0, 133.0, 31.0, 22.0
    fh_cx, fh_cy, fh_r = 856.0, 133.0, 18.0

    pts, simplices, kinds = _build_fem_conforming_mesh(
        x_a0, x_a1, y_a0, y_a1,
        x_f0, x_f1, y_f0, y_f1,
        fc_cx, fc_cy, fc_rx, fc_ry,
        fh_cx, fh_cy, fh_r,
    )
    style_map = {
        "air": ("air_fill", "air_stroke", 0.55),
        "film": ("fm_fill", "fm_stroke", 0.60),
        "core": ("accent_warm_soft", "accent_warm", 0.65),
    }
    for simplex, kind in zip(simplices, kinds):
        tri_pts = [(float(pts[k, 0]), float(pts[k, 1])) for k in simplex]
        f_col, s_col, sw = style_map[kind]
        c.polygon(tri_pts, fill=f_col, stroke=s_col, stroke_width=sw)

    # Crisp domain & marker outlines on top of triangulation
    c.rect(x_a0, y_a0, x_a1 - x_a0, y_a1 - y_a0, fill="none", stroke="air_stroke", stroke_width=1.45)
    c.rect(x_f0, y_f0, x_f1 - x_f0, y_f1 - y_f0, fill="none", stroke="fm_stroke", stroke_width=1.45)
    c.circle(fh_cx, fh_cy, fh_r, fill="none", stroke="air_stroke", stroke_width=1.25)
    c.ellipse(fc_cx, fc_cy, fc_rx, fc_ry, fill="none", stroke="accent_warm", stroke_width=1.2)

    c.math_text(x_a0 + 6.0, y_a0 + 15.0, f"Ω{sub('a')} {roman('(airbox)')}", fill="air_stroke", size=10.2, halo=True)
    c.math_text(x_a1 - 4.0, y_a0 - 9.0, f"Γ{sub('a')} {roman('marker')}", fill="air_stroke", size=10.2, anchor="end")
    c.text(fh_cx, fh_cy + 3.5, "air", cls="fm-note", fill="air_stroke", anchor="middle", size=9.6, halo=True)

    # Legend & shared-domain contract
    legend_strip(
        c,
        664.0,
        266.0,
        [
            (f"Airbox {_ms('Ω' + sub('a') + ' ∖ Ω' + sub('m'))} ({_ms('M' + sub('s') + ' = ' + roman('0'))}, marker {_ms('Γ' + sub('a'))})", "air_fill", "swatch"),
            (f"Film elements {_ms('Ω' + sub('m'))} (conformal {_ms('∂Ω' + sub('m'))})", "fm_fill", "swatch"),
            (f"Graded 'core' (local {_ms('h' + sub('max'))}, transition)", "accent_warm_soft", "swatch"),
        ],
        horizontal=False,
        row_gap=22.0,
    )
    c.line(664.0, 336.0, 936.0, 336.0, stroke="hairline", stroke_width=0.75, opacity=0.6)
    c.text(664.0, 358.0, "FEM shared-domain contract", cls="fm-label-bold", fill="flux", size=11.0)
    fem_notes = [
        "• Single conforming mesh (never overlapping submeshes)",
        f"• Disjoint partition {_ms('Ω' + sub('m') + ' = ⋃ Ω' + sub('i'))}, {_ms('Ω' + sub('i') + ' ∩ Ω' + sub('j') + ' = ∅')}",
        f"• Face markers identify {_ms('∂Ω' + sub('m'))} (DMI/exch) &amp; {_ms('Γ' + sub('a'))} (demag)",
        "• Material fields evaluated at nodes / quadrature points",
    ]
    for idx, line in enumerate(fem_notes):
        c.text(664.0, 378.0 + idx * 18.0, line, cls="fm-sub", size=10.3, raw_markup="<tspan" in line)

    c.text(800.0, 458.0, "Region mesh(…) drives local grading in the shared domain.", cls="fm-note", anchor="middle", size=9.8)


# ---------------------------------------------------------------------------
# 3. interactions-taxonomy-energy-vs-torque
# ---------------------------------------------------------------------------


def draw_interactions_taxonomy(c: SvgCanvas, t: Theme) -> None:
    """Taxonomy of all 12 FullMag physical interactions: conservative H_eff vs direct tau_direct."""
    # Left macro-zone: 2x2 grid of field-form interactions (x=14..634)
    # Right macro-zone: Direct spin torques (x=668..966)
    panel_divider(c, 650, 14, 650, 424)

    # ---- Panel a: Local energy densities (x=14..314, y=22..214) ----
    _top_rule_header(
        c,
        14,
        26,
        300,
        "a",
        f"Local energy densities → {_ms(vec('H', sub_text='k'))}",
        accent="H",
        subtitle=f"Algebraic {_ms('∂w' + sub('k') + '/∂' + vec('m'))}; no surface BCs",
        title_markup=True,
        subtitle_markup=True,
    )
    local_items = [
        ("1. Zeeman", "Zeeman · StaticFieldMap", f"E{sub('Z')} = −∫{vec('M')}·{vec('B', sub_text='ext')} dV,   {vec('H', sub_text='Z')} = {vec('B', sub_text='ext')}/μ{sub('0')}"),
        ("2. Anisotropy", "Uniaxial · CubicAnisotropy", f"w{sub('u')} = −K{sub('u1')}q{sup('2')} − K{sub('u2')}q{sup('4')};   w{sub('c')}(K{sub('c1..3')})"),
        ("3. Magnetoelastic", "Magnetoelastic + Elastic", f"w{sub('mel')}({vec('m')}, {vec('ε')}) = B{sub('1')}∑ε{sub('ii')}m{sub('i')}{sup('2')} + 2B{sub('2')}∑{sub('i<j')}ε{sub('ij')}m{sub('i')}m{sub('j')}"),
    ]
    for idx, (title, api, eq) in enumerate(local_items):
        ry = 68 + idx * 50
        if idx > 0:
            c.line(16, ry - 15, 312, ry - 15, stroke="grid", stroke_width=0.8)
        c.text(16, ry, title, cls="fm-label-bold", fill="H", size=10.8)
        c.text(312, ry, api, cls="fm-code", anchor="end", size=8.9)
        c.math_text(22, ry + 18, eq, fill="ink", size=11.0)

    # ---- Panel b: Differential & surface BCs (x=334..634, y=22..214) ----
    _top_rule_header(
        c,
        334,
        26,
        300,
        "b",
        f"Differential &amp; BCs → {_ms(vec('H', sub_text='k'))}",
        accent="accent_violet",
        subtitle=f"Spatial {_ms('∇' + vec('m') + ', ∇' + sup('2') + vec('m'))} &amp; natural boundary laws",
        title_markup=True,
        subtitle_markup=True,
    )
    diff_items = [
        ("4. Bulk Exchange", "Exchange", f"E{sub('ex')} = ∫A|∇{vec('m')}|{sup('2')} dV   |   A ∂{sub('n')}{vec('m')} = {vec('0')}"),
        ("5. DMI (3 variants)", "Interfacial · Rotated · Bulk", f"2A ∂{sub('ν')}{vec('m')} + D[({hat('n')}×{vec('ν')})×{vec('m')}] = {vec('0')}"),
        ("6. Inter-Region", "couplings.exchange / .rkky", f"A{sub('ab')} {roman('harmonic;')}  σ = −J{sub('1')}({vec('m', sub_text='a')}·{vec('m', sub_text='b')}) − J{sub('2')}(·){sup('2')}"),
    ]
    for idx, (title, api, eq) in enumerate(diff_items):
        ry = 68 + idx * 50
        if idx > 0:
            c.line(336, ry - 15, 632, ry - 15, stroke="grid", stroke_width=0.8)
        c.text(336, ry, title, cls="fm-label-bold", fill="accent_violet", size=10.8)
        c.text(632, ry, api, cls="fm-code", anchor="end", size=9.2)
        c.math_text(342, ry + 18, eq, fill="ink", size=10.9)

    # ---- Panel c: Nonlocal operators (x=14..314, y=240..420) ----
    _top_rule_header(
        c,
        14,
        248,
        300,
        "c",
        f"Nonlocal fields → {_ms(vec('H', sub_text='k'))}",
        accent="flux",
        subtitle="Long-range Green, FFT & Poisson solves",
        title_markup=True,
    )
    c.text(16, 290, "7. Demagnetization", cls="fm-label-bold", fill="flux", size=10.8)
    c.text(312, 290, "Demag(model, variant)", cls="fm-code", anchor="end", size=9.2)
    c.math_text(22, 308, f"∇·({vec('H', sub_text='d')} + {vec('M')}) = 0,   {vec('H', sub_text='d')} = −∇u", size=11.0)
    c.text(22, 325, "FDM open/PBC FFT · FEM airbox · FEM–BEM", cls="fm-note", size=9.6)

    c.line(16, 338, 312, 338, stroke="grid", stroke_width=0.8)
    c.text(16, 355, "8. Oersted Field", cls="fm-label-bold", fill="flux", size=10.8)
    c.text(312, 355, "OerstedCylinder · Field", cls="fm-code", anchor="end", size=8.9)
    c.math_text(22, 373, f"{roman('Ampère / Biot–Savart:')} (4π){sup('−1')}∫{vec('J', sub_text='c')}×Δ{vec('r')}/r{sup('3')} dV′", size=10.5)
    c.text(22, 391, "Requires CurrentTransport; non-conservative for I(t)", cls="fm-note", size=9.5)

    # ---- Panel d: Stochastic field (x=334..634, y=240..420) ----
    _top_rule_header(
        c,
        334,
        248,
        300,
        "d",
        f"Stochastic field → {_ms(vec('H', sub_text='th'))}",
        accent="m",
        subtitle=f"FDT fluctuations; no standalone {_ms('E' + sub('th'))}",
        title_markup=True,
        subtitle_markup=True,
    )
    c.text(336, 290, "9. Thermal Brown Noise", cls="fm-label-bold", fill="m", size=10.8)
    c.text(632, 290, "ThermalNoise(T, seed)", cls="fm-code", anchor="end", size=9.2)
    c.math_text(
        342,
        311,
        f"{vec('H', sub_text='th,i', sup_text='n')} = σ{sub('i')}{sup('n')} {vec('ξ', sub_text='i', sup_text='n')},   {vec('ξ')} ∼ N(0, {vec('I', sub_text='3')})",
        size=11.0,
    )
    c.math_text(
        342,
        334,
        f"σ{sub('i')}{sup('n')} = √( 2α{sub('i')}k{sub('B')}T / (γ{sub('0')}μ{sub('0')}M{sub('s,i')}V{sub('i')}Δt{sub('n')}) )",
        fill="m",
        size=10.9,
    )
    c.text(342, 358, f"• Bare {_ms('γ' + sub('0'))} in FDT denominator · disables RK FSAL", cls="fm-note", size=9.7, raw_markup=True)
    c.text(342, 375, f"• Enters {_ms(vec('H', sub_text='eff'))} directly; statistical SDE qualification", cls="fm-note", size=9.7, raw_markup=True)
    c.text(342, 392, "• Seed controls RNG stream (not CPU/GPU bitwise match)", cls="fm-note", size=9.7)

    # ---- Panel e: Direct spin torques (x=668..966, y=22..420) ----
    _top_rule_header(
        c,
        668,
        26,
        298,
        "e",
        f"Direct spin torques → {_ms(vec('τ', sub_text='direct'))}",
        accent="accent_warm",
        subtitle=f"Non-conservative RHS rates (s{sup('−1')})",
        title_markup=True,
        subtitle_markup=True,
    )
    torque_items = [
        (
            "10. Spin-Transfer Torque",
            "SlonczewskiSTT · ZhangLiSTT",
            f"{vec('T', sub_text='SL,G')} = Ω{sub('DL')}{vec('m')}×({hat('p')}×{vec('m')}) + Ω{sub('FL')}{vec('m')}×{hat('p')}",
            f"{vec('T', sub_text='ZL,G')} = −({vec('u')}·∇){vec('m')} + β {vec('m')}×[({vec('u')}·∇){vec('m')}]",
        ),
        (
            "11. Prescribed SOT",
            "PrescribedSpinOrbitTorque",
            f"{vec('T', sub_text='SOT,G')} = Ω{sub('DL')}{vec('m')}×({hat('σ')}×{vec('m')}) + Ω{sub('FL')}{vec('m')}×{hat('σ')}",
            "SignedScalarDrive | VectorCurrentDrive",
        ),
        (
            "12. Drift–Diffusion Torque",
            "CurrentTransport + SpinDriftDiffusion",
            f"{vec('T', sub_text='tr,G')} = −(γ{sub('e')}/M{sub('s')})(ℏ/2e)({vec('R', sub_text='J')} + {vec('R', sub_text='φ')})",
            "M1 (one_way) or M2 (bidirectional) transport",
        ),
    ]
    for idx, (title, api, eq1, eq2) in enumerate(torque_items):
        ry = 68 + idx * 96
        if idx > 0:
            c.line(670, ry - 15, 964, ry - 15, stroke="grid", stroke_width=0.8)
        c.text(670, ry, title, cls="fm-label-bold", fill="accent_warm", size=10.8)
        c.text(670, ry + 15, api, cls="fm-code", size=9.2)
        c.math_text(674, ry + 35, eq1, fill="ink", size=10.6)
        if idx == 0:
            c.math_text(674, ry + 54, eq2, fill="ink_secondary", size=10.3)
        else:
            c.text(674, ry + 54, eq2, cls="fm-note", size=9.6)

    c.line(670, 354, 964, 354, stroke="accent_warm", stroke_width=0.9, dash="3,2.5", opacity=0.7)
    c.text(670, 374, "Single Gilbert → explicit conversion:", cls="fm-label-bold", fill="accent_warm", size=10.3)
    c.math_text(
        674,
        395,
        f"{vec('τ', sub_text='direct')} = ({vec('T', sub_text='G')} + α {vec('m')}×{vec('T', sub_text='G')}) / (1 + α{sup('2')})",
        fill="accent_warm",
        size=11.3,
    )
    c.text(674, 412, f"Never injected as pseudo-field in {_ms(vec('H', sub_text='eff'))}", cls="fm-note", size=9.4, raw_markup=True)

    # ---- Bottom Synthesis Bar (y=452..546) ----
    # Collector arrows from a,b,c,d into Composed H_eff
    c.line(164, 416, 164, 434, stroke="H", stroke_width=1.35)
    c.line(484, 416, 484, 434, stroke="m", stroke_width=1.35)
    c.line(164, 434, 484, 434, stroke="H", stroke_width=1.35)
    vector_arrow(c, 200, 434, 200, 456, color="H", width=1.6, size="sm")

    _hairline_box(c, 14, 458, 378, 86, accent="H", fill="H_soft", stroke="H")
    c.text(26, 478, f"Composed Effective Field  {_ms(vec('H', sub_text='eff'))}  (A m{sup('−1')})", cls="fm-label-bold", fill="H", size=11.3, raw_markup=True)
    c.math_text(
        26,
        501,
        f"{vec('H', sub_text='eff')}({vec('x')}, t) = ∑{sub('k ∈ K')} {vec('H', sub_text='k')}   (+ {vec('H', sub_text='oe')}, {vec('H', sub_text='th')})",
        fill="ink",
        size=11.8,
    )
    c.text(
        26,
        526,
        f"Conservative terms enter via {_ms('−(μ' + sub('0') + 'M' + sub('s') + ')' + sup('−1') + ' δE' + sub('k') + '/δ' + vec('m'))}",
        cls="fm-note",
        size=9.8,
        raw_markup=True,
    )

    # Arrow H_eff -> Explicit LLG RHS
    vector_arrow(c, 392, 501, 424, 501, color="H", width=1.7, size="md")
    # Arrow Direct torques -> Explicit LLG RHS
    vector_arrow(c, 816, 422, 816, 456, color="accent_warm", width=1.7, size="md")

    _hairline_box(c, 428, 458, 538, 86, accent="ink")
    c.text(440, 478, f"Total Explicit LLG Right-Hand Side  (s{sup('−1')})", cls="fm-label-bold", size=11.4, raw_markup=True)
    c.math_text(
        440,
        503,
        f"∂{sub('t')}{vec('m')} = −γ{sub('0')}/(1 + α{sup('2')}) [ s{sub('prec')} {vec('m')}×{vec('H', sub_text='eff')} + "
        f"α {vec('m')}×({vec('m')}×{vec('H', sub_text='eff')}) ] + {vec('τ', sub_text='direct')}",
        fill="ink",
        size=11.9,
        bold=False,
    )
    c.text(
        440,
        528,
        f"Preserves {_ms(vec('m') + ' · ∂' + sub('t') + vec('m') + ' = 0')} on {_ms('S' + sup('2'))}; "
        f"planner enforces per-interaction lane legality.",
        cls="fm-note",
        size=9.8,
        raw_markup=True,
    )


# ---------------------------------------------------------------------------
# 4. llg-precession-damping-sphere
# ---------------------------------------------------------------------------


def _llg_rhs(alpha: float, s_prec: float):
    """Dimensionless LLG RHS with H_eff = +z_hat and gamma_0 H_0 = 1."""
    pref = 1.0 / (1.0 + alpha * alpha)

    def rhs(_t: float, m: tuple[float, ...]) -> tuple[float, float, float]:
        mx, my, mz = m
        # m x z_hat = (my, -mx, 0)
        # m x (m x z_hat) = (mz*mx, mz*my, mz*mz - 1)
        px, py, pz = my, -mx, 0.0
        dx, dy, dz = mz * mx, mz * my, mz * mz - 1.0
        return (
            -pref * (s_prec * px + alpha * dx),
            -pref * (s_prec * py + alpha * dy),
            -pref * (s_prec * pz + alpha * dz),
        )

    return rhs


def draw_llg_sphere(c: SvgCanvas, t: Theme) -> None:
    """Numerically integrated LLG dynamics on S^2: precession, geodesic damping, energy, RK drift."""
    alpha = 0.28
    theta0 = math.radians(78.0)
    phi0 = math.radians(-22.0)
    m0 = (
        math.sin(theta0) * math.cos(phi0),
        math.sin(theta0) * math.sin(phi0),
        math.cos(theta0),
    )

    ts_hel, ms_hel = rk4_integrate(_llg_rhs(alpha, 1.0), m0, (0.0, 18.0), 0.04, normalize=True)
    ts_geo, ms_geo = rk4_integrate(_llg_rhs(alpha, 0.0), m0, (0.0, 18.0), 0.04, normalize=True)

    panel_divider(c, 504, 14, 504, 506)
    panel_divider(c, 522, 274, 948, 274)

    # ---- Panel a: 3D Unit Sphere S^2 ----
    panel_label(
        c,
        14,
        24,
        "a",
        f"3D trajectory &amp; torques on {_ms('S' + sup('2'))}",
        subtitle=f"{_ms('α = 0.28')}, {_ms(vec('H', sub_text='eff') + ' ∥ +' + hat('z'))}; exact RK4 integration",
        title_markup=True,
        subtitle_markup=True,
    )

    cx, cy, radius = 226.0, 268.0, 158.0
    proj = unit_sphere(
        c,
        cx,
        cy,
        radius,
        azim_deg=34.0,
        elev_deg=21.0,
        meridians_deg=(0.0, 90.0),
        latitudes_deg=(-45.0, 0.0, 45.0),
        axes=True,
        axis_labels=(f"+{hat('x')}", f"+{hat('y')}", ""),
        shaded=True,
    )

    # Effective field vector H_eff along +z_hat
    ox, oy, _ = proj.project(0.0, 0.0, 0.0)
    nz_x, nz_y, _ = proj.project(0.0, 0.0, 1.0)
    hz_x, hz_y, _ = proj.project(0.0, 0.0, 1.32)
    c.line(ox, oy, nz_x, nz_y, stroke="H", stroke_width=2.0, dash="4.5,3", opacity=0.55)
    vector_arrow(c, nz_x, nz_y, hz_x, hz_y, color="H", width=2.6, size="md")
    c.circle(nz_x, nz_y, 3.2, fill="H", stroke="surface_ref", stroke_width=1.0)
    c.math_text(hz_x + 11.0, hz_y + 5.0, f"{vec('H', sub_text='eff')} ∥ +{hat('z')}", fill="H", size=12.4)

    # Helical (s_prec=1) and geodesic (s_prec=0) trajectories
    sphere_curve(c, proj, ms_hel, color="flux", width=2.2, back_opacity=0.35, back_dash="3.5,3")
    sphere_curve(c, proj, ms_geo, color="accent_warm", width=2.1, front_dash="5.5,3", back_opacity=0.30, back_dash="3,3")

    # Initial state m_0
    m0x, m0y, _ = proj.project(*m0)
    c.circle(m0x, m0y, 4.4, fill="surface_ref", stroke="ink", stroke_width=1.8)
    c.math_text(m0x - 10.0, m0y + 14.0, f"{vec('m', sub_text='0')}", fill="ink", size=12.2, anchor="end", halo=True)

    # Instant t* along front-right helical sweep (idx=40 -> m(t) ~75px bold arrow & open right-side label space)
    idx_star = 40
    m_star = ms_hel[idx_star]
    tangent_plane_patch(c, proj, m_star, half_size=0.33, fill="surface_subtle", fill_opacity=0.55, stroke="hairline")

    mt_x, mt_y = sphere_vector(c, proj, (0.0, 0.0, 0.0), m_star, color="m", width=2.7, size="md", tip_dot=True)
    # Place m(t) cleanly near midpoint below the radial arrow shaft
    c.math_text(0.5 * (ox + mt_x) + 12.0, 0.5 * (oy + mt_y) + 16.0, f"{vec('m')}(t)", fill="m", size=12.0, halo=True)

    # Exact orthogonal precession and damping vectors in T_m S^2
    mx, my, mz = m_star
    scale_v = 0.64
    pref = 1.0 / (1.0 + alpha * alpha)
    v_prec = (-pref * my * scale_v, pref * mx * scale_v, 0.0)
    v_damp = (
        -pref * alpha * mz * mx * scale_v,
        -pref * alpha * mz * my * scale_v,
        -pref * alpha * (mz * mz - 1.0) * scale_v,
    )
    v_tot = (v_prec[0] + v_damp[0], v_prec[1] + v_damp[1], v_prec[2] + v_damp[2])

    p_prec = (mx + v_prec[0], my + v_prec[1], mz + v_prec[2])
    p_damp = (mx + v_damp[0], my + v_damp[1], mz + v_damp[2])
    p_tot = (mx + v_tot[0], my + v_tot[1], mz + v_tot[2])

    pr_x, pr_y, _ = proj.project(*p_prec)
    dm_x, dm_y, _ = proj.project(*p_damp)
    tt_x, tt_y, _ = proj.project(*p_tot)
    c.line(pr_x, pr_y, tt_x, tt_y, stroke="hairline", stroke_width=0.95, dash="3,2.5")
    c.line(dm_x, dm_y, tt_x, tt_y, stroke="hairline", stroke_width=0.95, dash="3,2.5")

    sphere_vector(c, proj, m_star, p_prec, color="flux", width=2.2, size="sm")
    sphere_vector(c, proj, m_star, p_damp, color="accent_warm", width=2.2, size="sm")
    sphere_vector(c, proj, m_star, p_tot, color="m", width=2.3, size="sm")

    # Crisp non-overlapping labels (damping strictly left of z-axis with halo, resultant upper-right, precession lower-right)
    c.math_text(
        pr_x + 6.0,
        pr_y + 15.0,
        f"−γ{sub('eff')}({vec('m')}×{vec('H', sub_text='eff')}\u2009)",
        fill="flux",
        size=10.5,
        halo=True,
    )
    c.text(pr_x + 6.0, pr_y + 33.0, "precession", cls="fm-note", fill="flux", size=9.4, halo=True)

    # Keep damping label cleanly to the left of the vertical z-axis dashed line (x=226)
    damp_lx = min(dm_x - 10.0, ox - 8.0)
    c.math_text(
        damp_lx,
        dm_y - 3.0,
        f"−α γ{sub('eff')}{vec('m')}×({vec('m')}×{vec('H', sub_text='eff')}\u2009)",
        fill="accent_warm",
        size=10.2,
        anchor="end",
        halo=True,
    )
    c.text(damp_lx, dm_y - 18.0, "damping", cls="fm-note", fill="accent_warm", size=9.4, anchor="end", halo=True)
    # Delicate leader line connecting damping label to damping arrowhead when offset left of z-axis
    c.line(damp_lx + 3.0, dm_y - 6.0, dm_x - 5.0, dm_y - 2.0, stroke="accent_warm", stroke_width=0.8, opacity=0.75)

    c.math_text(
        tt_x + 7.0,
        tt_y - 6.0,
        f"∂{sub('t')}{vec('m')} ∈ T{sub('m')}S{sup('2')}",
        fill="m",
        size=11.3,
        halo=True,
    )

    legend_strip(
        c,
        18.0,
        468.0,
        [
            (f"Helical precession ({_ms('s' + sub('prec') + ' = 1')})", "flux", "solid"),
            (f"Geodesic damping ({_ms('s' + sub('prec') + ' = 0')}, llg_overdamped)", "accent_warm", "dashed"),
        ],
        horizontal=False,
        row_gap=18.0,
    )
    c.math_text(490.0, 468.0, f"γ{sub('eff')} = γ{sub('0')}/(1 + α{sup('2')})", fill="ink_secondary", size=11.0, anchor="end")
    c.math_text(
        490.0,
        488.0,
        f"{vec('m')} · ∂{sub('t')}{vec('m')} = 0  (‖{vec('m')}‖{sub('2')} = 1)",
        fill="ink_secondary",
        size=11.0,
        anchor="end",
    )

    # ---- Panel b: Monotonic Energy Decay & Relaxation Curves ----
    panel_label(
        c,
        522,
        24,
        "b",
        f"Energy dissipation ({_ms('dE/dt ≤ 0')}) &amp; relaxation",
        subtitle=f"From panel a RK4 trajectories ({_ms(vec('τ', sub_text='direct') + ' = ' + vec('0'))}, stationary {_ms(vec('H', sub_text='eff'))})",
        title_markup=True,
        subtitle_markup=True,
    )

    pf = axes_2d(
        c,
        572.0,
        58.0,
        362.0,
        156.0,
        xlim=(0.0, 18.0),
        ylim=(0.0, 1.05),
        xticks=[0, 4, 8, 12, 16],
        yticks=[0.0, 0.25, 0.5, 0.75, 1.0],
        ytick_labels=["0.00", "0.25", "0.50", "0.75", "1.00"],
        xlabel=f"{roman('Dimensionless time')}  t · γ{sub('0')}H{sub('eff')}",
        ylabel=f"{roman('Normalized value')}",
        grid=True,
        xlabel_offset=29.0,
        ylabel_offset=38.0,
    )

    mz0 = m0[2]
    e_norm = [(1.0 - m[2]) / (1.0 - mz0) for m in ms_hel]
    mz_hel = [m[2] for m in ms_hel]
    mz_geo = [m[2] for m in ms_geo]
    mx2_hel = [m[0] * m[0] for m in ms_hel]

    pf.plot_curve(ts_hel, e_norm, color="m", width=2.2)
    pf.plot_curve(ts_hel, mz_hel, color="flux", width=2.1)
    pf.plot_curve(ts_geo, mz_geo, color="accent_warm", width=1.9, dash="5.5,3")
    pf.plot_curve(ts_hel, mx2_hel, color="H", width=1.45, dash="2.2,2.2")

    legend_strip(
        c,
        742.0,
        106.0,
        [
            (f"{_ms('E(t)/E' + sub('0'))} = (1−{_ms('m' + sub('z'))})/(1−{_ms('m' + sub('z,0'))})", "m", "solid"),
            (f"{_ms('m' + sub('z') + '(t)')}  ({_ms('s' + sub('prec') + ' = 1')}, helical)", "flux", "solid"),
            (f"{_ms('m' + sub('z') + '(t)')}  ({_ms('s' + sub('prec') + ' = 0')}, geodesic)", "accent_warm", "dashed"),
            (f"{_ms('m' + sub('x') + '(t)' + sup('2'))}  (Larmor envelope)", "H", "dotted"),
        ],
        horizontal=False,
        row_gap=17.0,
        line_len=16.0,
    )

    # ---- Panel c: Discrete RK Radial Drift & Renormalization onto S^2 ----
    panel_label(
        c,
        522,
        296,
        "c",
        f"Discrete RK radial drift &amp; projection onto {_ms('S' + sup('2'))}",
        subtitle="Explicit stage renormalization & adaptive step guards",
        title_markup=True,
    )

    acx, acy, ar = 640.0, 628.0, 232.0
    ang_pts = np.linspace(math.radians(-118.0), math.radians(-62.0), 80)
    arc_pts = [(acx + ar * math.cos(a), acy + ar * math.sin(a)) for a in ang_pts]
    cap_pts = arc_pts + [(arc_pts[-1][0], 484.0), (arc_pts[0][0], 484.0)]
    c.polygon(cap_pts, fill="surface_subtle", fill_opacity=0.45)
    c.path(curve_path(arc_pts), stroke="sphere_stroke", stroke_width=2.0)

    c.math_text(526.0, 466.0, f"S{sup('2')}  (‖{vec('m')}‖{sub('2')} = 1)", fill="ink_muted", size=10.8)

    a_n = math.radians(-101.0)
    mn_x, mn_y = acx + ar * math.cos(a_n), acy + ar * math.sin(a_n)
    tx, ty = -math.sin(a_n), math.cos(a_n)
    step_len = 104.0
    mtilde_x, mtilde_y = mn_x + step_len * tx, mn_y + step_len * ty
    r_tilde = math.hypot(mtilde_x - acx, mtilde_y - acy)
    mn1_x = acx + ar * (mtilde_x - acx) / r_tilde
    mn1_y = acy + ar * (mtilde_y - acy) / r_tilde

    vector_arrow(c, mn_x, mn_y, mtilde_x, mtilde_y, color="flux", width=2.2, size="sm")
    vector_arrow(c, mtilde_x, mtilde_y, mn1_x, mn1_y, color="accent_violet", width=2.0, size="sm", dash="3.5,2.5")

    c.circle(mn_x, mn_y, 4.2, fill="ink", stroke="surface_ref", stroke_width=1.0)
    c.circle(mtilde_x, mtilde_y, 4.2, fill="err", stroke="surface_ref", stroke_width=1.0)
    c.circle(mn1_x, mn1_y, 4.2, fill="accent_violet", stroke="surface_ref", stroke_width=1.0)

    c.math_text(mn_x - 8.0, mn_y - 10.0, f"{vec('m', sub_text='n')}", fill="ink", size=12.0, anchor="end")
    c.math_text(
        mtilde_x - 8.0,
        mtilde_y - 27.0,
        f"{vec('m̃', sub_text='n+1')} = {vec('m', sub_text='n')} + Δt {vec('k', sub_text='RK')}",
        fill="err",
        size=11.0,
        anchor="middle",
        halo=True,
    )
    c.math_text(
        mtilde_x - 8.0,
        mtilde_y - 7.0,
        f"‖{vec('m̃', sub_text='n+1')}‖{sub('2')} = 1 + O(Δt{sup('p+1')})",
        fill="err",
        size=10.2,
        anchor="middle",
        halo=True,
    )
    c.math_text(
        mn1_x - 28.0,
        mn1_y + 23.0,
        f"{vec('m', sub_text='n+1')} = {vec('m̃', sub_text='n+1')}/‖{vec('m̃', sub_text='n+1')}‖{sub('2')}",
        fill="accent_violet",
        size=10.8,
        anchor="middle",
        halo=True,
    )

    c.line(780.0, 344.0, 780.0, 488.0, stroke="hairline", stroke_width=0.75, opacity=0.55)
    c.text(792.0, 356.0, "Stepper guards", cls="fm-label-bold", fill="accent_violet", size=10.8)
    guard_lines = [
        ("normalize_aos_field", "code"),
        (f"restores {_ms('‖' + vec('m', sub_text='i') + '‖' + sub('2') + ' = 1')} per stage", "note"),
        ("norm_tolerance", "code"),
        ("caps pre-projection drift", "note"),
        ("max_spin_rotation", "code"),
        ("caps per-step angle Δθ", "note"),
        (f"Vacuum ({_ms('M' + sub('s') + ' = 0')}): {_ms('∂' + sub('t') + vec('m') + ' = ' + vec('0'))}", "note"),
    ]
    gy = 376.0
    for txt, kind in guard_lines:
        if kind == "code":
            c.text(792.0, gy, txt, cls="fm-code", fill="accent_violet", size=9.8)
            gy += 14.0
        else:
            c.text(792.0, gy, txt, cls="fm-note", size=9.6, raw_markup="<tspan" in txt)
            gy += 19.0


# ---------------------------------------------------------------------------
# 5. effective-field-and-direct-torque-composition
# ---------------------------------------------------------------------------


def draw_effective_field_composition(c: SvgCanvas, t: Theme) -> None:
    """Variational effective-field path vs direct spin-torque path composing on T_m S^2."""
    panel_divider(c, 314, 14, 314, 446)
    panel_divider(c, 616, 14, 616, 446)

    # ---- Panel a: Conservative Variational Path -> H_eff (x=14..300) ----
    panel_label(
        c,
        14,
        22,
        "a",
        f"Variational path → {_ms(vec('H', sub_text='eff'))}",
        title_markup=True,
    )
    c.text(
        31,
        41.5,
        f"Energy functional {_ms('E[' + vec('m') + ']')} → {_ms(vec('H', sub_text='k'))} (A m{sup('−1')})",
        cls="fm-note",
        raw_markup=True,
    )

    # Step 1: Total energy functional
    _hairline_box(c, 16, 56, 282, 56, accent="H")
    c.text(28, 73, f"1. Energy functional  {_ms('E[' + vec('m') + '] = ∑' + sub('k') + ' E' + sub('k') + '[' + vec('m') + ']')}", cls="fm-label-bold", fill="H", size=10.6, raw_markup=True)
    c.text(28, 89, "Exchange · Demag · Zeeman · Anis · DMI · Mel", cls="fm-note", size=9.5)
    c.text(28, 103, f"Each term owns density {_ms('w' + sub('k'))}, sign &amp; natural BC", cls="fm-note", size=9.3, raw_markup=True)

    vector_arrow(c, 157, 112, 157, 134, color="H", width=1.55, size="sm")

    # Step 2: First variation
    _hairline_box(c, 16, 136, 282, 82, accent="H", fill="H_soft", stroke="H")
    c.text(28, 154, f"2. First variation on tangent {_ms(vec('η'))}  ({_ms(vec('m') + '·' + vec('η') + ' = 0')})", cls="fm-label-bold", fill="H", size=10.5, raw_markup=True)
    c.math_text(
        157,
        177,
        f"δE{sub('k')}[{vec('m')}; {vec('η')}] = −μ{sub('0')}∫{sub('Ωm')} M{sub('s')} {vec('H', sub_text='k')} · {vec('η')} dV",
        fill="ink",
        size=12.0,
        anchor="middle",
    )
    c.text(28, 197, "FDM: cell-center stencil / convolution", cls="fm-note", size=9.3)
    c.text(
        28,
        210,
        f"FEM: lumped-mass projection {_ms('−(μ' + sub('0') + 'M' + sub('s') + ')' + sup('−1') + 'M' + sub('lump') + sup('−1') + vec('r', sub_text='k'))}",
        cls="fm-note",
        size=9.2,
        raw_markup=True,
    )

    vector_arrow(c, 157, 218, 157, 240, color="H", width=1.55, size="sm")

    # Step 3: Accumulator
    _hairline_box(c, 16, 242, 282, 82, accent="H")
    c.text(
        28,
        260,
        f"3. Effective-field sum  (+ {_ms(vec('H', sub_text='oe') + ', ' + vec('H', sub_text='th'))})",
        cls="fm-label-bold",
        fill="H",
        size=10.5,
        raw_markup=True,
    )
    c.math_text(
        157,
        282,
        f"{vec('H', sub_text='eff')}({vec('x')}, t) = ∑{sub('k ∈ K')} {vec('H', sub_text='k')}({vec('x')}, t)   {roman('[A m')}{sup('−1')}{roman(']')}",
        fill="H",
        size=11.4,
        anchor="middle",
    )
    c.text(26, 301, "CPU: compute_effective_fields_for_magnetization", cls="fm-code", size=8.1)
    c.text(26, 315, "GPU: gpu_rk_accumulate_effective_field (fused)", cls="fm-code", size=8.1)

    vector_arrow(c, 157, 324, 157, 346, color="flux", width=1.55, size="sm")

    # Step 4: Field-driven LLG rate
    _hairline_box(c, 16, 348, 282, 62, accent="flux", fill="flux_soft", stroke="flux")
    c.text(28, 366, f"4. Field-driven LLG rate  (s{sup('−1')})", cls="fm-label-bold", fill="flux", size=10.6, raw_markup=True)
    c.math_text(
        157,
        391,
        f"(∂{sub('t')}{vec('m')})|{sub('LLG')} = −γ{sub('eff')}[s{sub('prec')}{vec('m')}×{vec('H', sub_text='eff')} + α{vec('m')}×({vec('m')}×{vec('H', sub_text='eff')})]",
        fill="ink",
        size=10.8,
        anchor="middle",
    )

    # ---- Panel b: Direct Torque Path -> tau_direct (x=330..602) ----
    panel_label(
        c,
        330,
        22,
        "b",
        f"Direct torque path → {_ms(vec('τ', sub_text='direct'))}",
        title_markup=True,
    )
    c.text(
        347,
        41.5,
        f"Current-driven RHS rates (s{sup('−1')}); never pseudo-fields",
        cls="fm-note",
        raw_markup=True,
    )

    # Step 1: Gilbert-form rates
    _hairline_box(c, 330, 56, 272, 122, accent="accent_warm", fill="accent_warm_soft", stroke="accent_warm")
    c.text(342, 72, f"1. Authored Gilbert-form rates {_ms(vec('T', sub_text='G'))}", cls="fm-label-bold", fill="accent_warm", size=10.6, raw_markup=True)
    tg_lines = [
        f"• Slonczewski: {_ms('Ω' + sub('DL') + vec('m') + '×(' + hat('p') + '×' + vec('m') + ') + Ω' + sub('FL') + vec('m') + '×' + hat('p'))}",
        f"• Zhang–Li: {_ms('−(' + vec('u') + '·∇)' + vec('m') + ' + β ' + vec('m') + '×[(' + vec('u') + '·∇)' + vec('m') + ']')}",
        f"• SOT: {_ms('Ω' + sub('DL') + vec('m') + '×(' + hat('σ') + '×' + vec('m') + ') + Ω' + sub('FL') + vec('m') + '×' + hat('σ'))}",
        f"• Drift–Diff: {_ms('−(γ' + sub('e') + '/M' + sub('s') + ')(ℏ/2e)(' + vec('R', sub_text='J') + '+' + vec('R', sub_text='φ') + ')')}",
    ]
    for idx, line in enumerate(tg_lines):
        c.text(340, 93 + idx * 18.5, line, cls="fm-sub", size=9.8, raw_markup=True)
    c.text(342, 169, f"Non-conservative: no scalar potential {_ms('E' + sub('torque'))}", cls="fm-note", fill="accent_warm", size=9.3, raw_markup=True)

    vector_arrow(c, 466, 178, 466, 202, color="accent_warm", width=1.55, size="sm")

    # Step 2: Single Gilbert -> explicit conversion
    _hairline_box(c, 330, 200, 272, 102, accent="accent_warm")
    c.text(342, 218, "2. Exact single Gilbert → explicit map", cls="fm-label-bold", fill="accent_warm", size=10.6)
    c.math_text(
        466,
        241,
        f"{vec('τ', sub_text='direct')} = ({vec('T', sub_text='G')} + α {vec('m')}×{vec('T', sub_text='G')}) / (1 + α{sup('2')})",
        fill="ink",
        size=11.8,
        anchor="middle",
    )
    c.text(342, 260, "Applied exactly once (never module + integrator)", cls="fm-note", size=9.3)
    c.math_text(
        466,
        277,
        f"C{sub('DL')} = Ω{sub('0')}(ξ{sub('DL')} − αξ{sub('FL')}) / (1 + α{sup('2')})",
        fill="ink_secondary",
        size=9.9,
        anchor="middle",
    )
    c.math_text(
        466,
        293,
        f"C{sub('FL')} = Ω{sub('0')}(ξ{sub('FL')} + αξ{sub('DL')}) / (1 + α{sup('2')})",
        fill="ink_secondary",
        size=9.9,
        anchor="middle",
    )

    # Visual anti-pseudo-field prohibition crossing between b and a's H_eff box
    c.line(330, 274, 300, 274, stroke="err", stroke_width=1.4, dash="3,2.5", marker_end=c.marker_url("err", size="sm"))
    c.circle(314, 274, 7.0, fill="surface_ref", stroke="err", stroke_width=1.1)
    c.line(310.5, 270.5, 317.5, 277.5, stroke="err", stroke_width=1.4)
    c.line(310.5, 277.5, 317.5, 270.5, stroke="err", stroke_width=1.4)
    c.text(334, 326, f"Never inject {_ms(vec('τ', sub_text='direct'))} as pseudo-{_ms(vec('H', sub_text='eff'))}", cls="fm-note", fill="err", size=9.4, raw_markup=True)

    vector_arrow(c, 540, 302, 540, 346, color="accent_warm", width=1.55, size="sm")

    # Step 3: Stage-active direct source
    _hairline_box(c, 330, 348, 272, 62, accent="accent_warm")
    c.text(342, 368, f"3. Stage-active source  {_ms(vec('τ', sub_text='direct'))}", cls="fm-label-bold", size=10.8, raw_markup=True)
    c.text(342, 386, "Additive RHS contribution on time-run stages", cls="fm-note", size=9.5)
    c.text(342, 399, "Bypassed in pure relaxation / minimization", cls="fm-note", size=9.5)

    # ---- Panel c: Geometric Tangent-Plane Composition (x=632..948) ----
    panel_label(
        c,
        632,
        22,
        "c",
        "Tangent-plane RHS composition",
    )
    c.text(
        649,
        41.5,
        f"Total {_ms('∂' + sub('t') + vec('m') + ' ∈ T' + sub('m') + 'S' + sup('2'))}  ({_ms(vec('m') + '·∂' + sub('t') + vec('m') + ' = 0')})",
        cls="fm-note",
        raw_markup=True,
    )

    # Sphere cap curve below tangent point P
    c.path("M 648 248 Q 760 184 912 246", stroke="sphere_stroke", stroke_width=1.5, dash="3.5,3")
    c.math_text(906, 260, f"S{sup('2')}", fill="ink_muted", size=11.5)

    # Tangent plane T_m S^2 parallelogram centered around P=(766, 174)
    plane_pts = [(664, 152), (836, 124), (912, 206), (740, 234)]
    c.polygon(plane_pts, fill="surface_subtle", fill_opacity=0.68, stroke="hairline", stroke_width=1.05, dash="4,3")
    c.math_text(896, 200, f"T{sub('m')}S{sup('2')}", fill="ink_muted", size=10.8, anchor="end")

    # Tangent point P and radial unit vector m rising from below
    ox, oy = 716.0, 266.0
    px, py = 766.0, 174.0
    c.circle(ox, oy, 2.8, fill="ink")
    vector_arrow(c, ox, oy, px, py, color="m", width=2.8, size="md")
    c.circle(px, py, 3.6, fill="m", stroke="surface_ref", stroke_width=1.0)
    c.math_text(754, 246, f"{vec('m')}  (‖{vec('m')}‖{sub('2')} = 1)", fill="m", size=11.8)

    # Subtle perpendicular symbol between m and tangent plane along v_llg direction
    # m direction (50, -92) unit ~(0.478, -0.878); v_llg direction (86, -14) unit ~(0.987, -0.161)
    # Build small right-angle square at P going back along -m by 10px and along +v_llg by 11px
    sq1 = (px - 4.8, py + 8.8)
    sq2 = (px - 4.8 + 10.8, py + 8.8 - 1.8)
    sq3 = (px + 10.8, py - 1.8)
    c.polyline([sq1, sq2, sq3], stroke="axis", stroke_width=0.95)

    # Vectors in T_m S^2 from P:
    # v_llg (teal flux) and v_tau (ochre accent_warm) and sum v_tot (bold ink)
    v_llg = (88.0, -14.0)
    v_tau = (-32.0, -68.0)
    v_tot = (v_llg[0] + v_tau[0], v_llg[1] + v_tau[1])

    e_llg = (px + v_llg[0], py + v_llg[1])
    e_tau = (px + v_tau[0], py + v_tau[1])
    e_tot = (px + v_tot[0], py + v_tot[1])

    # Parallelogram completion
    c.line(e_llg[0], e_llg[1], e_tot[0], e_tot[1], stroke="hairline", stroke_width=1.0, dash="3,2.5")
    c.line(e_tau[0], e_tau[1], e_tot[0], e_tot[1], stroke="hairline", stroke_width=1.0, dash="3,2.5")

    vector_arrow(c, px, py, e_llg[0], e_llg[1], color="flux", width=2.4, size="md")
    vector_arrow(c, px, py, e_tau[0], e_tau[1], color="accent_warm", width=2.4, size="md")
    vector_arrow(c, px, py, e_tot[0], e_tot[1], color="ink", width=2.7, size="md")

    c.math_text(e_llg[0] + 7.0, e_llg[1] + 5.0, f"(∂{sub('t')}{vec('m')})|{sub('LLG')}", fill="flux", size=11.2, halo=True)
    c.math_text(e_tau[0] - 8.0, e_tau[1] - 4.0, f"{vec('τ', sub_text='direct')}", fill="accent_warm", size=11.8, anchor="end", halo=True)
    c.math_text(e_tot[0] + 8.0, e_tot[1] - 4.0, f"(∂{sub('t')}{vec('m')})|{sub('total')}", fill="ink", size=12.0, bold=False, halo=True)

    # Bottom composition equations & consumers (clean hairline separation, zero box)
    c.line(634, 286, 944, 286, stroke="hairline", stroke_width=0.8, opacity=0.6)
    c.text(634, 308, f"Additive composition on {_ms('S' + sup('2'))}", cls="fm-label-bold", size=11.0, raw_markup=True)
    c.math_text(
        789,
        334,
        f"(∂{sub('t')}{vec('m')})|{sub('total')} = (∂{sub('t')}{vec('m')})|"
        f'<tspan baseline-shift="sub" font-size="74%" font-style="normal" font-weight="400">LLG('
        f'<tspan font-weight="700">H</tspan>'
        f'<tspan baseline-shift="sub" font-size="72%">eff</tspan>)</tspan>'
        f" + {vec('τ', sub_text='direct')}",
        fill="ink",
        size=12.0,
        anchor="middle",
    )
    c.math_text(
        789,
        358,
        f"{vec('m')} · (∂{sub('t')}{vec('m')})|{sub('total')} = 0   {roman('(exact orthogonality)')}",
        fill="ink_secondary",
        size=10.8,
        anchor="middle",
    )
    c.line(634, 374, 944, 374, stroke="grid", stroke_width=0.8)
    c.text(634, 393, "Native RHS consumers", cls="fm-label-bold", size=10.4)
    c.text(634, 411, "FEM CPU: llg_rhs_aos", cls="fm-code", size=9.6)
    c.text(634, 427, "FEM GPU: fullmag_cuda_llg_rhs_fused", cls="fm-code", size=9.6)

    # Clean feed lines connecting panels a & b into panel c's additive composition equation
    c.path(
        "M 157 410 L 157 438 L 624 438 L 624 328 L 638 328",
        stroke="flux",
        stroke_width=1.4,
        dash="4,2.5",
        marker_end=c.marker_url("flux", size="sm"),
    )
    c.path(
        "M 602 378 L 614 378 L 614 346 L 638 346",
        stroke="accent_warm",
        stroke_width=1.5,
        marker_end=c.marker_url("accent_warm", size="sm"),
    )


# ---------------------------------------------------------------------------
# 6. micromagnetic-boundary-conditions-overview
# ---------------------------------------------------------------------------


def draw_boundary_conditions(c: SvgCanvas, t: Theme) -> None:
    """Four-panel micromagnetic BC overview: Neumann, chiral DMI, periodic, airbox & elastic."""
    panel_divider(c, 480, 14, 480, 542)
    panel_divider(c, 14, 276, 946, 276)

    # ---- Panel a: Free-Surface Neumann (x=14..468, y=14..264) ----
    panel_label(
        c,
        14,
        24,
        "a",
        f"Free-surface Neumann ({_ms('A ∂' + sub('n') + vec('m') + ' = ' + vec('0'))})",
        subtitle=f"Zero exchange flux on {_ms('∂Ω' + sub('m'))}: natural FEM vs. FDM ghost clamp",
        title_markup=True,
        subtitle_markup=True,
    )

    # Ferromagnet domain + free boundary + phantom ghost column
    layer_slab(c, 22, 62, 160, 124, kind="fm", rx=2.0, stroke_width=1.3)
    c.math_text(30, 78, f"Ω{sub('m')} (A &gt; 0)", fill="fm_stroke", size=10.6)
    # Boundary line dOmega_m
    c.line(182, 59, 182, 189, stroke="H", stroke_width=2.6)
    c.math_text(188, 69, f"∂Ω{sub('m')}", fill="H", size=11.4)

    # Phantom FDM ghost cells immediately outside boundary
    c.rect(184, 78, 34, 96, fill="air_fill", fill_opacity=0.65, stroke="air_stroke", stroke_width=0.95, dash="3,2.5", rx=2.0)
    c.text(201, 184, "ghost", cls="fm-note", fill="air_stroke", anchor="middle", size=9.2)

    # Spins inside Omega_m gently varying in bulk, flattening smoothly to zero slope at boundary
    col_xs = [44.0, 82.0, 120.0, 158.0]
    col_angs = [58.0, 66.0, 72.0, 72.0]  # zero normal derivative at boundary
    for row_y in (96.0, 126.0, 156.0):
        for sx, ang in zip(col_xs, col_angs):
            spin_arrow(c, sx, row_y, ang, length=18.0, color="m", width=1.8, size="sm")
        # Clamped ghost spin matching edge spin
        spin_arrow(c, 201.0, row_y, 72.0, length=18.0, color="air_stroke", width=1.4, size="sm", opacity=0.72)

    # Outward normal n_hat
    vector_arrow(c, 182, 126, 236, 126, color="ink", width=1.7, size="sm")
    c.math_text(241, 130, hat("n"), fill="ink", size=12.0)

    c.math_text(118, 212, f"A(∇{vec('m')}){hat('n')} = {vec('0')}  {roman('→ zero normal slope')}", fill="H", size=10.8, anchor="middle")
    c.math_text(118, 232, f"{vec('m', sub_text='ghost')} = {vec('m', sub_text='edge')} {roman('(FDM)')}  |  {roman('natural (FEM)')}", fill="ink_secondary", size=10.3, anchor="middle")

    # Right concise breakdown (FEM vs FDM)
    c.line(260, 62, 464, 62, stroke="H", stroke_width=1.4)
    c.text(260, 79, "FEM: natural variational law", cls="fm-label-bold", fill="H", size=10.8)
    c.math_text(262, 99, f"δE{sub('ex')} = 2∫{sub('Ωm')} A ∇{vec('m')}:∇{vec('η')} dV", size=10.8)
    c.math_text(262, 118, f"∫{sub('∂Ωm')} A ∂{sub('n')}{vec('m')}·{vec('η')} dS = 0", fill="H", size=10.8)
    c.text(262, 135, f"Satisfied naturally in {_ms('H' + sup('1') + '(Ω' + sub('m') + ')')}", cls="fm-note", size=9.6, raw_markup=True)

    c.line(260, 158, 464, 158, stroke="flux", stroke_width=1.4)
    c.text(260, 175, "FDM: clamped ghost neighbor", cls="fm-label-bold", fill="flux", size=10.8)
    c.math_text(262, 195, f"j ∉ A  ⇒  {vec('m', sub_text='j')} ← {vec('m', sub_text='i')}", size=10.8)
    c.math_text(262, 214, f"({vec('m', sub_text='j')} − {vec('m', sub_text='i')})/Δx = {vec('0')}", fill="flux", size=10.8)
    c.text(262, 231, "Enforced in 6-neighbor Laplacian stencil", cls="fm-note", size=9.6)

    # ---- Panel b: Chiral DMI Boundary Canting (x=494..946, y=14..264) ----
    panel_label(
        c,
        494,
        24,
        "b",
        f"Chiral DMI boundary ({_ms('2A ∂' + sub('ν') + vec('m') + ' + D[(' + hat('n') + '×' + vec('ν') + ')×' + vec('m') + '] = ' + vec('0'))})",
        subtitle=f"Rohart–Thiaville edge canting: {_ms('ℓ' + sub('DMI') + ' = 2A/|D|')}, decay {_ms('Δ = √(A/K' + sub('eff') + ')')}",
        title_markup=True,
        subtitle_markup=True,
    )

    # Solve exact nonlinear 1D Rohart-Thiaville edge canting
    u_arr, theta_arr = _solve_rohart_thiaville_1d(length_over_delta=7.0, delta_over_ldmi=0.56, n_pts=121)
    mx_arr = np.sin(theta_arr)
    mz_arr = np.cos(theta_arr)

    # Top bilayer schematic (x=522..750, y=60..124) with n_hat cleanly on the left margin
    sx0, sw_dmi = 524.0, 226.0
    layer_slab(c, sx0, 60, sw_dmi, 46, kind="fm", stroke="accent_violet", stroke_width=1.35)
    layer_slab(c, sx0, 106, sw_dmi, 17, kind="hm", stroke_width=1.0)
    c.text(sx0 + 0.5 * sw_dmi, 118, f"Heavy metal (interface {_ms(hat('n') + ' = +' + hat('z'))})", cls="fm-note", fill="hm_stroke", anchor="middle", size=9.3, raw_markup=True)

    # Outward edge normal nu & interface normal n_hat (clear of spins)
    vector_arrow(c, sx0 + sw_dmi, 83, sx0 + sw_dmi + 22, 83, color="ink", width=1.6, size="sm")
    c.math_text(sx0 + sw_dmi + 26, 87, vec("ν"), fill="ink", size=11.6)
    vector_arrow(c, sx0 - 14, 106, sx0 - 14, 74, color="accent_violet", width=1.4, size="sm")
    c.math_text(sx0 - 14, 67, hat("n"), fill="accent_violet", size=10.6, anchor="middle")

    # 9 exact canted spin arrows sampled from nonlinear BVP solution
    for k in range(9):
        idx = int(round(k * (len(u_arr) - 1) / 8.0))
        sp_x = sx0 + 20.0 + k * (sw_dmi - 40.0) / 8.0
        ang_deg = 90.0 - math.degrees(float(theta_arr[idx]))
        spin_arrow(c, sp_x, 84.0, ang_deg, length=24.0, color="m", width=1.9, size="sm")

    # Exact canting profile plot below bilayer (x0=534, y0=144, w=218, h=86)
    pf_dmi = axes_2d(
        c,
        536.0,
        142.0,
        216.0,
        88.0,
        xlim=(-3.5, 3.5),
        ylim=(-0.7, 1.15),
        xticks=[-3.5, 0.0, 3.5],
        xtick_labels=["−L/2", "0", "+L/2"],
        yticks=[-0.5, 0.0, 0.5, 1.0],
        ytick_labels=["−0.5", "0", "0.5", "1.0"],
        xlabel=f"{roman('Width coordinate')}  x",
        zero_lines=True,
        xlabel_offset=26.0,
        ylabel_offset=30.0,
    )
    pf_dmi.plot_curve(u_arr.tolist(), mz_arr.tolist(), color="H", width=2.0)
    pf_dmi.plot_curve(u_arr.tolist(), mx_arr.tolist(), color="accent_violet", width=2.0)
    c.math_text(pf_dmi.px(-1.8), pf_dmi.py(0.76), f"m{sub('z')}(x)", fill="H", size=10.5, halo=True)
    c.math_text(pf_dmi.px(2.9), pf_dmi.py(-0.26), f"m{sub('x')}(x)", fill="accent_violet", size=10.5, anchor="end", halo=True)

    # Right DMI variant formulas (x=786..946)
    c.line(786, 60, 946, 60, stroke="accent_violet", stroke_width=1.4)
    c.text(786, 77, "DMI boundary variants", cls="fm-label-bold", fill="accent_violet", size=10.6)
    c.text(786, 98, "Interfacial (general n̂):", cls="fm-sub", size=9.8, weight=600)
    c.math_text(786, 116, f"2A∂{sub('ν')}{vec('m')} + D[({hat('n')}×{vec('ν')})×{vec('m')}] = {vec('0')}", fill="accent_violet", size=10.1)
    c.text(786, 141, "Bulk (isotropic):", cls="fm-sub", size=9.8, weight=600)
    c.math_text(786, 159, f"2A∂{sub('ν')}{vec('m')} + D({vec('m')}×{vec('ν')}) = {vec('0')}", fill="accent_violet", size=10.1)
    c.line(786, 174, 946, 174, stroke="grid", stroke_width=0.8)
    c.text(786, 192, "• FEM: carried by weak residual", cls="fm-note", size=9.5)
    c.text(786, 208, "  automatically (no penalty)", cls="fm-note", size=9.5)
    c.text(786, 226, "• FDM: stencil edge closure;", cls="fm-note", size=9.5)
    c.text(786, 242, "  Bulk DMI requires PBC", cls="fm-note", size=9.5)

    # ---- Panel c: Periodic BCs: FDM Wrapped vs FEM Reduced P^T A P (x=14..468, y=290..542) ----
    panel_label(
        c,
        14,
        298,
        "c",
        f"Periodic BCs: FDM wrapped vs. FEM {_ms('P' + sup('T') + ' A P')}",
        subtitle=f"{_ms(vec('m') + '(' + vec('r') + ' + L' + sub('d') + hat('e') + sub('d') + ') = ' + vec('m') + '(' + vec('r') + ')')}  via study.pbc(…)",
        title_markup=True,
        subtitle_markup=True,
    )

    # Left half: FDM wrapped 1D stencil chain
    c.text(20, 344, "FDM: wrapped neighbor_index", cls="fm-label-bold", fill="H", size=10.6)
    cell_labels = ["0", "1", "2", "…", "N−2", "N−1"]
    cx0, cy0, cell_s = 20.0, 360.0, 33.0
    for idx, lbl in enumerate(cell_labels):
        rx = cx0 + idx * cell_s
        is_end = idx in (0, len(cell_labels) - 1)
        c.rect(rx, cy0, cell_s, cell_s, fill="H_soft" if is_end else "node_fill", stroke="H", stroke_width=1.0)
        c.text(rx + 0.5 * cell_s, cy0 + 20.5, lbl, cls="fm-code", anchor="middle", size=9.8, fill="H" if is_end else "ink")

    # Curved wrap arrow connecting N-1 <-> 0
    x_first = cx0 + 0.5 * cell_s
    x_last = cx0 + (len(cell_labels) - 0.5) * cell_s
    curved_arrow(c, x_last, cy0 + cell_s + 4.0, 0.5 * (x_first + x_last), cy0 + cell_s + 44.0, x_first, cy0 + cell_s + 4.0, color="flux", width=1.6, size="sm", double=True)
    c.text(0.5 * (x_first + x_last), cy0 + cell_s + 36.0, f"wrap N−1 ↔ 0 across {_ms('L' + sub('d'))}", cls="fm-note", fill="flux", anchor="middle", size=9.5, raw_markup=True)

    c.text(20, 466, "• Exchange / DMI wrap across seam", cls="fm-sub", size=10.0)
    c.text(20, 484, "• Demag: replicated periodic images", cls="fm-sub", size=10.0)
    c.text(20, 502, "  (or open / multilayer policy)", cls="fm-note", size=9.5)

    panel_divider(c, 232, 338, 232, 526, dashed=True)

    # Right half: FEM reduced DOF elimination
    c.text(246, 344, f"FEM: reduced space {_ms('P' + sup('T') + ' A P')}", cls="fm-label-bold", fill="flux", size=10.6, raw_markup=True)
    mx0, my0, mw, mh = 250.0, 364.0, 96.0, 68.0
    c.rect(mx0, my0, mw, mh, fill="fm_fill", stroke="fm_stroke", stroke_width=1.15)
    # Interior mesh diagonals
    c.line(mx0, my0, mx0 + mw, my0 + mh, stroke="fm_stroke", stroke_width=0.75, opacity=0.7)
    c.line(mx0 + mw, my0, mx0, my0 + mh, stroke="fm_stroke", stroke_width=0.75, opacity=0.7)
    c.line(mx0 + 0.5 * mw, my0, mx0 + 0.5 * mw, my0 + mh, stroke="fm_stroke", stroke_width=0.75, opacity=0.7)
    c.line(mx0, my0 + 0.5 * mh, mx0 + mw, my0 + 0.5 * mh, stroke="fm_stroke", stroke_width=0.75, opacity=0.7)

    # Paired master/slave boundary nodes
    for ny_off in (0.0, 0.5 * mh, mh):
        c.circle(mx0, my0 + ny_off, 3.6, fill="flux", stroke="surface_ref", stroke_width=0.9)
        c.circle(mx0 + mw, my0 + ny_off, 3.6, fill="flux", stroke="surface_ref", stroke_width=0.9)
    curved_arrow(c, mx0 + mw, my0 - 4.0, mx0 + 0.5 * mw, my0 - 22.0, mx0, my0 - 4.0, color="flux", width=1.35, size="sm", dash="3,2")

    c.math_text(358, 380, f"{vec('u')} = P {vec('ũ')}", fill="flux", size=11.8)
    c.math_text(358, 402, f"(P{sup('T')} A P){vec('ũ')} = P{sup('T')}{vec('b')}", fill="ink", size=11.2)
    c.text(358, 422, "Lift back after solve", cls="fm-note", size=9.4)

    c.text(246, 466, "• Pairs master/slave seam DOFs", cls="fm-sub", size=10.0)
    c.text(246, 484, f"• FloquetBC: {_ms('e' + sup('i k_d L_d') if False else 'e' + sup('i kL'))} Bloch phase twist", cls="fm-sub", size=10.0, raw_markup=True)
    c.text(246, 502, "• Preserves ordering on CPU & GPU", cls="fm-sub", size=10.0)

    # ---- Panel d: Airbox Demag Closures & Mechanical BCs (x=494..946, y=290..542) ----
    panel_label(
        c,
        494,
        298,
        "d",
        "Airbox demag closures & mechanical BCs",
        subtitle=f"Outer marker {_ms('Γ' + sub('a'))} (Dirichlet vs. Robin) and ElasticBody displacement laws",
        subtitle_markup=True,
    )

    # Concentric Omega_m subset Omega_a schematic
    ax0, ay0, aw, ah = 504.0, 340.0, 198.0, 114.0
    c.rect(ax0, ay0, aw, ah, fill="air_fill", stroke="H", stroke_width=1.8, rx=3.0)
    c.rect(ax0 + 52.0, ay0 + 34.0, 94.0, 46.0, fill="fm_fill", stroke="fm_stroke", stroke_width=1.4, rx=2.0)
    c.math_text(ax0 + 99.0, ay0 + 61.0, f"Ω{sub('m')}", fill="fm_stroke", size=12.4, anchor="middle")
    c.math_text(ax0 + 8.0, ay0 + 16.0, f"Ω{sub('a')} {roman('(airbox)')}", fill="air_stroke", size=10.2)
    c.math_text(ax0 + aw - 8.0, ay0 + 16.0, f"Γ{sub('a')}", fill="H", size=11.0, anchor="end")

    # Radius R_star callout
    c.line(ax0 + 99.0, ay0 + 90.0, ax0 + 99.0, ay0 + 102.0, stroke="axis", stroke_width=0.9)
    vector_arrow(c, ax0 + 99.0, ay0 + 96.0, ax0 + aw - 3.0, ay0 + 96.0, color="axis", width=1.1, size="sm", dash="3,2")
    c.math_text(ax0 + 148.0, ay0 + 89.0, f"R{sub('★')}", fill="ink_secondary", size=10.6, anchor="middle")

    # Dirichlet & Robin specs (right side, clean hairline rules)
    c.line(718, 340, 946, 340, stroke="H", stroke_width=1.4)
    c.text(718, 357, f"1. Dirichlet:  {_ms('u = 0')}  on {_ms('Γ' + sub('a'))}", cls="fm-label-bold", fill="H", size=10.6, raw_markup=True)
    c.text(718, 374, f"Essential elimination; needs large {_ms('Ω' + sub('a'))}", cls="fm-note", size=9.6, raw_markup=True)
    c.text(718, 388, f"for {_ms('1/r' + sup('2'))} dipole-tail convergence", cls="fm-note", size=9.5, raw_markup=True)

    c.line(718, 404, 946, 404, stroke="accent_warm", stroke_width=1.4)
    c.text(718, 421, f"2. Robin:  {_ms('∂' + sub('n') + 'u + β u = 0')}  on {_ms('Γ' + sub('a'))}", cls="fm-label-bold", fill="accent_warm", size=10.6, raw_markup=True)
    c.math_text(718, 439, f"β = c / R{sub('★')}  {roman('adds boundary mass')}  β B{sub('Γa')}", fill="ink_secondary", size=10.2)
    c.text(718, 454, "Higher accuracy at compact airbox scales", cls="fm-note", fill="accent_warm", size=9.5)

    # Bottom Mechanical BCs strip (with minimalist engineering boundary icons!)
    c.line(504, 472, 946, 472, stroke="hairline", stroke_width=0.8, opacity=0.65)
    c.text(504, 491, "Mechanical displacement BCs (ElasticBody):", cls="fm-label-bold", size=10.5)

    # Icon 1: Free surface (traction-free)
    ix1, iy = 512.0, 514.0
    c.rect(ix1, iy - 10, 14, 20, fill="spacer_fill", stroke="spacer_stroke", stroke_width=1.0)
    c.line(ix1 + 14, iy - 12, ix1 + 14, iy + 12, stroke="flux", stroke_width=1.5, dash="2.5,2")
    c.text(ix1 + 22, iy - 1, "Traction-free", cls="fm-sub", size=9.8, weight=600)
    c.math_text(ix1 + 22, iy + 13, f"{vec('σ')} · {vec('n')} = {vec('0')}", fill="ink", size=10.8)

    # Icon 2: Clamped (hatched fixed wall)
    ix2 = 656.0
    c.rect(ix2, iy - 10, 14, 20, fill="spacer_fill", stroke="spacer_stroke", stroke_width=1.0)
    c.line(ix2, iy - 12, ix2, iy + 12, stroke="ink", stroke_width=1.8)
    for hy in (-9, -3, 3, 9):
        c.line(ix2 - 5, iy + hy + 3, ix2, iy + hy - 2, stroke="axis", stroke_width=0.9)
    c.text(ix2 + 22, iy - 1, "Clamped (fixed)", cls="fm-sub", size=9.8, weight=600)
    c.math_text(ix2 + 22, iy + 13, f"{vec('u')} = {vec('0')}", fill="ink", size=10.8)

    # Icon 3: Prescribed traction (edge force arrows)
    ix3 = 804.0
    c.rect(ix3, iy - 10, 14, 20, fill="spacer_fill", stroke="spacer_stroke", stroke_width=1.0)
    for fy in (-6, 0, 6):
        vector_arrow(c, ix3 + 15, iy + fy, ix3 + 27, iy + fy, color="m", width=1.1, size="sm")
    c.text(ix3 + 33, iy - 1, "Prescribed load", cls="fm-sub", size=9.8, weight=600)
    c.math_text(ix3 + 33, iy + 13, f"{vec('σ')} · {vec('n')} = {vec('t')}", fill="ink", size=10.8)


# ---------------------------------------------------------------------------
# 7. observables-materialization-pipeline
# ---------------------------------------------------------------------------


def draw_observables_pipeline(c: SvgCanvas, t: Theme) -> None:
    """Four-stage observables pipeline: accepted steps -> legality gate -> support reduction -> artifacts."""
    # Column headers & subtle accent underlines
    cols = [
        (12, 238, "a", "Accepted-step sampling", "Rejected RK trials emit zero rows", "flux"),
        (264, 496, "b", "Planner legality gate", "validate_executable_outputs", "accent_violet"),
        (522, 760, "c", "Support & reduction", f"Native fields &amp; airbox-free {_ms('w' + sub('i'))}", "H"),
        (786, 968, "d", "Artifacts & provenance", "OutputStorage (Zarr/HDF5/CSV)", "ok"),
    ]
    for x0, x1, letter, title, sub_txt, col in cols:
        c.line(x0, 12, x1, 12, stroke=col, stroke_width=1.5)
        panel_label(c, x0, 28, letter, title, subtitle=sub_txt, subtitle_markup="<tspan" in sub_txt)

    # Inter-stage flow arrows
    vector_arrow(c, 240, 230, 261, 230, color="axis", width=1.55, size="sm")
    vector_arrow(c, 498, 230, 519, 230, color="ok", width=1.55, size="sm")
    vector_arrow(c, 762, 230, 783, 230, color="ok", width=1.55, size="sm")

    # ---- Stage a: Accepted-Step Sampling (x=12..238) ----
    # Time axis graphic
    ay = 132.0
    vector_arrow(c, 22, ay, 226, ay, color="axis", width=1.4, size="sm")
    c.math_text(226, ay - 9, f"t {roman('(s)')}", fill="ink_secondary", size=10.5, anchor="end")

    acc_pts = [(36.0, "0"), (88.0, "1"), (174.0, "2"), (206.0, "3")]
    for px, idx_s in acc_pts:
        c.line(px, ay - 5, px, ay + 5, stroke="ok", stroke_width=1.8)
        c.circle(px, ay, 4.0, fill="ok", stroke="surface_ref", stroke_width=1.0)
        c.math_text(px, ay + 19, f"t{sub(idx_s)}", fill="ok", size=10.6, anchor="middle")

    # Rejected RK trial arc above axis
    rej_x = 144.0
    curved_arrow(c, 88.0, ay - 4.0, 116.0, ay - 46.0, rej_x, ay - 7.0, color="err", width=1.5, size="sm", dash="3.5,2.5")
    c.circle(rej_x, ay - 4.0, 5.2, fill="err_soft", stroke="err", stroke_width=1.2)
    c.line(rej_x - 2.6, ay - 6.6, rej_x + 2.6, ay - 1.4, stroke="err", stroke_width=1.3)
    c.line(rej_x - 2.6, ay - 1.4, rej_x + 2.6, ay - 6.6, stroke="err", stroke_width=1.3)
    c.text(122.0, 73.0, "Rejected RK trial (err > tol)", cls="fm-note", fill="err", anchor="middle", size=9.4)
    c.text(122.0, 86.0, "Discarded — no row emitted", cls="fm-note", fill="err", anchor="middle", size=9.2)

    # Accepted shrunk-dt arc below axis
    curved_arrow(c, 88.0, ay + 4.0, 131.0, ay + 52.0, 174.0, ay + 4.0, color="ok", width=1.5, size="sm")
    c.text(131.0, 186.0, "Shrunk Δt accepted → sample", cls="fm-note", fill="ok", anchor="middle", size=9.4)

    # Cadence contracts
    c.line(16, 206, 234, 206, stroke="hairline", stroke_width=0.75, opacity=0.6)
    c.text(16, 224, "Cadence contracts", cls="fm-label-bold", fill="flux", size=10.6)
    c.text(16, 243, "TableAutosave(steps | t_sampl)", cls="fm-code", size=9.1)
    c.text(16, 260, "FieldAutosave(qty, steps | every)", cls="fm-code", size=9.1)
    c.text(16, 277, "PlanarMonitor(target, frame, op)", cls="fm-code", size=9.1)
    c.text(16, 294, "Step vs. time cadence mutually exclusive", cls="fm-note", size=9.2)

    # Accepted state vector equation
    c.line(16, 314, 234, 314, stroke="hairline", stroke_width=0.75, opacity=0.6)
    c.text(16, 333, f"Accepted state {_ms(vec('m') + '(t' + sub('n') + ')')}", cls="fm-label-bold", size=10.6, raw_markup=True)
    c.math_text(16, 355, f"Q{sub('n')} = Q[ {vec('m')}(t{sub('n')}), G, M, P ]", fill="ink", size=11.4)
    c.text(16, 376, f"Evaluated after step acceptance on", cls="fm-note", size=9.6)
    c.text(16, 391, f"normalized spins ({_ms('‖' + vec('m', sub_text='i') + '‖' + sub('2') + ' = 1')}).", cls="fm-note", size=9.6, raw_markup=True)

    # ---- Stage b: Planner Legality Gate (x=264..496) ----
    c.text(266, 72, "Enabling-interaction prerequisites", cls="fm-label-bold", fill="accent_violet", size=10.4)
    prereqs = [
        ("m, mx, my, mz", "always available"),
        ("H_ex, E_ex", "requires Exchange()"),
        ("H_demag, E_demag", "requires Demag()"),
        ("H_ext, E_ext", "requires Zeeman()"),
        ("H_dmi, E_dmi", "requires DMI term"),
        ("H_mel / H_therm", "Mel / ThermalNoise"),
        ("H_eff, E_total", "≥ 1 active field/energy"),
    ]
    for idx, (qty, req) in enumerate(prereqs):
        ry = 92 + idx * 20
        if idx > 0:
            c.line(266, ry - 13, 494, ry - 13, stroke="grid", stroke_width=0.65)
        c.text(268, ry, qty, cls="fm-code", fill="ink", size=9.3)
        c.text(494, ry, req, cls="fm-note", anchor="end", size=9.2)

    # CapabilityMatrix check node
    _hairline_box(c, 266, 232, 228, 72, accent="accent_violet", fill="accent_violet_soft", stroke="accent_violet")
    c.text(278, 250, "Lane CapabilityMatrix Check", cls="fm-label-bold", fill="accent_violet", size=10.5)
    c.text(278, 267, "• Selected (FDM|FEM) × (CPU|GPU)", cls="fm-note", size=9.4)
    c.text(278, 281, "• Verifies materialization & precision", cls="fm-note", size=9.4)
    c.text(278, 295, "• Rejects unknown / duplicate names", cls="fm-note", size=9.4)

    # Fail-closed rejection gate
    vector_arrow(c, 380, 304, 380, 336, color="err", width=1.45, size="sm", dash="3.5,2.5")
    c.text(388, 323, "fail-closed", cls="fm-note", fill="err", size=9.3)
    _hairline_box(c, 266, 339, 228, 74, accent="err", fill="err_soft", stroke="err")
    c.text(380, 358, "Immediate Planner Error", cls="fm-label-bold", fill="err", anchor="middle", size=10.6)
    c.text(380, 375, "Missing term or unmaterializable lane", cls="fm-note", fill="err", anchor="middle", size=9.4)
    c.text(380, 391, "Never emits silent 0.0 substitution", cls="fm-label-bold", fill="err", anchor="middle", size=9.8)

    # ---- Stage c: Native Support & Volume-Weighted Reduction (x=522..760) ----
    _hairline_box(c, 524, 60, 234, 72, accent="H", fill="H_soft", stroke="H")
    c.text(536, 78, "Field Observables (native support)", cls="fm-label-bold", fill="H", size=10.4)
    c.text(536, 95, "• FDM: cell-centered Cartesian arrays", cls="fm-note", size=9.4)
    c.text(536, 109, "• FEM: nodal / vector DOF arrays", cls="fm-note", size=9.4)
    c.text(536, 123, "  context_copy_field_f64 (native)", cls="fm-code", fill="H", size=8.8)

    # Scalar reduction equations
    c.text(526, 155, "Volume-weighted scalar reductions", cls="fm-label-bold", fill="H", size=10.5)
    c.math_text(641, 180, f"Q{sub('scalar')} = ∑{sub('i ∈ Ωm')} w{sub('i')} q{sub('i')}", fill="ink", size=12.6, anchor="middle")
    c.math_text(641, 202, f"E{sub('total')}(t{sub('n')}) = ∑{sub('k ∈ K')} E{sub('k')}(t{sub('n')})", fill="ink_secondary", size=11.0, anchor="middle")
    c.text(641, 220, "QuantityRegistry::evaluate_by_name", cls="fm-code", fill="ink_muted", anchor="middle", size=9.1)

    # Domain support masking schematic (airbox excluded)
    c.line(524, 234, 758, 234, stroke="hairline", stroke_width=0.75, opacity=0.6)
    c.text(526, 252, "Domain support masking (airbox excluded)", cls="fm-label-bold", size=10.2)

    c.rect(528, 262, 226, 108, fill="air_fill", stroke="air_stroke", stroke_width=1.3, rx=3.0)
    c.rect(528, 262, 226, 108, fill=f"url(#{c._pid('hatch-muted')})", stroke="none", rx=3.0)
    c.math_text(
        536,
        279,
        f"Ω{sub('a')} ∖ Ω{sub('m')} {roman('(airbox):')} w{sub('i')} = 0  {roman('excluded')}",
        fill="air_stroke",
        size=10.0,
        halo=True,
    )
    c.rect(564, 294, 154, 58, fill="fm_fill", stroke="fm_stroke", stroke_width=1.5, rx=2.5)
    c.math_text(641, 317, f"Ω{sub('m')} {roman('(magnetic)')}", fill="fm_stroke", size=11.4, anchor="middle")
    c.math_text(641, 338, f"w{sub('i')} &gt; 0  {roman('included')}", fill="ok", size=10.4, anchor="middle")

    c.text(
        641,
        388,
        f"FDM: {_ms('w' + sub('i') + ' = ΔxΔyΔz')}  |  FEM: quadrature",
        cls="fm-note",
        anchor="middle",
        size=9.5,
        raw_markup=True,
    )
    c.text(
        641,
        404,
        f"Airbox scalar potential {_ms('u')} never enters {_ms('E' + sub('k'))}",
        cls="fm-note",
        anchor="middle",
        size=9.4,
        raw_markup=True,
    )

    # ---- Stage d: Artifacts & Provenance (x=786..968) ----
    artifacts = [
        (
            "1. Scalar Table",
            "accent_warm",
            "TableAutosave (CSV / Zarr)",
            f"{_ms('t, Δt, E' + sub('k') + ', ⟨' + vec('m') + '⟩, τ' + sub('max'))} · step",
        ),
        (
            "2. Spatial Fields",
            "H",
            "FieldAutosave · Monitor",
            f"Native {_ms(vec('m') + ', ' + vec('H', sub_text='eff') + ', ' + vec('H', sub_text='k') + ', u, ' + vec('J', sub_text='c'))}",
        ),
        (
            "3. Archive Store",
            "ok",
            "OutputStorage ('zarr')",
            "Stage layout & checkpoints",
        ),
        (
            "4. Run Provenance",
            "ink",
            "Run Receipt & fm.Result",
            "Engine, device ID, precision",
        ),
    ]
    for idx, (head, col, api, desc) in enumerate(artifacts):
        ay_box = 60 + idx * 91
        _hairline_box(c, 786, ay_box, 182, 79, accent=col)
        c.text(798, ay_box + 20, head, cls="fm-label-bold", fill=col, size=10.6)
        c.text(798, ay_box + 38, api, cls="fm-code", size=9.1)
        c.text(798, ay_box + 59, desc, cls="fm-note", size=9.3, raw_markup="<tspan" in desc)


# ---------------------------------------------------------------------------
# Public generator entry point
# ---------------------------------------------------------------------------


FOUNDATION_SPECS = (
    (
        "fullmag-object-interaction-architecture",
        draw_architecture,
        980,
        490,
        "Fullmag object, interaction, ProblemIR, and four-lane execution architecture",
        (
            "End-to-end Fullmag pipeline from fm.study authoring and scene objects "
            "(object_id, name, type, geometry AST, ObjectRegion, SI Material, m_0) and ordered stages, "
            "through explicit physics modules (field terms K_field -> H_k, direct torques tau_direct, "
            "coupled auxiliary PDEs, inter-region couplings Gamma_ab), into ProblemIR (requested intent), "
            "the fail-closed planner (fullmag-plan), ExecutionPlanIR, four independently qualified "
            "execution lanes (FDM CPU, FDM GPU, FEM CPU, FEM GPU), and materialized Zarr/binary outputs."
        ),
    ),
    (
        "geometry-regions-materials-realization",
        draw_geometry_realization,
        960,
        475,
        "CSG geometry, object-owned regions, spatial material fields, and FDM vs FEM realization",
        (
            "Three-panel comparison: (a) authored CSG Box minus Cylinder with an ObjectRegion core override, "
            "object vs world coordinate frames, boundary material_transition, and spatial MaterialParameterField profile; "
            "(b) FDM structured Cartesian cells with active mask A and region indices r_i; "
            "(c) FEM single shared conforming triangulation of Omega_m subset Omega_a with airbox markers Gamma_a "
            "and local core mesh grading."
        ),
    ),
    (
        "interactions-taxonomy-energy-vs-torque",
        draw_interactions_taxonomy,
        980,
        560,
        "Taxonomy of all 12 Fullmag physical interactions: conservative effective fields vs direct spin torques",
        (
            "Taxonomy of Fullmag's 12 physical interactions grouped by variational role and LLG entry channel: "
            "(a) local energy densities (Zeeman, Anisotropy, Magnetoelastic), (b) differential operators and "
            "natural boundary conditions (Exchange, DMI, Inter-region couplings), (c) nonlocal operators "
            "(Demagnetization, Oersted field), (d) stochastic thermal Brown noise H_th, and (e) non-conservative "
            "direct spin torques (Slonczewski/Zhang-Li STT, Prescribed SOT, Drift-diffusion spin torque) "
            "entering the explicit LLG right-hand side."
        ),
    ),
    (
        "llg-precession-damping-sphere",
        draw_llg_sphere,
        960,
        520,
        "Landau-Lifshitz-Gilbert dynamics on the unit sphere: precession, overdamped geodesic, and renormalization",
        (
            "Numerically integrated LLG dynamics (alpha = 0.28, H_eff along +z): (a) 3D orthographic projection "
            "on S^2 comparing exact RK4 helical damped precession (s_prec = 1) with pure-damping geodesic relaxation "
            "(s_prec = 0, llg_overdamped) and orthogonal torque vectors in T_m S^2; (b) monotonic energy dissipation "
            "E(t)/E_0, axial relaxation m_z(t), and Larmor oscillation envelope m_x(t)^2; (c) discrete Runge-Kutta "
            "O(dt^(p+1)) radial drift and radial renormalization back onto S^2."
        ),
    ),
    (
        "effective-field-and-direct-torque-composition",
        draw_effective_field_composition,
        960,
        460,
        "Variational effective-field derivation vs additive direct spin-torque composition on the LLG RHS",
        (
            "Three-panel diagram showing (a) conservative micromagnetic energy functionals E_k[m] producing "
            "field-form contributions H_k via first variation summed into H_eff, (b) non-conservative current-driven "
            "torques T_G converted exactly once into tau_direct without pseudo-field injection, and (c) geometric "
            "vector addition in the tangent plane T_m S^2 preserving m . dm/dt = 0."
        ),
    ),
    (
        "micromagnetic-boundary-conditions-overview",
        draw_boundary_conditions,
        960,
        555,
        "Overview of micromagnetic boundary conditions across magnetic, periodic, airbox, and mechanical domains",
        (
            "Four-panel boundary-condition summary: (a) free-surface Neumann A d_n m = 0 via FEM natural weak form "
            "and FDM clamped ghost cells; (b) Rohart-Thiaville chiral DMI boundary law 2A d_nu m + D[(n_hat x nu) x m] = 0 "
            "with exact numerically solved edge canting profile; (c) periodic BCs via FDM wrapped neighbor_index vs "
            "FEM reduced P^T A P DOF elimination; (d) FEM outer airbox Gamma_a closures (Dirichlet u = 0 vs asymptotic "
            "Robin d_n u + beta u = 0) and mechanical ElasticBody displacement constraints."
        ),
    ),
    (
        "observables-materialization-pipeline",
        draw_observables_pipeline,
        980,
        435,
        "Observables legality, accepted-step sampling, support-scoped volume reductions, and provenance",
        (
            "Four-stage observables pipeline: (a) accepted-step sampling discarding rejected adaptive RK trials; "
            "(b) fail-closed planner legality gate validate_executable_outputs rejecting missing prerequisites or "
            "unsupported lanes without silent zeros; (c) native FDM/FEM field support and volume-weighted scalar "
            "reductions Q_scalar = sum_{i in Omega_m} w_i q_i excluding FEM airbox elements; (d) provenance-complete "
            "Zarr, HDF5, and CSV artifacts."
        ),
    ),
)


def generate_all(out_dir: Path | str = DEFAULT_DIAGRAMS_DIR) -> list[tuple[Path, Path]]:
    """Generate all 7 foundational & architecture physics diagrams (14 SVGs: Light + Dark)."""
    generated: list[tuple[Path, Path]] = []
    for slug, draw_fn, width, height, title, desc in FOUNDATION_SPECS:
        pair = write_themed_svg(
            slug,
            draw_fn,
            width=width,
            height=height,
            title=title,
            desc=desc,
            out_dir=out_dir,
        )
        generated.append(pair)
    return generated


if __name__ == "__main__":
    pairs = generate_all()
    print(f"Generated {len(pairs)} foundational diagram pairs ({len(pairs) * 2} SVGs).")
