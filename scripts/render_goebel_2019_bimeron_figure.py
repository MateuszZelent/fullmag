"""Render the public Göbel 2019 bimeron validation figure from verified artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont


STATE_PATHS = (
    ("Initial state", "stages/stage_00_flat_relax/m_initial.json"),
    ("Relaxed · 20 ps", "stages/stage_00_flat_relax/m_final.json"),
    ("Held · 120 ps", "stages/stage_02_flat_run/m_final.json"),
)

COLOR_STOPS = np.asarray(
    [[30, 58, 138], [96, 165, 250], [248, 250, 252], [251, 113, 133], [153, 27, 27]],
    dtype=np.float64,
)


def _font(size: int, *, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    names = [
        "C:/Windows/Fonts/seguisb.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
        if bold
        else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for name in names:
        if Path(name).is_file():
            return ImageFont.truetype(name, size=size)
    return ImageFont.load_default()


def _load_state(path: Path) -> dict[str, object]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    layout = payload["layout"]
    nx, ny, nz = (int(value) for value in layout["grid_cells"])
    if nz != 1:
        raise ValueError(f"figure requires one z cell, got {nz} in {path}")
    values = np.asarray(payload["values"], dtype=np.float64)
    if values.shape != (nx * ny, 3):
        raise ValueError(f"unexpected magnetization shape {values.shape} in {path}")
    cell = np.asarray(layout["cell_size"], dtype=np.float64)
    origin = np.asarray(layout["origin_m"], dtype=np.float64)
    return {
        "m": values.reshape(ny, nx, 3),
        "extent_nm": np.array(
            [origin[0], origin[0] + nx * cell[0], origin[1], origin[1] + ny * cell[1]]
        )
        * 1.0e9,
        "cell_nm": cell[:2] * 1.0e9,
    }


def _core_indices(magnetization: np.ndarray) -> tuple[tuple[int, int], tuple[int, int]]:
    mz = magnetization[:, :, 2]
    return np.unravel_index(np.argmax(mz), mz.shape), np.unravel_index(np.argmin(mz), mz.shape)


def _core_center_nm(state: dict[str, object]) -> tuple[float, float]:
    magnetization = state["m"]
    extent = state["extent_nm"]
    cell = state["cell_nm"]
    assert isinstance(magnetization, np.ndarray)
    assert isinstance(extent, np.ndarray)
    assert isinstance(cell, np.ndarray)

    def position(index: tuple[int, int]) -> tuple[float, float]:
        row, column = index
        return extent[0] + (column + 0.5) * cell[0], extent[2] + (row + 0.5) * cell[1]

    high_xy, low_xy = (position(index) for index in _core_indices(magnetization))
    return 0.5 * (high_xy[0] + low_xy[0]), 0.5 * (high_xy[1] + low_xy[1])


def _colorize(mz: np.ndarray) -> Image.Image:
    scaled = np.clip((mz + 1.0) * 2.0, 0.0, 4.0)
    lower = np.minimum(np.floor(scaled).astype(np.int64), 3)
    fraction = (scaled - lower)[..., None]
    rgb = COLOR_STOPS[lower] * (1.0 - fraction) + COLOR_STOPS[lower + 1] * fraction
    return Image.fromarray(np.flipud(rgb.astype(np.uint8)), mode="RGB")


def _draw_arrow(draw: ImageDraw.ImageDraw, start: tuple[float, float], vector: tuple[float, float]) -> None:
    magnitude = math.hypot(*vector)
    if magnitude < 0.1:
        return
    ux, uy = vector[0] / magnitude, -vector[1] / magnitude
    end = start[0] + 17.0 * ux, start[1] + 17.0 * uy
    draw.line((start, end), fill=(15, 23, 42, 155), width=2)
    left = end[0] - 5 * ux + 3 * uy, end[1] - 5 * uy - 3 * ux
    right = end[0] - 5 * ux - 3 * uy, end[1] - 5 * uy + 3 * ux
    draw.polygon((end, left, right), fill=(15, 23, 42, 155))


def _draw_zoom_panel(
    canvas: Image.Image,
    draw: ImageDraw.ImageDraw,
    state: dict[str, object],
    title: str,
    box: tuple[int, int, int, int],
    *,
    arrows: bool,
) -> None:
    magnetization = state["m"]
    extent = state["extent_nm"]
    cell = state["cell_nm"]
    assert isinstance(magnetization, np.ndarray)
    assert isinstance(extent, np.ndarray)
    assert isinstance(cell, np.ndarray)
    left, top, right, bottom = box
    plot_left, plot_top, plot_right, plot_bottom = left + 68, top + 60, right - 18, bottom - 70
    center_x, _ = _core_center_nm(state)
    half_width = min(27.5, 0.5 * (extent[1] - extent[0]))
    x_min, x_max = center_x - half_width, center_x + half_width
    x_centers = extent[0] + (np.arange(magnetization.shape[1]) + 0.5) * cell[0]
    columns = np.flatnonzero((x_centers >= x_min) & (x_centers <= x_max))
    crop = magnetization[:, columns, :]
    image = _colorize(crop[:, :, 2]).resize(
        (plot_right - plot_left, plot_bottom - plot_top), Image.Resampling.BICUBIC
    )
    canvas.paste(image, (plot_left, plot_top))
    draw.rectangle((plot_left, plot_top, plot_right, plot_bottom), outline="#94a3b8", width=2)
    draw.text((left + 4, top), title, font=_font(31, bold=True), fill="#0f172a")
    draw.text(((plot_left + plot_right) // 2 - 42, plot_bottom + 27), "x (nm)", font=_font(21), fill="#334155")
    draw.text((left + 2, (plot_top + plot_bottom) // 2 - 10), "y", font=_font(21), fill="#334155")
    draw.text((plot_left - 25, plot_top - 8), f"{extent[3]:.0f}", font=_font(17), fill="#64748b")
    draw.text((plot_left - 32, plot_bottom - 14), f"{extent[2]:.0f}", font=_font(17), fill="#64748b")
    draw.text((plot_left - 10, plot_bottom + 2), f"{x_min:.0f}", font=_font(17), fill="#64748b")
    draw.text((plot_right - 25, plot_bottom + 2), f"{x_max:.0f}", font=_font(17), fill="#64748b")

    def to_pixel(row: int, column: int) -> tuple[float, float]:
        x_nm = extent[0] + (column + 0.5) * cell[0]
        y_nm = extent[2] + (row + 0.5) * cell[1]
        x = plot_left + (x_nm - x_min) / (x_max - x_min) * (plot_right - plot_left)
        y = plot_bottom - (y_nm - extent[2]) / (extent[3] - extent[2]) * (plot_bottom - plot_top)
        return x, y

    for index, marker in zip(_core_indices(magnetization), ("+", "−")):
        x, y = to_pixel(*index)
        draw.ellipse((x - 16, y - 16, x + 16, y + 16), outline="#0f172a", width=3)
        draw.text((x, y - 1), marker, font=_font(21, bold=True), fill="#0f172a", anchor="mm")

    if arrows:
        x_step = max(1, len(columns) // 18)
        y_step = max(1, magnetization.shape[0] // 13)
        for row in range(y_step // 2, magnetization.shape[0], y_step):
            for column in columns[x_step // 2 :: x_step]:
                _draw_arrow(draw, to_pixel(row, int(column)), tuple(magnetization[row, column, :2]))


def _draw_colorbar(canvas: Image.Image, draw: ImageDraw.ImageDraw) -> None:
    bar = _colorize(np.linspace(-1.0, 1.0, 500)[:, None]).resize((32, 560), Image.Resampling.BILINEAR)
    canvas.paste(bar, (2915, 330))
    draw.rectangle((2915, 330, 2947, 890), outline="#64748b", width=2)
    draw.text((2955, 320), "+1", font=_font(18), fill="#475569")
    draw.text((2955, 600), "0", font=_font(18), fill="#475569")
    draw.text((2955, 870), "−1", font=_font(18), fill="#475569")
    draw.text((2895, 920), "m_z", font=_font(21), fill="#334155")


def render_figure(bundle: Path, verification_report: Path, output: Path) -> None:
    report = json.loads(verification_report.read_text(encoding="utf-8"))
    if report.get("status") != "passed":
        raise ValueError("figure generation requires a passed verification report")
    expected_hashes = report.get("verified_state_sha256")
    if not isinstance(expected_hashes, dict):
        raise ValueError("verification report does not bind the rendered state files")
    hash_keys = ("initial", "relaxed", "held")
    states = []
    for (title, relative), hash_key in zip(STATE_PATHS, hash_keys):
        state_path = bundle / relative
        actual_hash = hashlib.sha256(state_path.read_bytes()).hexdigest()
        if expected_hashes.get(hash_key) != actual_hash:
            raise ValueError(f"verification report state hash mismatch for {relative}")
        states.append((title, _load_state(state_path)))

    canvas = Image.new("RGB", (3000, 1700), "#f8fafc")
    draw = ImageDraw.Draw(canvas, "RGBA")
    draw.text((105, 58), "Göbel 2019 bimeron stabilization", font=_font(54, bold=True), fill="#0f172a")
    draw.text((105, 125), "rotated interfacial DMI · strict CUDA FDM FP64", font=_font(29), fill="#475569")
    draw.rounded_rectangle((2230, 62, 2865, 150), radius=22, fill="#dcfce7", outline="#86efac", width=2)
    passed = sum(bool(value) for value in report.get("checks", {}).values())
    total = len(report.get("checks", {}))
    draw.text((2290, 86), f"VERIFIED  {passed}/{total} gates", font=_font(28, bold=True), fill="#166534")

    panel_boxes = ((70, 235, 990, 1060), (1010, 235, 1930, 1060), (1950, 235, 2870, 1060))
    for (title, state), box in zip(states, panel_boxes):
        _draw_zoom_panel(canvas, draw, state, title, box, arrows=title.startswith("Held"))
    _draw_colorbar(canvas, draw)

    held_state = states[-1][1]
    held_m = held_state["m"]
    assert isinstance(held_m, np.ndarray)
    track = _colorize(held_m[:, :, 2]).resize((1840, 275), Image.Resampling.BICUBIC)
    canvas.paste(track, (105, 1240))
    draw.rectangle((105, 1240, 1945, 1515), outline="#94a3b8", width=2)
    draw.text((105, 1168), "Held state · full 500 nm periodic track", font=_font(30, bold=True), fill="#0f172a")
    draw.text((970, 1535), "x (nm)", font=_font(22), fill="#334155")
    draw.text((90, 1535), "−250", font=_font(18), fill="#64748b")
    draw.text((1895, 1535), "+250", font=_font(18), fill="#64748b")

    execution = report["execution"]
    metrics = [
        ("TOPOLOGICAL CHARGE", f"{report['initial']['topological_charge']:+.6f}  →  {report['held']['topological_charge']:+.6f}"),
        ("CORE SEPARATION", f"{report['held']['core_separation_m'] * 1e9:.2f} nm"),
        ("BACKGROUND", f"mean m_x = {report['held']['mean_mx']:.7f}"),
        ("TOTAL ENERGY", f"{report['initial_energy_j']:.4e}  →  {report['held_energy_j']:.4e} J"),
        ("EXECUTION", f"{execution['engine']} · FP64 · fallback {execution['fallback_count']}"),
        ("DEVICE OPERATORS", f"{execution['executed_device_operator_mask']}/{execution['required_operator_mask']}"),
    ]
    draw.rounded_rectangle((2040, 1168, 2870, 1600), radius=24, fill="white", outline="#cbd5e1", width=2)
    y = 1200
    for label, value in metrics:
        draw.text((2090, y), label, font=_font(17, bold=True), fill="#64748b")
        draw.text((2400, y - 2), value, font=_font(20), fill="#0f172a")
        y += 62

    draw.text(
        (105, 1632),
        "500 × 40 × 0.5 nm³ · D = 3 mJ m⁻² · 20 ps relaxation + 100 ps zero-current hold · color: m_z · arrows: in-plane m",
        font=_font(21),
        fill="#475569",
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output, format="PNG", optimize=True, dpi=(200, 200))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    parser.add_argument("--verification-report", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    render_figure(args.bundle, args.verification_report, args.output)
    print(args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
