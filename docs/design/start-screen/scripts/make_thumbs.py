"""Generate realistic simulation-result thumbnails for the Fullmag start screen mockup.

Palette follows the repo theme (Catppuccin Mocha viewport: #11111b).
Magnetisation maps use the HSL-sphere convention already used in Fullmag:
in-plane angle -> hue, out-of-plane component -> lightness.
"""
from __future__ import annotations

import colorsys
import pathlib

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.colors import LinearSegmentedColormap

OUT = pathlib.Path(__file__).resolve().parents[1] / "mockups" / "assets" / "thumbs"
OUT.mkdir(parents=True, exist_ok=True)

VIEWPORT = "#11111b"
TEXT = "#cdd6f4"
MUTED = "#6c7086"
GRID = "#313244"
ACCENT = "#89b4fa"
MAUVE = "#cba6f7"
GREEN = "#a6e3a1"
PEACH = "#fab387"
RED = "#f38ba8"
TEAL = "#94e2d5"
YELLOW = "#f9e2af"

W, H, DPI = 4.8, 3.0, 100  # -> 480x300 px


def fig():
    f = plt.figure(figsize=(W, H), dpi=DPI, facecolor=VIEWPORT)
    ax = f.add_axes((0, 0, 1, 1))
    ax.set_facecolor(VIEWPORT)
    ax.set_xticks([])
    ax.set_yticks([])
    for s in ax.spines.values():
        s.set_visible(False)
    return f, ax


def save(f, name):
    f.savefig(OUT / f"{name}.png", dpi=DPI, facecolor=VIEWPORT)
    plt.close(f)
    print("wrote", name)


def hsl_rgb(mx, my, mz):
    """HSL-sphere colouring: hue = in-plane angle, lightness = m_z."""
    hue = (np.arctan2(my, mx) / (2 * np.pi)) % 1.0
    light = 0.5 * (mz + 1.0)
    light = 0.12 + 0.76 * light
    sat = np.sqrt(np.clip(mx**2 + my**2, 0, 1)) ** 0.75
    out = np.zeros(hue.shape + (3,))
    it = np.nditer(hue, flags=["multi_index"])
    for _ in it:
        i = it.multi_index
        out[i] = colorsys.hls_to_rgb(float(hue[i]), float(light[i]), float(sat[i]))
    return out


# --------------------------------------------------------------------------
# 1. Spin-wave dispersion of a YIG waveguide (omega-k map with mode branches)
# --------------------------------------------------------------------------
def dispersion():
    f, ax = fig()
    k = np.linspace(-22, 22, 420)
    fq = np.linspace(0, 16, 300)
    K, F = np.meshgrid(k, fq)
    img = np.zeros_like(K)
    for n, amp in zip((1, 2, 3, 4, 5), (1.0, 0.62, 0.40, 0.26, 0.16)):
        kt = np.sqrt(K**2 + (n * 1.55) ** 2)
        branch = 2.4 + np.sqrt(np.clip(kt, 0, None) * 0.62 + (n * 1.55) ** 2 * 0.045) * 1.52
        img += amp * np.exp(-((F - branch) ** 2) / (2 * 0.085**2))
    img += 0.035 * np.random.default_rng(3).random(img.shape)
    cmap = LinearSegmentedColormap.from_list(
        "fmviridis", [VIEWPORT, "#1e2a4a", "#2d5bb9", ACCENT, "#bcd6ff", "#f2f6ff"]
    )
    ax.imshow(
        img, origin="lower", aspect="auto", cmap=cmap,
        extent=(k[0], k[-1], fq[0], fq[-1]), vmin=0, vmax=0.95,
    )
    ax.set_xlim(k[0], k[-1])
    ax.set_ylim(0, 16)
    ax.text(0.03, 0.93, r"$f$ (GHz)", color=MUTED, fontsize=7.5, transform=ax.transAxes)
    ax.text(0.90, 0.045, r"$k_x$ (rad/µm)", color=MUTED, fontsize=7.5,
            transform=ax.transAxes, ha="right")
    save(f, "dispersion-yig")


# --------------------------------------------------------------------------
# 2. Skyrmion lattice (HSL-sphere colouring)
# --------------------------------------------------------------------------
def skyrmions():
    f, ax = fig()
    n = 260
    x = np.linspace(-3.2, 3.2, int(n * W / H))
    y = np.linspace(-2.0, 2.0, n)
    X, Y = np.meshgrid(x, y)
    mx = np.zeros_like(X); my = np.zeros_like(X); mz = np.ones_like(X)
    a = 1.12
    centres = [(i * a, j * a * 0.866 + (i % 2) * a * 0.5)
               for i in range(-4, 5) for j in range(-4, 5)]
    for cx, cy in centres:
        r = np.hypot(X - cx, Y - cy)
        phi = np.arctan2(Y - cy, X - cx)
        theta = np.pi * np.exp(-((r / 0.30) ** 3.0))
        w = np.exp(-((r / 0.52) ** 6))
        mx = mx * (1 - w) + w * (np.sin(theta) * np.cos(phi + np.pi / 2))
        my = my * (1 - w) + w * (np.sin(theta) * np.sin(phi + np.pi / 2))
        mz = mz * (1 - w) + w * np.cos(theta)
    norm = np.sqrt(mx**2 + my**2 + mz**2) + 1e-9
    ax.imshow(hsl_rgb(mx / norm, my / norm, mz / norm), origin="lower",
              aspect="auto", extent=(x[0], x[-1], y[0], y[-1]))
    save(f, "skyrmion-lattice")


# --------------------------------------------------------------------------
# 3. Magnonic crystal band structure with band gaps
# --------------------------------------------------------------------------
def bands():
    f, ax = fig()
    ax.set_position((0.115, 0.13, 0.86, 0.82))
    ax.set_facecolor(VIEWPORT)
    k = np.linspace(0, 3, 600)
    kf = np.abs(((k + 0.5) % 1.0) - 0.5) * 2.0
    f0 = 2.6
    edges = []
    for n in range(5):
        base = f0 + (n + kf) * 2.05
        gap = 0.0 if n == 0 else 0.34 + 0.08 * n
        lo = base - gap / 2 * np.cos(np.pi * kf) ** 2
        c = ACCENT if n % 2 == 0 else MAUVE
        ax.plot(k, lo, color=c, lw=1.7)
        if n:
            edges.append((float(lo.max()), float(lo.max()) + gap))
    for lo, hi in edges:
        ax.axhspan(lo, hi, color=PEACH, alpha=0.18, lw=0)
    for b in (1.0, 2.0):
        ax.axvline(b, color=GRID, lw=0.6, ls=(0, (3, 3)))
    ax.set_xlim(0, 3)
    ax.set_ylim(2.2, 13.0)
    ax.grid(True, axis="y", color=GRID, lw=0.5, alpha=0.5)
    ax.tick_params(colors=MUTED, labelsize=7, length=2)
    ax.set_xticks([0, 1, 2, 3])
    ax.set_xticklabels(["0", "1", "2", "3"], color=MUTED, fontsize=7)
    for sp in ax.spines.values():
        sp.set_color(GRID)
    ax.set_ylabel("f (GHz)", color=MUTED, fontsize=7.5, labelpad=2)
    ax.set_xlabel("k a / " + chr(960), color=MUTED, fontsize=7.5, labelpad=1)
    save(f, "magnonic-crystal")


# --------------------------------------------------------------------------
# 4. muMAG standard problem #4 — switching traces
# --------------------------------------------------------------------------
def sp4():
    f, ax = fig()
    ax.set_position((0.1, 0.12, 0.87, 0.83))
    ax.set_facecolor(VIEWPORT)
    t = np.linspace(0, 1.0, 900)
    env = np.exp(-t * 4.1)
    mx = np.tanh((t - 0.14) * 11) * (1 - 0.30 * env * np.cos(28 * t))
    mx = -1 + 2 * (mx + 1) / 2
    my = 0.72 * np.exp(-t * 3.2) * np.sin(30 * t + 0.6)
    mz = 0.30 * np.exp(-t * 3.6) * np.sin(34 * t)
    for v, c, lbl in ((mx, ACCENT, r"$m_x$"), (my, GREEN, r"$m_y$"), (mz, PEACH, r"$m_z$")):
        ax.plot(t, v, color=c, lw=1.5, label=lbl)
    ax.axhline(0, color=GRID, lw=0.7)
    ax.set_xlim(0, 1)
    ax.set_ylim(-1.15, 1.15)
    ax.grid(True, color=GRID, lw=0.5, alpha=0.55)
    ax.tick_params(colors=MUTED, labelsize=7, length=2)
    for s in ax.spines.values():
        s.set_color(GRID)
    ax.set_xlabel("t (ns)", color=MUTED, fontsize=7.5, labelpad=1)
    leg = ax.legend(loc="upper right", fontsize=7, frameon=False, ncols=3,
                    handlelength=1.1, columnspacing=1.0)
    for txt in leg.get_texts():
        txt.set_color(TEXT)
    save(f, "umag-sp4")


# --------------------------------------------------------------------------
# 5. Broadband FMR absorption map f(H)
# --------------------------------------------------------------------------
def fmr():
    f, ax = fig()
    Hf = np.linspace(0, 160, 480)
    fr = np.linspace(0, 22, 340)
    HH, FF = np.meshgrid(Hf, fr)
    img = np.zeros_like(HH)
    gamma = 0.0352
    for amp, wid, off in ((1.0, 0.36, 0.0), (0.46, 0.44, 2.9), (0.26, 0.52, 5.2)):
        res = gamma * np.sqrt(np.clip(HH * (HH + 1100.0), 0, None)) + off
        img += amp * np.exp(-((FF - res) ** 2) / (2 * wid ** 2))
    cmap = LinearSegmentedColormap.from_list(
        "fminferno", [VIEWPORT, "#2a1b3d", "#7b2d6b", RED, PEACH, "#ffe9c9"]
    )
    ax.imshow(img, origin="lower", aspect="auto", cmap=cmap,
              extent=(0, 160, 0, 22), vmin=0, vmax=1.0)
    ax.text(0.03, 0.92, "f (GHz)", color=MUTED, fontsize=7.5, transform=ax.transAxes)
    ax.text(0.97, 0.05, "mu0 H (mT)", color=MUTED, fontsize=7.5,
            transform=ax.transAxes, ha="right")
    save(f, "fmr-spectrum")


# --------------------------------------------------------------------------
# 6. Domain-wall motion in a nanostrip (HSL map + wall position)
# --------------------------------------------------------------------------
def domain_wall():
    f, ax = fig()
    nx, ny = 480, 300
    x = np.linspace(-6, 6, nx)
    y = np.linspace(-1.6, 1.6, ny)
    X, Y = np.meshgrid(x, y)
    walls = [(-2.6, 1.0), (0.4, -1.0), (3.4, 1.0)]
    mz = np.full_like(X, -1.0)
    phi = np.zeros_like(X)
    for pos, sgn in walls:
        mz = mz + sgn * (1 + np.tanh((X - pos) / 0.34))
        phi = phi + np.pi * 0.5 * np.exp(-((X - pos) / 0.46) ** 2) * sgn
    mz = np.clip(mz, -1, 1)
    theta = np.arccos(np.clip(mz, -1, 1))
    mx = np.sin(theta) * np.cos(phi + np.pi / 2)
    my = np.sin(theta) * np.sin(phi + np.pi / 2)
    rgb = hsl_rgb(mx, my, np.cos(theta))
    edge = np.abs(Y) > 1.08
    rgb[edge] = np.array([0.067, 0.067, 0.107])
    ax.imshow(rgb, origin="lower", aspect="auto", extent=(x[0], x[-1], y[0], y[-1]))
    for pos, _ in walls:
        ax.annotate("", xy=(pos + 0.8, 1.34), xytext=(pos, 1.34),
                    arrowprops=dict(arrowstyle="-|>", color=YELLOW, lw=1.2))
    ax.text(0.035, 0.06, "v = 148 m/s", color=YELLOW, fontsize=7.5,
            transform=ax.transAxes)
    ax.set_ylim(-1.6, 1.6)
    save(f, "domain-wall")


# --------------------------------------------------------------------------
# 7. Spin-wave beam / caustics emitted from an antenna (field map)
# --------------------------------------------------------------------------
def caustics():
    f, ax = fig()
    nx, ny = 460, 290
    x = np.linspace(0, 9, nx)
    y = np.linspace(-3, 3, ny)
    X, Y = np.meshgrid(x, y)
    field = np.zeros_like(X)
    rng = np.random.default_rng(11)
    for ang in np.linspace(-0.62, 0.62, 13):
        kx, ky = np.cos(ang) * 13.5, np.sin(ang) * 13.5
        w = np.exp(-((ang / 0.42) ** 2))
        field += w * np.cos(kx * X + ky * Y) * np.exp(-0.14 * X)
    field += 0.04 * rng.standard_normal(field.shape)
    cmap = LinearSegmentedColormap.from_list(
        "fmdiv", ["#1d4f73", "#2b7fa8", VIEWPORT, "#a8527f", RED]
    )
    ax.imshow(field, origin="lower", aspect="auto", cmap=cmap,
              extent=(0, 9, -3, 3), vmin=-3.2, vmax=3.2)
    ax.add_patch(plt.Rectangle((0.08, -1.0), 0.16, 2.0, color=YELLOW, alpha=0.9))
    ax.text(0.055, 0.90, "antenna", color=YELLOW, fontsize=7, transform=ax.transAxes)
    save(f, "spinwave-beam")


# --------------------------------------------------------------------------
# 8. Vortex core in a disc (HSL map)
# --------------------------------------------------------------------------
def vortex():
    f, ax = fig()
    n = 300
    x = np.linspace(-1.3, 1.3, int(n * W / H))
    y = np.linspace(-1.0, 1.0, n)
    X, Y = np.meshgrid(x, y)
    R = np.hypot(X, Y)
    phi = np.arctan2(Y, X)
    theta = np.pi / 2 * (1 - np.exp(-((R / 0.135) ** 2)))
    mx = np.sin(theta) * np.cos(phi + np.pi / 2)
    my = np.sin(theta) * np.sin(phi + np.pi / 2)
    mz = np.cos(theta)
    rgb = hsl_rgb(mx, my, mz)
    rgb[R > 0.93] = np.array([0.067, 0.067, 0.107])
    ax.imshow(rgb, origin="lower", aspect="auto", extent=(x[0], x[-1], y[0], y[-1]))
    save(f, "vortex-core")


# --------------------------------------------------------------------------
# 9. FEM tetrahedral mesh wireframe on a curved body
# --------------------------------------------------------------------------
def mesh():
    f, ax = fig()
    rng = np.random.default_rng(7)
    import matplotlib.tri as mtri
    n = 240
    r = np.sqrt(rng.random(n)) * 1.0
    th = rng.random(n) * 2 * np.pi
    px, py = r * np.cos(th) * 1.55, r * np.sin(th)
    px = np.append(px, 1.55 * np.cos(np.linspace(0, 2 * np.pi, 60)))
    py = np.append(py, 1.0 * np.sin(np.linspace(0, 2 * np.pi, 60)))
    tri = mtri.Triangulation(px, py)
    z = np.exp(-((px / 1.1) ** 2 + (py / 0.7) ** 2)) + 0.2 * np.sin(3 * px)
    cmap = LinearSegmentedColormap.from_list("fmmesh", ["#1b2b4a", "#2d5bb9", ACCENT, "#cfe0ff"])
    ax.tripcolor(tri, z, cmap=cmap, shading="gouraud", alpha=0.92)
    ax.triplot(tri, color="#11111b", lw=0.35, alpha=0.75)
    ax.set_xlim(-1.75, 1.75)
    ax.set_ylim(-1.1, 1.1)
    save(f, "fem-mesh")


if __name__ == "__main__":
    dispersion()
    skyrmions()
    bands()
    sp4()
    fmr()
    domain_wall()
    caustics()
    vortex()
    mesh()
